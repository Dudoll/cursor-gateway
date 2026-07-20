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

test("canonical task is idempotent and removes all legacy launchers", () => {
  const powershell = readFileSync(
    join(scripts, "install-wsl-e2ee-supervisor.ps1"),
    "utf8"
  );
  assert.match(powershell, /CursorGatewayE2eeRunner/);
  assert.match(powershell, /MultipleInstances IgnoreNew/);
  assert.match(powershell, /Register-ScheduledTask.*-Force/s);
  for (const legacy of [
    "CursorGatewayWslRunner",
    "CursorGatewayWindowsRunner",
    "CursorGatewayWindowsRunnerWatchdog"
  ]) {
    assert.match(powershell, new RegExp(legacy));
  }
  assert.match(powershell, /Unregister-ScheduledTask.*-Confirm:\$false/);
  assert.doesNotMatch(powershell, /Disable-ScheduledTask/);
  assert.doesNotMatch(powershell, /Set-Content.*\.env|Out-File.*\.env/i);
});
