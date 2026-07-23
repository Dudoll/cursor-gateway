# Performance / Function / Security Test Matrix

Aligned with `docs/gateway-performance-refactor-plan.md`.

## Functional

| ID | Case | Pass criteria |
| --- | --- | --- |
| F1 | 3 Telegram chat_ids → provider `csgateway` concurrent | Distinct correct replies; no cross-talk |
| F2 | 3 chats → `csgateway` / `openai-codex` / `deepseek` | Provider isolation; no auto-fallback |
| F3 | Same chat two messages | Strict serial order |
| F4 | WSL runner offline | `csgateway` errors clearly; Codex/DeepSeek still work |
| F5 | OpenCode Anthropic + OpenAI via Secure Adapter | Non-stream + SSE; 401/429 |
| F6 | Web E2EE session + Memory + pairing | Unchanged success path |
| F7 | Download latest zip via nginx `/releases/` | Auth OK; Node RSS delta ≤ 5 MiB |
| F8 | Report queued with interactive jobs | Interactive claimed first (priority) |

## Security

| ID | Case | Pass criteria |
| --- | --- | --- |
| S1 | Forged TLS to Secure Adapter | Fail closed on offline root |
| S2 | Mitmproxy on Runner hop | No prompt/response plaintext in proxy logs |
| S3 | DB inspection for csgateway hop | Only envelopes in `runs` for e2ee path |
| S4 | Replay / tamper / wrong Runner key | Rejected |
| S5 | Log scrub | No tokens, prompts, responses |

## Performance

| ID | Case | Pass criteria |
| --- | --- | --- |
| P1 | Node cold start ×20 | p95 listen < 3s |
| P2 | Idle 30m | Claim req/s ≤ 0.2; Node+PG CPU −≥50% vs baseline |
| P3 | 3 Telegram ×20 rounds | Hermes p95 RSS ≤ 420 MiB; Node p95 ≤ 160 MiB |
| P4 | Mixed 30m peak | Stack p95 ≤ 650 MiB; no OOM/restart |
| P5 | Soak 2h | No unbounded RSS growth |

## Commands

```bash
# Unit
npm run test -w @cursor-gateway/server
python3 apps/hermes-runner/telegram_provider_runtime.py

# Baseline on VPS (one-shot)
bash scripts/perf/baseline.sh ./var/perf-baseline

# Rolling host-load samples (systemd timer on vps-dmit; fail-open)
bash scripts/perf/sample-host-load.sh
# → ~/.local/state/hermes-ha/host-load/latest.json
```
