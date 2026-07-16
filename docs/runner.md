# Runner Setup

The runner executes Cursor agents against files on the machine where it runs.
Run it on the machine that owns the code you want Cursor to read or edit. It
works on Linux and WSL (the historical name "windows-runner" is kept for
package compatibility).

The runner only makes **outbound** HTTPS calls to the gateway. It does not open
any inbound port, so no firewall changes are needed.

## Prerequisites

- The gateway server is already deployed and reachable (see `docs/deploy.md`).
- You have:
  - the gateway URL (e.g. `https://gateway.example.com`)
  - the `RUNNER_SHARED_SECRET` configured on the server
  - a Cursor API key (create one at https://cursor.com)

Node.js is **not** required beforehand — the setup script installs Node 22 into
`~/.node22` automatically.

## Setup (3 steps)

```bash
git clone https://github.com/Dudoll/cursor-gateway.git
cd cursor-gateway

# 1) First run creates apps/windows-runner/.env
./apps/windows-runner/scripts/setup-runner.sh

# 2) Edit the config
nano apps/windows-runner/.env

# 3) Run again to install dependencies and build
./apps/windows-runner/scripts/setup-runner.sh
```

Minimum values to set in `apps/windows-runner/.env`:

```ini
GATEWAY_URL=https://gateway.example.com
RUNNER_SHARED_SECRET=<same 32+ char secret as the server>
RUNNER_WORKSPACES=/home/you/projects
CURSOR_API_KEY=crsr_xxx
```

`RUNNER_WORKSPACES` is a `;`-separated list of absolute directories the agent
may read and write. Only paths that exist are registered.

## Keep it running

### Linux with systemd

```bash
./apps/windows-runner/scripts/install-runner-service.sh
```

Manage it:

```bash
systemctl --user status cursor-gateway-runner
journalctl --user -u cursor-gateway-runner -f
systemctl --user disable --now cursor-gateway-runner   # stop
```

### WSL on Windows

WSL1 has no systemd, so use a Windows Scheduled Task that launches the runner at
boot and restarts it on crash. From an elevated PowerShell in the repo:

```powershell
powershell -ExecutionPolicy Bypass -File apps\windows-runner\scripts\install-wsl-runner-daemon.ps1
```

This registers `CursorGatewayWslRunner`, which runs
`apps/windows-runner/scripts/wsl-runner-daemon.sh` inside WSL. Logs:

```
~/cursor-vps/cursor-gateway/apps/windows-runner/logs/wsl-runner-daemon.log
```

The task runs as the WSL distro owner (S4U, so it starts whether or not the user
is logged on). After the first reboot, confirm it came back up by checking that
log or the dashboard.

Notes for WSL:
- Keep the project and its workspaces on the Linux filesystem (`~/...`) for best
  performance. Files under `/mnt/c` or `/mnt/d` work but are slower and do not
  deliver file-change (inotify) events.
- Windows-style paths in `RUNNER_WORKSPACES` (e.g. `D:\work`) are automatically
  mapped to `/mnt/d/work` when running on Linux.

## Verify

After the runner starts you should see, in its logs:

```
Heartbeat registered N workspaces and M models
```

Then in the dashboard the runner appears online with your workspaces and models.
Queue a read-only prompt against a workspace and confirm it goes
`queued -> running -> finished`.

## Updating

Pull the latest code and rebuild:

```bash
git pull
./apps/windows-runner/scripts/setup-runner.sh
# restart the service:
systemctl --user restart cursor-gateway-runner        # Linux
# or, on WSL, restart the scheduled task:
#   Stop-ScheduledTask/Start-ScheduledTask CursorGatewayWslRunner
```

## Security

- Run as a non-admin user whose filesystem permissions are limited to the
  directories in `RUNNER_WORKSPACES`. That is the real access boundary.
- `.env` holds secrets and is git-ignored; never commit it.
- Set `RUNNER_REQUIRE_APPROVAL=true` on the server if write-enabled runs must be
  approved from the dashboard before the runner can pick them up.

## End-to-end encryption (E2EE)

To run the runner as an E2EE endpoint (ciphertext-only relay through the VPS,
paired with the signed browser extension), enable it in
`apps/windows-runner/.env`:

```ini
RUNNER_E2EE_ENABLED=true
RUNNER_LEGACY_ENABLED=false
```

The runner keeps its HPKE/signing private keys, paired clients, and replay state
in a local state file (default `~/.cursor-gateway/runner-e2ee-state.dat`). On
Windows the file is DPAPI-protected. On Linux/WSL set
`RUNNER_E2EE_MASTER_KEY` or `RUNNER_E2EE_MASTER_KEY_FILE` (prefer a tmpfs path
such as `/dev/shm/cursor-gateway/runner-e2ee-master.key`) and use
`scripts/e2ee/` to passphrase-seal that key across reboots. Never copy the state
file, master key, or `*.enc` blob to the VPS, and never enable
`RUNNER_E2EE_ALLOW_INSECURE_DEV_STORAGE` in production.

Offline pairing (verify both fingerprints by hand):

```bash
# 1) Export the runner bundle and paste it into the signed extension
npm run pair:runner -w @cursor-gateway/windows-runner

# 2) Import the client bundle the extension shows back
npm run pair:client -w @cursor-gateway/windows-runner -- <client-bundle>
npm run pair:list -w @cursor-gateway/windows-runner

# Revoke a browser device
npm run pair:revoke -w @cursor-gateway/windows-runner -- <client-id>
```

See [`e2ee.md`](e2ee.md) for the full deployment order, key rotation, legacy
plaintext migration, and the security boundary.
