#!/usr/bin/env python3
"""Safely mirror the primary's running Cursor Gateway revision to vps-band."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterator

from common import atomic_write_json, expand, load_config, node_id, read_json
from leader import read_leader
from orchestrator import alert


REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
SENSITIVE_KEY_RE = re.compile(
    r"(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|chat[_-]?id)",
    re.IGNORECASE,
)
ACTIVE_MODES = {"TAKEOVER", "ACTIVE_STANDBY", "FAILBACK_SYNC"}

PRIMARY_PROBE = r"""
import json
import pathlib
import re
import subprocess
import sys

container, repo_text = sys.argv[1:3]
repo = pathlib.Path(repo_text).expanduser()

def run(args):
    return subprocess.run(args, text=True, capture_output=True, timeout=20)

result = {
    "container": container,
    "repo_exists": repo.is_dir(),
    "repo_is_git": False,
    "repo_head": None,
    "repo_dirty": None,
    "repo_dirty_entries": None,
    "revision": None,
    "source": None,
    "image_id": None,
    "image_created": None,
    "container_created": None,
    "health": None,
    "status": None,
}

git_head = run(["git", "-C", str(repo), "rev-parse", "HEAD"])
if git_head.returncode == 0:
    result["repo_is_git"] = True
    result["repo_head"] = git_head.stdout.strip()
    git_status = run(
        ["git", "-C", str(repo), "status", "--porcelain=v1", "--untracked-files=all"]
    )
    if git_status.returncode == 0:
        entries = [line for line in git_status.stdout.splitlines() if line]
        result["repo_dirty"] = bool(entries)
        result["repo_dirty_entries"] = len(entries)

inspection = run(["docker", "inspect", container])
if inspection.returncode != 0:
    print(json.dumps(result, sort_keys=True))
    raise SystemExit(0)

data = json.loads(inspection.stdout)[0]
labels = (data.get("Config") or {}).get("Labels") or {}
state = data.get("State") or {}
result.update(
    {
        "revision": labels.get("org.opencontainers.image.revision"),
        "source": labels.get("org.opencontainers.image.source"),
        "image_id": data.get("Image"),
        "container_created": data.get("Created"),
        "health": (state.get("Health") or {}).get("Status"),
        "status": state.get("Status"),
    }
)

image_id = result["image_id"]
if image_id:
    image = run(["docker", "image", "inspect", image_id])
    if image.returncode == 0:
        result["image_created"] = json.loads(image.stdout)[0].get("Created")

print(json.dumps(result, sort_keys=True))
"""


class SyncError(RuntimeError):
    """A fail-closed synchronization error with a stable, non-secret code."""

    def __init__(self, code: str, *, retry: bool = True) -> None:
        super().__init__(code)
        self.code = code
        self.retry = retry


class CommandError(SyncError):
    def __init__(self, operation: str, returncode: int) -> None:
        super().__init__(f"{operation}_failed")
        self.operation = operation
        self.returncode = returncode


class GatewayVersionSync:
    def __init__(
        self,
        config: dict[str, Any],
        *,
        sleep: Callable[[float], None] = time.sleep,
        urlopen: Callable[..., Any] = urllib.request.urlopen,
    ) -> None:
        self.config = config
        self.settings = dict(config.get("gateway_version_sync") or {})
        self.sleep = sleep
        self.urlopen = urlopen
        self._target: str | None = None

    def setting(self, name: str, default: Any) -> Any:
        value = self.settings.get(name)
        return default if value is None else value

    @property
    def state_root(self) -> Path:
        return expand(
            str(
                self.setting(
                    "state_dir",
                    "~/.local/state/hermes-ha/gateway-version-sync",
                )
            )
        )

    @property
    def state_path(self) -> Path:
        return self.state_root / "state.json"

    @property
    def lock_path(self) -> Path:
        return self.state_root / "sync.lock"

    @property
    def deploy_root(self) -> Path:
        return expand(str(self.setting("deploy_root", "~/cursor-gateway")))

    @property
    def env_file(self) -> Path:
        return expand(str(self.setting("env_file", "~/cursor-gateway/.env")))

    @property
    def compose_file(self) -> Path:
        return expand(
            str(
                self.setting(
                    "compose_file",
                    "~/cursor-gateway/infra/docker-compose.yml",
                )
            )
        )

    @property
    def releases_dir(self) -> Path:
        return expand(str(self.setting("releases_dir", "~/releases")))

    @property
    def cache_repo(self) -> Path:
        return expand(
            str(
                self.setting(
                    "cache_repo",
                    "~/.cache/hermes-ha/cursor-gateway.git",
                )
            )
        )

    @property
    def github_repo(self) -> str:
        return str(self.setting("github_repo", "Dudoll/cursor-gateway"))

    @property
    def github_git_url(self) -> str:
        return str(
            self.setting(
                "github_git_url",
                f"https://github.com/{self.github_repo}.git",
            )
        )

    @property
    def expected_source(self) -> str:
        return str(
            self.setting(
                "expected_source",
                f"https://github.com/{self.github_repo}",
            )
        ).rstrip("/")

    @staticmethod
    def scrub_text(value: object, limit: int = 1_200) -> str:
        text = str(value)
        text = re.sub(
            r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+",
            r"\1 [REDACTED]",
            text,
        )
        text = re.sub(
            r"(?i)\b(password|passwd|secret|token|api[_-]?key|chat[_-]?id)"
            r"\s*[:=]\s*[^\s,;]+",
            lambda match: f"{match.group(1)}=[REDACTED]",
            text,
        )
        text = re.sub(
            r"(https?://)([^/@:\s]+):([^/@\s]+)@",
            r"\1[REDACTED]@",
            text,
        )
        return text[-limit:]

    @classmethod
    def sanitized(cls, value: Any, key: str = "") -> Any:
        if SENSITIVE_KEY_RE.search(key):
            return "[REDACTED]"
        if isinstance(value, dict):
            return {str(k): cls.sanitized(v, str(k)) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [cls.sanitized(item, key) for item in value]
        if isinstance(value, str):
            return cls.scrub_text(value, limit=2_000)
        if isinstance(value, (int, float, bool)) or value is None:
            return value
        return cls.scrub_text(value)

    def log(self, event: str, **fields: Any) -> None:
        payload = {
            "timestamp": self.now(),
            "component": "gateway-version-sync",
            "event": event,
            **fields,
        }
        print(
            json.dumps(self.sanitized(payload), ensure_ascii=False, sort_keys=True),
            flush=True,
        )

    @staticmethod
    def now() -> str:
        return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

    def run(
        self,
        args: list[str],
        *,
        operation: str,
        input_text: str | None = None,
        timeout: int | None = None,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        self.log("command.started", operation=operation)
        try:
            proc = subprocess.run(
                args,
                input=input_text,
                text=True,
                capture_output=True,
                timeout=timeout,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            self.log(
                "command.failed",
                operation=operation,
                error=type(exc).__name__,
            )
            raise SyncError(f"{operation}_unavailable") from exc
        if check and proc.returncode != 0:
            self.log(
                "command.failed",
                operation=operation,
                returncode=proc.returncode,
                detail=self.scrub_text(proc.stderr or proc.stdout),
            )
            raise CommandError(operation, proc.returncode)
        self.log(
            "command.finished",
            operation=operation,
            returncode=proc.returncode,
        )
        return proc

    def run_with_file(
        self,
        args: list[str],
        source: BinaryIO,
        *,
        operation: str,
        timeout: int,
    ) -> None:
        self.log("command.started", operation=operation)
        try:
            proc = subprocess.run(
                args,
                stdin=source,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            self.log(
                "command.failed",
                operation=operation,
                error=type(exc).__name__,
            )
            raise SyncError(f"{operation}_unavailable") from exc
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or b"").decode(
                "utf-8", errors="replace"
            )
            self.log(
                "command.failed",
                operation=operation,
                returncode=proc.returncode,
                detail=self.scrub_text(detail),
            )
            raise CommandError(operation, proc.returncode)
        self.log("command.finished", operation=operation, returncode=0)

    @contextlib.contextmanager
    def lock(self) -> Iterator[bool]:
        self.state_root.mkdir(parents=True, exist_ok=True)
        os.chmod(self.state_root, 0o700)
        handle = self.lock_path.open("a+", encoding="utf-8")
        os.chmod(self.lock_path, 0o600)
        try:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                yield False
                return
            handle.seek(0)
            handle.truncate()
            handle.write(f"{os.getpid()}\n")
            handle.flush()
            yield True
        finally:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            handle.close()

    def load_state(self) -> dict[str, Any]:
        return read_json(self.state_path) or {
            "last_checked": None,
            "target": None,
            "applied": None,
            "result": "never_run",
            "consecutive_failures": 0,
            "last_error": None,
            "rollback": None,
            "last_alert_key": None,
        }

    def write_state(self, payload: dict[str, Any]) -> None:
        self.state_root.mkdir(parents=True, exist_ok=True)
        os.chmod(self.state_root, 0o700)
        atomic_write_json(self.state_path, self.sanitized(payload), mode=0o600)

    def record_success(
        self,
        *,
        result: str,
        target: str,
        applied: str | None,
        rollback: str | None = None,
        artifact_sha256: str | None = None,
        image_id: str | None = None,
    ) -> None:
        previous = self.load_state()
        recovered = int(previous.get("consecutive_failures") or 0) > 0
        payload = {
            **previous,
            "last_checked": self.now(),
            "target": target,
            "applied": applied or previous.get("applied"),
            "result": result,
            "consecutive_failures": 0,
            "last_error": None,
            "rollback": rollback or previous.get("rollback"),
            "artifact_sha256": artifact_sha256
            or previous.get("artifact_sha256"),
            "image_id": image_id or previous.get("image_id"),
        }
        self.write_state(payload)
        if recovered:
            self.notify_once(
                f"recovered:{target}",
                f"Cursor Gateway standby version sync recovered; target={target[:12]}",
            )

    def record_deferred(self, *, target: str, reason: str) -> None:
        previous = self.load_state()
        self.write_state(
            {
                **previous,
                "last_checked": self.now(),
                "target": target,
                "result": reason,
                "last_error": None,
            }
        )

    def record_failure(self, error: SyncError, *, target: str | None) -> None:
        previous = self.load_state()
        count = int(previous.get("consecutive_failures") or 0) + 1
        payload = {
            **previous,
            "last_checked": self.now(),
            "target": target or previous.get("target"),
            "result": "failed",
            "consecutive_failures": count,
            "last_error": error.code,
        }
        self.write_state(payload)
        threshold = max(1, int(self.setting("failure_alert_threshold", 2)))
        if count == 1 or count == threshold:
            self.notify_once(
                f"failure:{error.code}:{count if count == threshold else 'first'}",
                "Cursor Gateway standby version sync failed "
                f"(reason={error.code}, consecutive_failures={count}); "
                "standby artifact was left unchanged",
            )

    def notify_once(self, key: str, message: str) -> None:
        state = self.load_state()
        if state.get("last_alert_key") == key:
            return
        try:
            alert(self.config, message)
        except Exception as exc:  # noqa: BLE001
            self.log("alert.failed", error=type(exc).__name__)
            return
        state["last_alert_key"] = key
        self.write_state(state)

    def primary_probe(self) -> dict[str, Any]:
        host = str(self.setting("primary_ssh", "vps-dmit"))
        container = str(self.setting("primary_container", "infra-app-1"))
        repo = str(self.setting("primary_repo", "~/cursor-gateway"))
        proc = self.run(
            [
                "ssh",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                host,
                "python3",
                "-",
                container,
                repo,
            ],
            operation="primary_probe",
            input_text=PRIMARY_PROBE,
            timeout=45,
        )
        try:
            payload = json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            raise SyncError("primary_probe_invalid") from exc
        if not isinstance(payload, dict):
            raise SyncError("primary_probe_invalid")
        return payload

    def validate_primary(self, payload: dict[str, Any]) -> str:
        revision = str(payload.get("revision") or "")
        if not REVISION_RE.fullmatch(revision):
            raise SyncError("primary_revision_missing")
        source = str(payload.get("source") or "").removesuffix(".git").rstrip("/")
        if source != self.expected_source.removesuffix(".git"):
            raise SyncError("primary_source_untrusted")
        if payload.get("status") != "running" or payload.get("health") != "healthy":
            raise SyncError("primary_app_unhealthy")
        if not payload.get("repo_is_git"):
            raise SyncError("primary_source_missing")
        if payload.get("repo_dirty") is not False:
            raise SyncError("primary_source_dirty")
        if str(payload.get("repo_head") or "") != revision:
            raise SyncError("primary_source_revision_mismatch")
        if not str(payload.get("image_id") or "").startswith("sha256:"):
            raise SyncError("primary_image_unverifiable")
        return revision

    def stable_primary(self) -> tuple[str, dict[str, Any]]:
        first = self.primary_probe()
        revision = self.validate_primary(first)
        delay = max(0, int(self.setting("primary_stability_seconds", 30)))
        if delay:
            self.log("primary.stability_wait", revision=revision, seconds=delay)
            self.sleep(delay)
            second = self.primary_probe()
            second_revision = self.validate_primary(second)
            stable_fields = ("revision", "image_id", "repo_head", "repo_dirty")
            if second_revision != revision or any(
                first.get(key) != second.get(key) for key in stable_fields
            ):
                raise SyncError("primary_revision_unstable")
            first = second
        self.log(
            "primary.verified",
            revision=revision,
            image_id=first.get("image_id"),
            health=first.get("health"),
        )
        return revision, first

    def github_get(self, path: str) -> Any:
        base = str(self.setting("github_api_url", "https://api.github.com")).rstrip("/")
        request = urllib.request.Request(
            f"{base}{path}",
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "hermes-ha-gateway-version-sync/1",
            },
        )
        token = os.environ.get("GITHUB_TOKEN", "").strip()
        if token:
            request.add_header("Authorization", f"Bearer {token}")
        try:
            with self.urlopen(
                request,
                timeout=max(5, int(self.setting("github_timeout_seconds", 15))),
            ) as response:
                if int(getattr(response, "status", 200)) != 200:
                    raise SyncError("github_http_error")
                return json.load(response)
        except SyncError:
            raise
        except (
            OSError,
            TimeoutError,
            urllib.error.URLError,
            json.JSONDecodeError,
        ) as exc:
            raise SyncError("github_unreachable") from exc

    def ensure_git_revision(self, revision: str) -> bool:
        self.cache_repo.parent.mkdir(parents=True, exist_ok=True)
        if not self.cache_repo.is_dir():
            self.run(
                ["git", "init", "--bare", str(self.cache_repo)],
                operation="git_cache_init",
                timeout=30,
            )
            self.run(
                [
                    "git",
                    "--git-dir",
                    str(self.cache_repo),
                    "remote",
                    "add",
                    "origin",
                    self.github_git_url,
                ],
                operation="git_cache_remote",
                timeout=30,
            )
        remote = self.run(
            [
                "git",
                "--git-dir",
                str(self.cache_repo),
                "remote",
                "get-url",
                "origin",
            ],
            operation="git_cache_remote_verify",
            timeout=15,
        ).stdout.strip()
        if remote.rstrip("/").removesuffix(".git") != self.github_git_url.rstrip(
            "/"
        ).removesuffix(".git"):
            raise SyncError("git_cache_remote_mismatch")
        self.run(
            [
                "git",
                "--git-dir",
                str(self.cache_repo),
                "fetch",
                "--force",
                "--no-tags",
                "origin",
                revision,
            ],
            operation="git_fetch_revision",
            timeout=180,
        )
        self.run(
            [
                "git",
                "--git-dir",
                str(self.cache_repo),
                "fetch",
                "--force",
                "--no-tags",
                "origin",
                "+refs/heads/main:refs/remotes/origin/main",
            ],
            operation="git_fetch_main",
            timeout=180,
        )
        self.run(
            [
                "git",
                "--git-dir",
                str(self.cache_repo),
                "cat-file",
                "-e",
                f"{revision}^{{commit}}",
            ],
            operation="git_commit_verify",
            timeout=30,
        )
        resolved = self.run(
            [
                "git",
                "--git-dir",
                str(self.cache_repo),
                "rev-parse",
                revision,
            ],
            operation="git_revision_resolve",
            timeout=30,
        ).stdout.strip()
        if resolved != revision:
            raise SyncError("git_revision_mismatch")
        self.run(
            [
                "git",
                "--git-dir",
                str(self.cache_repo),
                "fsck",
                "--strict",
                "--no-dangling",
                revision,
            ],
            operation="git_object_integrity",
            timeout=120,
        )
        ancestor = self.run(
            [
                "git",
                "--git-dir",
                str(self.cache_repo),
                "merge-base",
                "--is-ancestor",
                revision,
                "refs/remotes/origin/main",
            ],
            operation="git_main_ancestry",
            timeout=30,
            check=False,
        )
        if ancestor.returncode not in (0, 1):
            raise CommandError("git_main_ancestry", ancestor.returncode)
        return ancestor.returncode == 0

    def verify_github_revision(self, revision: str) -> None:
        on_main = self.ensure_git_revision(revision)
        commit = self.github_get(
            f"/repos/{urllib.parse.quote(self.github_repo, safe='/')}/commits/{revision}"
        )
        if not isinstance(commit, dict) or commit.get("sha") != revision:
            raise SyncError("github_revision_missing")
        verification = ((commit.get("commit") or {}).get("verification") or {})
        if verification.get("verified") is not True:
            raise SyncError("github_signature_unverified")
        if not on_main:
            pulls = self.github_get(
                f"/repos/{urllib.parse.quote(self.github_repo, safe='/')}"
                f"/commits/{revision}/pulls"
            )
            merged = any(
                isinstance(item, dict)
                and item.get("merged_at")
                and item.get("merge_commit_sha") == revision
                and ((item.get("base") or {}).get("ref") == "main")
                for item in (pulls if isinstance(pulls, list) else [])
            )
            if not merged:
                raise SyncError("github_revision_unmerged")
        self.log(
            "github.verified",
            revision=revision,
            signature_reason=verification.get("reason"),
            merged_via="main" if on_main else "pull_request",
        )

    def current_app(self) -> dict[str, Any]:
        container = str(self.setting("app_container", "infra-app-1"))
        proc = self.run(
            ["docker", "inspect", container],
            operation="standby_app_inspect",
            timeout=30,
            check=False,
        )
        if proc.returncode != 0:
            return {
                "exists": False,
                "revision": None,
                "image_id": None,
                "health": None,
                "status": None,
            }
        try:
            data = json.loads(proc.stdout)[0]
        except (json.JSONDecodeError, IndexError, TypeError) as exc:
            raise SyncError("standby_app_inspect_invalid") from exc
        labels = (data.get("Config") or {}).get("Labels") or {}
        state = data.get("State") or {}
        return {
            "exists": True,
            "revision": labels.get("org.opencontainers.image.revision"),
            "image_id": data.get("Image"),
            "health": (state.get("Health") or {}).get("Status"),
            "status": state.get("Status"),
        }

    def standby_active_reason(self) -> str | None:
        leader = read_leader(self.config)
        if str(leader.get("role_holder") or "") == "vps-band":
            return "standby_is_role_holder"
        if str(leader.get("dns_target") or "") == "vps-band":
            return "standby_is_dns_target"
        if str(leader.get("mode") or "") in ACTIVE_MODES:
            return "standby_failover_active"
        return None

    def container_running(self, container: str) -> bool:
        proc = self.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", container],
            operation=f"container_state_{container}",
            timeout=20,
            check=False,
        )
        return proc.returncode == 0 and proc.stdout.strip() == "true"

    def active_runs(self) -> int:
        postgres = str(self.setting("postgres_container", "infra-postgres-1"))
        if not self.container_running(postgres):
            return 0
        user = str(self.setting("postgres_user", "cursor_gateway"))
        database = str(self.setting("postgres_database", "cursor_gateway"))
        table = self.run(
            [
                "docker",
                "exec",
                postgres,
                "psql",
                "-U",
                user,
                "-d",
                database,
                "-X",
                "-A",
                "-t",
                "-v",
                "ON_ERROR_STOP=1",
                "-c",
                "select case when to_regclass('public.runs') is null "
                "then 'missing' else 'present' end;",
            ],
            operation="standby_runs_table",
            timeout=30,
        )
        if table.stdout.strip() == "missing":
            return 0
        if table.stdout.strip() != "present":
            raise SyncError("standby_runs_table_invalid")
        proc = self.run(
            [
                "docker",
                "exec",
                postgres,
                "psql",
                "-U",
                user,
                "-d",
                database,
                "-X",
                "-A",
                "-t",
                "-v",
                "ON_ERROR_STOP=1",
                "-c",
                "select count(*) from runs where deleted_at is null "
                "and status in ('queued','running');",
            ],
            operation="standby_active_runs",
            timeout=30,
        )
        value = proc.stdout.strip()
        if not value.isdigit():
            raise SyncError("standby_active_runs_invalid")
        return int(value)

    @staticmethod
    def file_sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()

    @staticmethod
    def load_env(path: Path) -> dict[str, str]:
        values: dict[str, str] = {}
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("\"'")
        return values

    def validate_environment(self) -> str:
        if not self.env_file.is_file():
            raise SyncError("standby_environment_missing")
        mode = self.env_file.stat().st_mode & 0o777
        if mode & 0o077:
            raise SyncError("standby_environment_permissions")
        values = self.load_env(self.env_file)
        required = {
            "JWT_SECRET",
            "DATABASE_URL",
            "RUNNER_SHARED_SECRET",
            "POSTGRES_USER",
            "POSTGRES_PASSWORD",
            "POSTGRES_DB",
        }
        if any(not values.get(key) for key in required):
            raise SyncError("standby_environment_incomplete")
        return self.file_sha256(self.env_file)

    def stage_release(self, revision: str) -> tuple[Path, str]:
        self.releases_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.releases_dir, 0o700)
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        release = self.releases_dir / f"cursor-gateway-{stamp}-{revision[:12]}"
        release.mkdir(mode=0o700)
        archive = self.state_root / "artifacts" / f"cursor-gateway-{revision}.tar"
        archive.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(archive.parent, 0o700)
        temporary = archive.with_name(f".{archive.name}.{os.getpid()}.tmp")
        temporary.unlink(missing_ok=True)
        self.run(
            [
                "git",
                "--git-dir",
                str(self.cache_repo),
                "archive",
                "--format=tar",
                f"--prefix=source/",
                f"--output={temporary}",
                revision,
            ],
            operation="git_archive",
            timeout=180,
        )
        with temporary.open("rb") as source:
            proc = subprocess.run(
                ["git", "get-tar-commit-id"],
                stdin=source,
                text=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=30,
            )
        if proc.returncode != 0 or proc.stdout.decode().strip() != revision:
            temporary.unlink(missing_ok=True)
            raise SyncError("artifact_commit_checksum_mismatch")
        artifact_sha = self.file_sha256(temporary)
        temporary.replace(archive)
        self.run(
            [
                "tar",
                "-xf",
                str(archive),
                "-C",
                str(release),
                "--strip-components=1",
            ],
            operation="artifact_extract",
            timeout=180,
        )
        if not (release / "Dockerfile").is_file() or not (
            release / "infra/docker-compose.yml"
        ).is_file():
            raise SyncError("artifact_layout_invalid")
        atomic_write_json(
            release / ".release-source.json",
            {
                "revision": revision,
                "source": self.expected_source,
                "archive_sha256": artifact_sha,
                "github_signature_verified": True,
                "managed_by": "hermes-ha-gateway-version-sync",
                "created_at": self.now(),
            },
            mode=0o600,
        )
        self.log(
            "artifact.verified",
            revision=revision,
            sha256=artifact_sha,
            release=str(release),
        )
        return release, artifact_sha

    def build_candidate(self, release: Path, revision: str) -> str:
        tag = f"infra-app:candidate-{revision}"
        self.run(
            [
                "docker",
                "build",
                "--label",
                f"org.opencontainers.image.revision={revision}",
                "--label",
                f"org.opencontainers.image.source={self.expected_source}",
                "--label",
                f"org.opencontainers.image.version={revision[:12]}",
                "-t",
                tag,
                "-f",
                str(release / "Dockerfile"),
                str(release),
            ],
            operation="candidate_build",
            timeout=max(600, int(self.setting("build_timeout_seconds", 3600))),
        )
        proc = self.run(
            [
                "docker",
                "image",
                "inspect",
                tag,
                "--format",
                "{{.Id}}|{{index .Config.Labels \"org.opencontainers.image.revision\"}}",
            ],
            operation="candidate_image_verify",
            timeout=30,
        )
        image_id, _, label = proc.stdout.strip().partition("|")
        if not image_id.startswith("sha256:") or label != revision:
            raise SyncError("candidate_image_revision_mismatch")
        return tag

    @contextlib.contextmanager
    def release_env_link(self, release: Path) -> Iterator[None]:
        link = release / ".env"
        if link.exists() or link.is_symlink():
            raise SyncError("release_environment_collision")
        link.symlink_to(self.env_file)
        try:
            yield
        finally:
            link.unlink(missing_ok=True)

    def preflight_candidate(self, release: Path, candidate: str) -> None:
        with self.release_env_link(release):
            self.run(
                [
                    "docker",
                    "compose",
                    "--project-name",
                    str(self.setting("compose_project", "infra")),
                    "-f",
                    str(release / "infra/docker-compose.yml"),
                    "config",
                    "--quiet",
                ],
                operation="compose_preflight",
                timeout=60,
            )
        proc = self.run(
            [
                "docker",
                "run",
                "--rm",
                "--env-file",
                str(self.env_file),
                candidate,
                "node",
                "-e",
                "import('./apps/server/dist/config.js')"
                ".then(()=>console.log('config-ok'))",
            ],
            operation="config_preflight",
            timeout=120,
        )
        if proc.stdout.strip() != "config-ok":
            raise SyncError("config_preflight_invalid")

    def copy_upstream_checkpoint(self, rollback: Path) -> Path | None:
        try:
            from gateway_checkpoint import latest_dump

            source = latest_dump(self.config)
        except Exception as exc:  # noqa: BLE001
            self.log(
                "checkpoint.upstream_unavailable",
                error=type(exc).__name__,
            )
            return None
        if not source or not source.is_file() or source.stat().st_size <= 0:
            return None
        target = rollback / "upstream-gateway.dump"
        shutil.copyfile(source, target)
        os.chmod(target, 0o600)
        atomic_write_json(
            rollback / "upstream-gateway.json",
            {
                "file": target.name,
                "size": target.stat().st_size,
                "sha256": self.file_sha256(target),
            },
            mode=0o600,
        )
        return target

    def postgres_dump(self, target: Path) -> None:
        postgres = str(self.setting("postgres_container", "infra-postgres-1"))
        user = str(self.setting("postgres_user", "cursor_gateway"))
        database = str(self.setting("postgres_database", "cursor_gateway"))
        self.log("checkpoint.local.started")
        with target.open("wb") as output:
            proc = subprocess.run(
                [
                    "docker",
                    "exec",
                    postgres,
                    "pg_dump",
                    "-U",
                    user,
                    "-d",
                    database,
                    "--no-owner",
                    "--format=custom",
                ],
                stdout=output,
                stderr=subprocess.PIPE,
                check=False,
                timeout=300,
            )
        if proc.returncode != 0 or not target.is_file() or target.stat().st_size <= 0:
            target.unlink(missing_ok=True)
            detail = (proc.stderr or b"").decode("utf-8", errors="replace")
            self.log(
                "checkpoint.local.failed",
                returncode=proc.returncode,
                detail=self.scrub_text(detail),
            )
            raise SyncError("standby_checkpoint_failed")
        os.chmod(target, 0o600)
        self.log(
            "checkpoint.local.finished",
            size=target.stat().st_size,
            sha256=self.file_sha256(target),
        )

    def backup_current(
        self,
        current: dict[str, Any],
        env_sha: str,
    ) -> dict[str, Any]:
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        rollback = self.state_root / "rollbacks" / stamp
        rollback.mkdir(parents=True, mode=0o700)
        shutil.copyfile(self.env_file, rollback / "gateway.env")
        os.chmod(rollback / "gateway.env", 0o600)
        if self.file_sha256(rollback / "gateway.env") != env_sha:
            raise SyncError("environment_backup_checksum_mismatch")
        compose_existed = self.compose_file.is_file()
        if compose_existed:
            shutil.copyfile(self.compose_file, rollback / "docker-compose.yml")
            os.chmod(rollback / "docker-compose.yml", 0o600)
        postgres = str(self.setting("postgres_container", "infra-postgres-1"))
        redis = str(self.setting("redis_container", "infra-redis-1"))
        postgres_running = self.container_running(postgres)
        redis_running = self.container_running(redis)
        local_dump: Path | None = None
        if postgres_running:
            local_dump = rollback / "standby-before.dump"
            self.postgres_dump(local_dump)
        upstream_dump = self.copy_upstream_checkpoint(rollback)
        if not local_dump and not upstream_dump:
            raise SyncError("gateway_checkpoint_unavailable")
        metadata = {
            "created_at": self.now(),
            "path": str(rollback),
            "current": current,
            "environment_sha256": env_sha,
            "compose_existed": compose_existed,
            "postgres_was_running": postgres_running,
            "redis_was_running": redis_running,
            "local_dump": str(local_dump) if local_dump else None,
            "upstream_dump": str(upstream_dump) if upstream_dump else None,
        }
        atomic_write_json(rollback / "rollback.json", metadata, mode=0o600)
        return metadata

    def install_compose(self, release: Path) -> None:
        self.compose_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.compose_file.with_name(
            f".{self.compose_file.name}.{os.getpid()}.tmp"
        )
        shutil.copyfile(release / "infra/docker-compose.yml", temporary)
        os.chmod(temporary, 0o600)
        temporary.replace(self.compose_file)
        (self.deploy_root / "var/secrets").mkdir(parents=True, exist_ok=True)
        (self.deploy_root / "var/cg-mitm").mkdir(parents=True, exist_ok=True)
        os.chmod(self.deploy_root / "var/secrets", 0o700)
        os.chmod(self.deploy_root / "var/cg-mitm", 0o700)

    def compose_command(self, *args: str) -> list[str]:
        return [
            "docker",
            "compose",
            "--project-name",
            str(self.setting("compose_project", "infra")),
            "-f",
            str(self.compose_file),
            *args,
        ]

    def ensure_support_services(self) -> None:
        self.run(
            self.compose_command("up", "-d", "--no-build", "postgres", "redis"),
            operation="support_services_start",
            timeout=300,
        )
        postgres = str(self.setting("postgres_container", "infra-postgres-1"))
        user = str(self.setting("postgres_user", "cursor_gateway"))
        database = str(self.setting("postgres_database", "cursor_gateway"))
        for _ in range(max(1, int(self.setting("postgres_ready_attempts", 30)))):
            proc = self.run(
                [
                    "docker",
                    "exec",
                    postgres,
                    "pg_isready",
                    "-U",
                    user,
                    "-d",
                    database,
                ],
                operation="postgres_ready",
                timeout=15,
                check=False,
            )
            if proc.returncode == 0:
                return
            self.sleep(2)
        raise SyncError("postgres_not_ready")

    def write_database_env(self, target: Path, database: str) -> None:
        lines = self.env_file.read_text(encoding="utf-8").splitlines()
        values = self.load_env(self.env_file)
        raw_url = values.get("DATABASE_URL", "")
        try:
            parsed = urllib.parse.urlsplit(raw_url)
            if not parsed.scheme or not parsed.netloc:
                raise ValueError("invalid")
            replacement = urllib.parse.urlunsplit(
                (parsed.scheme, parsed.netloc, f"/{database}", "", "")
            )
        except ValueError as exc:
            raise SyncError("database_url_invalid") from exc
        replaced = False
        output: list[str] = []
        for raw in lines:
            if raw.strip().startswith("DATABASE_URL="):
                output.append(f"DATABASE_URL={replacement}")
                replaced = True
            else:
                output.append(raw)
        if not replaced:
            raise SyncError("database_url_missing")
        target.write_text("\n".join(output) + "\n", encoding="utf-8")
        os.chmod(target, 0o600)

    def migration_preflight(self, candidate: str, checkpoint: Path) -> None:
        postgres = str(self.setting("postgres_container", "infra-postgres-1"))
        user = str(self.setting("postgres_user", "cursor_gateway"))
        database = f"gateway_preflight_{os.getpid()}_{int(time.time())}"
        if not re.fullmatch(r"[a-z0-9_]+", database):
            raise SyncError("preflight_database_name_invalid")
        self.run(
            [
                "docker",
                "exec",
                postgres,
                "psql",
                "-U",
                user,
                "-d",
                "postgres",
                "-X",
                "-v",
                "ON_ERROR_STOP=1",
                "-c",
                f'create database "{database}";',
            ],
            operation="preflight_database_create",
            timeout=60,
        )
        try:
            with checkpoint.open("rb") as source:
                self.run_with_file(
                    [
                        "docker",
                        "exec",
                        "-i",
                        postgres,
                        "pg_restore",
                        "-U",
                        user,
                        "-d",
                        database,
                        "--no-owner",
                        "--clean",
                        "--if-exists",
                    ],
                    source,
                    operation="preflight_checkpoint_restore",
                    timeout=300,
                )
            with tempfile.TemporaryDirectory(dir=self.state_root) as temp:
                candidate_env = Path(temp) / "candidate.env"
                self.write_database_env(candidate_env, database)
                network = str(
                    self.setting(
                        "compose_network",
                        f"{self.setting('compose_project', 'infra')}_cursor-gateway",
                    )
                )
                proc = self.run(
                    [
                        "docker",
                        "run",
                        "--rm",
                        "--network",
                        network,
                        "--env-file",
                        str(candidate_env),
                        candidate,
                        "node",
                        "-e",
                        "import('./apps/server/dist/db.js')"
                        ".then(async m=>{await m.migrate();await m.pool.end();"
                        "console.log('migration-ok')})",
                    ],
                    operation="migration_preflight",
                    timeout=600,
                )
                if proc.stdout.strip() != "migration-ok":
                    raise SyncError("migration_preflight_invalid")
        finally:
            self.run(
                [
                    "docker",
                    "exec",
                    postgres,
                    "psql",
                    "-U",
                    user,
                    "-d",
                    "postgres",
                    "-X",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-c",
                    f'drop database if exists "{database}" with (force);',
                ],
                operation="preflight_database_drop",
                timeout=60,
                check=False,
            )

    def health_check(self, expected_revision: str) -> str:
        attempts = max(1, int(self.setting("health_attempts", 45)))
        delay = max(1, int(self.setting("health_interval_seconds", 2)))
        url = str(self.setting("health_url", "http://127.0.0.1:18080/healthz"))
        for _ in range(attempts):
            current = self.current_app()
            if (
                current.get("status") == "running"
                and current.get("health") == "healthy"
                and current.get("revision") == expected_revision
            ):
                try:
                    request = urllib.request.Request(
                        url,
                        method="GET",
                        headers={"User-Agent": "hermes-ha-health/1"},
                    )
                    with self.urlopen(request, timeout=5) as response:
                        if int(getattr(response, "status", 0)) == 200:
                            return str(current.get("image_id") or "")
                except (OSError, TimeoutError, urllib.error.URLError):
                    pass
            self.sleep(delay)
        raise SyncError("candidate_health_failed")

    def route_check(self) -> None:
        url = str(self.setting("route_health_url", "")).strip()
        if not url:
            raise SyncError("route_health_url_missing")
        expected_raw = self.setting("route_expected_statuses", [200])
        if not isinstance(expected_raw, list) or not expected_raw:
            raise SyncError("route_expected_statuses_invalid")
        try:
            expected = {int(value) for value in expected_raw}
        except (TypeError, ValueError) as exc:
            raise SyncError("route_expected_statuses_invalid") from exc
        request = urllib.request.Request(
            url,
            method="GET",
            headers={"User-Agent": "hermes-ha-route-health/1"},
        )
        try:
            with self.urlopen(request, timeout=10) as response:
                status = int(getattr(response, "status", 0))
        except urllib.error.HTTPError as exc:
            status = int(exc.code)
        except SyncError:
            raise
        except (OSError, TimeoutError, urllib.error.URLError) as exc:
            raise SyncError("route_health_failed") from exc
        if status not in expected:
            raise SyncError("route_health_failed")
        self.log("route.verified", status=status)

    def restart_runner_units(self) -> None:
        units = self.setting("runner_units", [])
        if not isinstance(units, list):
            raise SyncError("runner_units_invalid")
        for unit in units:
            name = str(unit)
            if not re.fullmatch(r"[A-Za-z0-9_.@-]+\.service", name):
                raise SyncError("runner_unit_name_invalid")
            self.run(
                ["systemctl", "--user", "restart", name],
                operation=f"runner_restart_{name}",
                timeout=120,
            )
        self.log("runner.rollout", units=len(units))

    def activate_candidate(self, candidate: str, revision: str) -> str:
        self.run(
            ["docker", "tag", candidate, f"infra-app:git-{revision}"],
            operation="candidate_tag_revision",
            timeout=30,
        )
        self.run(
            ["docker", "tag", candidate, "infra-app:latest"],
            operation="candidate_tag_latest",
            timeout=30,
        )
        self.run(
            self.compose_command(
                "up",
                "-d",
                "--no-build",
                "--no-deps",
                "--force-recreate",
                str(self.setting("app_service", "app")),
            ),
            operation="candidate_activate",
            timeout=300,
        )
        image_id = self.health_check(revision)
        self.restart_runner_units()
        self.route_check()
        return image_id

    def restore_database(self, dump: Path) -> None:
        postgres = str(self.setting("postgres_container", "infra-postgres-1"))
        user = str(self.setting("postgres_user", "cursor_gateway"))
        database = str(self.setting("postgres_database", "cursor_gateway"))
        with dump.open("rb") as source:
            self.run_with_file(
                [
                    "docker",
                    "exec",
                    "-i",
                    postgres,
                    "pg_restore",
                    "-U",
                    user,
                    "-d",
                    database,
                    "--no-owner",
                    "--clean",
                    "--if-exists",
                ],
                source,
                operation="rollback_database_restore",
                timeout=300,
            )

    def rollback(self, context: dict[str, Any]) -> None:
        rollback = Path(str(context["path"]))
        current = dict(context.get("current") or {})
        old_image = str(current.get("image_id") or "")
        self.log("rollback.started", rollback=str(rollback), image_id=old_image or None)
        self.run(
            self.compose_command("stop", str(self.setting("app_service", "app"))),
            operation="rollback_app_stop",
            timeout=120,
            check=False,
        )
        if not context.get("postgres_was_running") and self.compose_file.is_file():
            self.run(
                self.compose_command("stop", "postgres"),
                operation="rollback_postgres_stop",
                timeout=120,
                check=False,
            )
        if not context.get("redis_was_running") and self.compose_file.is_file():
            self.run(
                self.compose_command("stop", "redis"),
                operation="rollback_redis_stop",
                timeout=120,
                check=False,
            )
        if context.get("compose_existed"):
            shutil.copyfile(rollback / "docker-compose.yml", self.compose_file)
            os.chmod(self.compose_file, 0o600)
        else:
            self.compose_file.unlink(missing_ok=True)
        backup_env = rollback / "gateway.env"
        if backup_env.is_file():
            shutil.copyfile(backup_env, self.env_file)
            os.chmod(self.env_file, 0o600)
        local_dump_text = str(context.get("local_dump") or "")
        local_dump = Path(local_dump_text) if local_dump_text else None
        if local_dump and local_dump.is_file() and self.container_running(
            str(self.setting("postgres_container", "infra-postgres-1"))
        ):
            self.restore_database(local_dump)
        if old_image.startswith("sha256:") and self.compose_file.is_file():
            self.run(
                ["docker", "tag", old_image, "infra-app:latest"],
                operation="rollback_image_tag",
                timeout=30,
            )
            self.run(
                self.compose_command(
                    "up",
                    "-d",
                    "--no-build",
                    "--no-deps",
                    "--force-recreate",
                    str(self.setting("app_service", "app")),
                ),
                operation="rollback_app_activate",
                timeout=300,
            )
            expected = str(current.get("revision") or "")
            if REVISION_RE.fullmatch(expected):
                self.health_check(expected)
            self.restart_runner_units()
        self.log("rollback.finished", rollback=str(rollback))

    def cleanup_releases(self, active: Path) -> None:
        retain = max(1, int(self.setting("release_retention", 3)))
        candidates = sorted(
            (
                path
                for path in self.releases_dir.glob("cursor-gateway-*")
                if path.is_dir()
                and (
                    read_json(path / ".release-source.json") or {}
                ).get("managed_by")
                == "hermes-ha-gateway-version-sync"
            ),
            key=lambda item: item.name,
            reverse=True,
        )
        keep = {active}
        keep.update(candidates[:retain])
        for path in candidates:
            if path not in keep:
                shutil.rmtree(path)

    def synchronize(self) -> tuple[str, str, str | None]:
        if not bool(self.setting("enabled", True)):
            raise SyncError("gateway_version_sync_disabled", retry=False)
        if node_id(self.config) != "vps-band":
            raise SyncError("gateway_version_sync_wrong_node", retry=False)

        revision, _primary = self.stable_primary()
        self._target = revision
        self.verify_github_revision(revision)
        current = self.current_app()
        current_revision = str(current.get("revision") or "")

        if current_revision != revision:
            self.notify_once(
                f"drift:{revision}",
                "Cursor Gateway standby version drift detected "
                f"(current={current_revision[:12] or 'none'}, target={revision[:12]})",
            )

        active_reason = self.standby_active_reason()
        if active_reason:
            self.record_deferred(target=revision, reason=active_reason)
            self.notify_once(
                f"deferred:{active_reason}:{revision}",
                "Cursor Gateway standby version sync deferred "
                f"(reason={active_reason}, target={revision[:12]}); "
                "active failover was not interrupted",
            )
            return active_reason, revision, current_revision or None

        runs = self.active_runs()
        if runs > 0:
            reason = "standby_active_runs"
            self.record_deferred(target=revision, reason=reason)
            self.notify_once(
                f"deferred:{reason}:{revision}",
                "Cursor Gateway standby version sync deferred "
                f"(reason={reason}, active_runs={runs}, target={revision[:12]})",
            )
            return reason, revision, current_revision or None

        if (
            current_revision == revision
            and current.get("status") == "running"
            and current.get("health") == "healthy"
        ):
            self.record_success(
                result="no_op",
                target=revision,
                applied=revision,
                image_id=str(current.get("image_id") or ""),
            )
            self.log("sync.no_op", revision=revision)
            return "no_op", revision, revision

        env_sha = self.validate_environment()
        release, artifact_sha = self.stage_release(revision)
        candidate = self.build_candidate(release, revision)
        self.preflight_candidate(release, candidate)
        context = self.backup_current(current, env_sha)
        rollback_path = str(context["path"])
        checkpoint_text = str(
            context.get("local_dump") or context.get("upstream_dump") or ""
        )
        if not checkpoint_text:
            raise SyncError("gateway_checkpoint_unavailable")
        checkpoint = Path(checkpoint_text)

        try:
            self.install_compose(release)
            self.ensure_support_services()
            self.migration_preflight(candidate, checkpoint)
            if self.active_runs() > 0:
                raise SyncError("standby_became_active")
            if self.standby_active_reason():
                raise SyncError("standby_became_role_holder")
            image_id = self.activate_candidate(candidate, revision)
            if self.file_sha256(self.env_file) != env_sha:
                raise SyncError("standby_environment_changed")
        except Exception as exc:  # noqa: BLE001
            original = exc if isinstance(exc, SyncError) else SyncError(
                f"unexpected_{type(exc).__name__}"
            )
            try:
                self.rollback(context)
            except Exception as rollback_exc:  # noqa: BLE001
                self.log(
                    "rollback.failed",
                    error=type(rollback_exc).__name__,
                )
                raise SyncError("automatic_rollback_failed") from original
            raise original

        self.record_success(
            result="applied",
            target=revision,
            applied=revision,
            rollback=rollback_path,
            artifact_sha256=artifact_sha,
            image_id=image_id,
        )
        self.notify_once(
            f"applied:{revision}",
            "Cursor Gateway standby version sync applied "
            f"(revision={revision[:12]}, health=healthy, role=standby)",
        )
        self.cleanup_releases(release)
        self.log(
            "sync.applied",
            revision=revision,
            image_id=image_id,
            rollback=rollback_path,
        )
        return "applied", revision, revision

    def execute(self) -> int:
        target: str | None = None
        with self.lock() as acquired:
            if not acquired:
                self.log("sync.skipped", reason="lock_held")
                return 0
            try:
                result, target, applied = self.synchronize()
                self.log(
                    "sync.finished",
                    result=result,
                    target=target,
                    applied=applied,
                )
                return 0
            except SyncError as exc:
                if exc.code in {
                    "gateway_version_sync_disabled",
                    "gateway_version_sync_wrong_node",
                }:
                    self.log("sync.skipped", reason=exc.code)
                    return 0
                target = (
                    target
                    or self._target
                    or str(self.load_state().get("target") or "")
                    or None
                )
                self.record_failure(exc, target=target)
                self.log(
                    "sync.failed",
                    reason=exc.code,
                    retry=exc.retry,
                    target=target,
                )
                return 2 if exc.retry else 0
            except Exception as exc:  # noqa: BLE001
                error = SyncError(f"unexpected_{type(exc).__name__}")
                self.record_failure(error, target=target)
                self.log("sync.failed", reason=error.code, retry=True)
                return 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Mirror the primary's verified running Gateway revision to vps-band"
    )
    parser.add_argument("--config", type=Path)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("sync")
    sub.add_parser("status")
    args = parser.parse_args(argv)
    sync = GatewayVersionSync(load_config(args.config))
    if args.command == "status":
        print(json.dumps(sync.sanitized(sync.load_state()), indent=2, sort_keys=True))
        return 0
    return sync.execute()


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
