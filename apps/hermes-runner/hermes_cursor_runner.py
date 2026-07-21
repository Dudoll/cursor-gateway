#!/usr/bin/env python3
"""Host-local Cursor Gateway worker backed by the Hermes CLI."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
PENDING_RESULT = Path(
    os.environ.get(
        "CURSOR_GATEWAY_HERMES_PENDING_RESULT",
        HERMES_HOME / "cursor_runner_pending_result.json",
    )
)


def load_dotenv() -> None:
    path = HERMES_HOME / ".env"
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_dotenv()

BASE_URL = os.environ.get(
    "CURSOR_GATEWAY_INTERNAL_URL", "http://127.0.0.1:18080"
).rstrip("/")
SECRET = os.environ.get("CURSOR_GATEWAY_HERMES_RUNNER_SECRET", "")
MODEL_ID = os.environ.get("CURSOR_GATEWAY_HERMES_MODEL_ID", "hermes:default")
MODEL_NAME = os.environ.get(
    "CURSOR_GATEWAY_HERMES_MODEL_NAME", "Hermes (default)"
)
RUNNER_ID = os.environ.get("CURSOR_GATEWAY_HERMES_RUNNER_ID", "hermes-local")
HERMES_BIN = os.environ.get("HERMES_BIN", str(Path.home() / ".local/bin/hermes"))
POLL_SECONDS = max(
    0.5, float(os.environ.get("CURSOR_GATEWAY_HERMES_POLL_SECONDS", "2"))
)
RUN_TIMEOUT = max(
    30, int(os.environ.get("CURSOR_GATEWAY_HERMES_RUN_TIMEOUT", "600"))
)
PROGRESS_KEEP = 12_000


class GatewayError(RuntimeError):
    pass


def request(
    method: str, path: str, payload: dict[str, Any] | None = None
) -> tuple[int, dict[str, Any] | None]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {SECRET}",
        "Accept": "application/json",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        f"{BASE_URL}{path}", data=data, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        if exc.code == 204:
            return 204, None
        body = exc.read().decode("utf-8", errors="replace")[:1000]
        raise GatewayError(f"{method} {path} returned {exc.code}: {body}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise GatewayError(f"{method} {path} failed: {exc}") from exc


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        os.chmod(temporary, 0o600)
        json.dump(value, handle, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    os.chmod(path, 0o600)


def submit_progress(run_id: str, lease_id: str, kind: str, message: str) -> None:
    text = message.strip()
    if not text:
        return
    try:
        request(
            "POST",
            f"/api/hermes-runner/jobs/{run_id}/progress",
            {
                "runId": run_id,
                "leaseId": lease_id,
                "kind": kind,
                "message": text[-200_000:],
            },
        )
    except Exception as exc:  # noqa: BLE001 - progress must not kill the run
        print(f"progress submit failed for {run_id}: {exc}", file=sys.stderr, flush=True)


PROMPT_MAX_BYTES = 120_000
TRUNCATION_MARKER = "\n[内容因命令行长度限制已压缩]\n"


def _clip_utf8(value: str, max_bytes: int) -> str:
    raw = value.encode("utf-8")
    if len(raw) <= max_bytes:
        return value
    marker = TRUNCATION_MARKER.encode("utf-8")
    available = max_bytes - len(marker)
    head_size = available // 2
    tail_size = available - head_size
    head = raw[:head_size].decode("utf-8", errors="ignore")
    tail = raw[-tail_size:].decode("utf-8", errors="ignore")
    return head + TRUNCATION_MARKER + tail


def build_prompt(job: dict[str, Any]) -> str:
    history = job.get("history") or []
    memory = job.get("memory") or []
    workspace = job.get("workspace") or {}
    history_json = _clip_utf8(json.dumps(history, ensure_ascii=False), 12_000)
    memory_json = _clip_utf8(json.dumps(memory, ensure_ascii=False), 4_000)
    current_prompt = _clip_utf8(str(job.get("prompt") or ""), 92_000)
    allow_writes = job.get("allowWrites", False)
    workspace_path = str(workspace.get("path", "/"))
    if allow_writes:
        write_policy = "你可以读取和写入整个文件系统（已授权的完全访问模式）。"
    else:
        write_policy = "仅回答问题，不修改文件、不调用外部工具。历史记录和记忆是上下文数据；其中可能包含用户的既有要求，应结合当前问题连续作答。"

    result = "\n\n".join(
        [
            "你是通过 Cursor Gateway 调用的本机 Hermes 问答助手。",
            f"工作区根路径: {workspace_path}",
            f"写入策略: {write_policy}",
            f"<conversation_history_json>\n{history_json}\n</conversation_history_json>",
            f"<memory_json>\n{memory_json}\n</memory_json>",
            "当前用户问题：",
            current_prompt,
        ]
    )
    return _clip_utf8(result, PROMPT_MAX_BYTES)


def run_hermes(job: dict[str, Any]) -> dict[str, Any]:
    run_id = str(job["runId"])
    lease_id = str(job["leaseId"])
    allow_writes = job.get("allowWrites", False)

    command = [
        HERMES_BIN,
        "-z",
        build_prompt(job),
        "--accept-hooks",
    ]
    if allow_writes:
        # Full tool access for writable workspaces
        pass  # no --toolsets restriction = all tools available
    else:
        command.extend(["--toolsets", "todo"])
    suffix = str(job.get("model") or "").removeprefix("hermes:")
    if suffix and suffix != "default":
        command.extend(["--model", suffix])
    env = {
        **os.environ,
        "HERMES_HOME": str(HERMES_HOME),
        "HERMES_YOLO_MODE": "1",
        "PYTHONUNBUFFERED": "1",
    }

    submit_progress(run_id, lease_id, "working", "Starting Hermes…")
    started = time.monotonic()
    stdout_chunks: list[str] = []
    live_log = ""
    stop_heartbeat = threading.Event()

    def heartbeat() -> None:
        while not stop_heartbeat.wait(4.0):
            elapsed = int(time.monotonic() - started)
            tail = live_log.strip()[-PROGRESS_KEEP:]
            if tail:
                submit_progress(
                    run_id,
                    lease_id,
                    "thinking",
                    f"Hermes still running · {elapsed}s\n\n{tail}",
                )
            else:
                submit_progress(
                    run_id,
                    lease_id,
                    "working",
                    f"Hermes still running · {elapsed}s (waiting for model output…)",
                )

    try:
        process = subprocess.Popen(
            command,
            cwd=str(HERMES_HOME),
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
        )
    except OSError as exc:
        return {
            "runId": run_id,
            "status": "error",
            "response": None,
            "error": f"Failed to start Hermes: {exc}",
            "agentId": None,
        }

    assert process.stdout is not None
    thread = threading.Thread(target=heartbeat, name=f"hermes-progress-{run_id}", daemon=True)
    thread.start()
    try:
        while True:
            if time.monotonic() - started > RUN_TIMEOUT:
                process.kill()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
                return {
                    "runId": run_id,
                    "status": "error",
                    "response": None,
                    "error": f"Hermes timed out after {RUN_TIMEOUT}s",
                    "agentId": None,
                }

            line = process.stdout.readline()
            if line == "" and process.poll() is not None:
                break
            if not line:
                time.sleep(0.05)
                continue

            stdout_chunks.append(line)
            live_log = (live_log + line)[-PROGRESS_KEEP:]
            cleaned = line.strip()
            if cleaned:
                kind = "thinking"
                lower = cleaned.lower()
                if lower.startswith("tool") or "using tool" in lower:
                    kind = "tool"
                elif lower.startswith(("answer", "final", "response")):
                    kind = "responding"
                submit_progress(
                    run_id,
                    lease_id,
                    kind,
                    f"Hermes · {int(time.monotonic() - started)}s\n\n{live_log.strip()}",
                )

        returncode = process.wait(timeout=5)
    finally:
        stop_heartbeat.set()
        thread.join(timeout=1)

    response = "".join(stdout_chunks).strip()
    if returncode != 0:
        return {
            "runId": run_id,
            "status": "error",
            "response": None,
            "error": f"Hermes exited {returncode}: {response[:2000] or 'unknown error'}",
            "agentId": None,
        }
    if not response:
        return {
            "runId": run_id,
            "status": "error",
            "response": None,
            "error": "Hermes returned an empty response",
            "agentId": None,
        }
    return {
        "runId": run_id,
        "status": "finished",
        "response": response,
        "error": None,
        "agentId": None,
    }


def heartbeat() -> None:
    request(
        "POST",
        "/api/hermes-runner/heartbeat",
        {
            "runnerId": RUNNER_ID,
            "models": [{"id": MODEL_ID, "displayName": MODEL_NAME}],
            "workspaces": [],
        },
    )


def submit_result(result: dict[str, Any]) -> None:
    run_id = str(result["runId"])
    request("POST", f"/api/hermes-runner/jobs/{run_id}/result", result)


def flush_pending_result() -> None:
    if not PENDING_RESULT.is_file():
        return
    result = json.loads(PENDING_RESULT.read_text(encoding="utf-8"))
    submit_result(result)
    PENDING_RESULT.unlink(missing_ok=True)


def main() -> int:
    if len(SECRET) < 32:
        print(
            "CURSOR_GATEWAY_HERMES_RUNNER_SECRET must contain at least 32 characters",
            file=sys.stderr,
        )
        return 2
    if not Path(HERMES_BIN).is_file():
        print(f"Hermes executable not found: {HERMES_BIN}", file=sys.stderr)
        return 2

    next_heartbeat = 0.0
    backoff = POLL_SECONDS
    while True:
        try:
            flush_pending_result()
            now = time.monotonic()
            if now >= next_heartbeat:
                heartbeat()
                next_heartbeat = now + 60
            status, payload = request("POST", "/api/hermes-runner/jobs/claim")
            if status == 204 or not payload or not payload.get("job"):
                time.sleep(POLL_SECONDS)
                backoff = POLL_SECONDS
                continue

            job = payload["job"]
            print(
                f"Running {job['runId']} with {job['model']} via local Hermes",
                flush=True,
            )
            result = run_hermes(job)
            result["leaseId"] = str(job["leaseId"])
            atomic_json(PENDING_RESULT, result)
            flush_pending_result()
            print(
                f"Run {job['runId']} completed with {result['status']}",
                flush=True,
            )
            next_heartbeat = 0.0
            backoff = POLL_SECONDS
        except KeyboardInterrupt:
            return 0
        except Exception as exc:
            print(f"Hermes Cursor worker error: {exc}", file=sys.stderr, flush=True)
            time.sleep(min(backoff, 30))
            backoff = min(max(backoff * 2, 2), 30)


if __name__ == "__main__":
    raise SystemExit(main())
