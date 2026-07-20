import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, "../scripts");

test("canonical WSL supervisor is single-instance and waits safely for unseal", () => {
  const shell = readFileSync(join(scripts, "wsl-e2ee-supervisor.sh"), "utf8");
  assert.match(shell, /flock -n/);
  assert.match(shell, /runner-e2ee-master\.key/);
  assert.match(shell, /e2ee-wait-unseal\.sh/);
  assert.match(shell, /run-e2ee-runner\.sh/);
  assert.match(shell, /runner_is_active/);
  assert.doesNotMatch(shell, /E2EE_MASTER_PASSPHRASE\s*=/);
  assert.doesNotMatch(shell, />\s*.*\.env/);
});

test("Windows scripts enforce manual-only startup", () => {
  const remover = readFileSync(
    join(scripts, "remove-windows-runner-autostart.ps1"),
    "utf8"
  );
  for (const taskName of [
    "CursorGatewayE2eeRunner",
    "CursorGatewayWslRunner",
    "CursorGatewayWindowsRunner",
    "CursorGatewayWindowsRunnerWatchdog"
  ]) {
    assert.match(remover, new RegExp(taskName));
  }
  assert.match(remover, /Unregister-ScheduledTask.*-Confirm:\$false/);

  for (const installer of [
    "install-wsl-e2ee-supervisor.ps1",
    "install-wsl-runner-daemon.ps1",
    "install-runner-daemon.ps1"
  ]) {
    const powershell = readFileSync(join(scripts, installer), "utf8");
    assert.match(powershell, /remove-windows-runner-autostart\.ps1/);
    assert.doesNotMatch(powershell, /Register-ScheduledTask/);
    assert.doesNotMatch(powershell, /New-ScheduledTaskTrigger/);
    assert.doesNotMatch(powershell, /-AtLogOn|-AtStartup/);
    assert.doesNotMatch(powershell, /Set-Content.*\.env|Out-File.*\.env/i);
  }

  const manualStart = readFileSync(
    join(scripts, "start-wsl-e2ee-runner.ps1"),
    "utf8"
  );
  assert.match(manualStart, /Start-Process/);
  assert.match(manualStart, /AutoStartEnabled\s*=\s*\$false/);
  assert.doesNotMatch(manualStart, /Register-ScheduledTask|New-ScheduledTaskTrigger/);
});
