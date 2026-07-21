# Hermes production controls

These files mirror the non-secret controls deployed on `vps-dmit`.

## Session limits

Apply with the Hermes CLI, then restart only the corresponding idle VPS unit:

```bash
HERMES_HOME="$HOME/.hermes" \
  hermes config set gateway.max_concurrent_sessions 2

HERMES_HOME="$HOME/.hermes/profiles/telegram2" \
  hermes --profile telegram2 config set gateway.max_concurrent_sessions 1
```

The primary profile can run two chats concurrently; the secondary profile is
limited to one. Hermes returns an explicit active-session-limit response rather
than silently accumulating work.

## Memory isolation

Copy the matching drop-in directory under `~/.config/systemd/user/`, run
`systemctl --user daemon-reload`, and restart an idle unit. The `zz-` prefix is
intentional: it takes precedence over the older `override.conf` files deployed
on the host.

These are VPS service controls only. They do not install or enable any
Windows/WSL runner startup mechanism.
