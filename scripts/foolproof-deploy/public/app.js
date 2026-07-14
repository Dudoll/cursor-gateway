function cookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function apiBase() {
  // Works at / and under /deploy/
  const path = location.pathname;
  if (path.includes("/deploy")) {
    const idx = path.indexOf("/deploy");
    return `${path.slice(0, idx)}/deploy`;
  }
  return "";
}

async function api(path, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (init.body) headers["content-type"] = "application/json";
  const csrf = cookie("deploy_csrf");
  if (csrf && init.method && init.method !== "GET") {
    headers["x-csrf-token"] = csrf;
  }
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers,
    credentials: "same-origin"
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!response.ok) {
    const err = new Error(data.error || `http_${response.status}`);
    err.data = data;
    err.status = response.status;
    throw err;
  }
  return data;
}

const loginPanel = document.getElementById("login-panel");
const wizardPanel = document.getElementById("wizard-panel");
const loginError = document.getElementById("login-error");
const statusBox = document.getElementById("status-box");
const result = document.getElementById("result");
const downloadBox = document.getElementById("download-box");
const downloadLink = document.getElementById("download-link");

function showResult(data) {
  result.hidden = false;
  result.textContent = JSON.stringify(data, null, 2);
}

async function refreshStatus() {
  const data = await api("/api/deploy/status");
  const git = data.git || {};
  statusBox.textContent = [
    `auth: ${data.auth?.method}${data.auth?.email ? ` <${data.auth.email}>` : ""}`,
    `env: ${data.env?.exists ? "present" : "missing"}  origin=${data.env?.publicOrigin || "—"}`,
    `fingerprints: jwt=${data.env?.fingerprints?.jwtSecret || "—"} runner=${data.env?.fingerprints?.runnerSharedSecret || "—"}`,
    `git: ${git.branch || "?"} @ ${(git.head || "").slice(0, 8) || "?"}  origin/main=${(git.originMain || "").slice(0, 8) || "?"}  behind=${git.behindMain}`,
    `compose: ${data.compose?.summary || "—"}`,
    "",
    data.limits?.masterKeyUnseal || ""
  ].join("\n");

  if (data.env?.publicOrigin) {
    document.getElementById("public-origin").value = data.env.publicOrigin;
  }
  return data;
}

async function enterWizard() {
  loginPanel.hidden = true;
  wizardPanel.hidden = false;
  await refreshStatus();
}

document.getElementById("btn-login").addEventListener("click", async () => {
  loginError.hidden = true;
  try {
    const token = document.getElementById("bootstrap-token").value.trim();
    await api("/api/deploy/login", {
      method: "POST",
      body: JSON.stringify({ token })
    });
    await enterWizard();
  } catch (error) {
    // Cloudflare Access path: status may already work without bootstrap login
    try {
      await refreshStatus();
      await enterWizard();
      return;
    } catch {
      loginError.hidden = false;
      loginError.textContent = error.message || "登录失败";
    }
  }
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  await api("/api/deploy/logout", { method: "POST", body: "{}" });
  wizardPanel.hidden = true;
  loginPanel.hidden = false;
});

document.getElementById("btn-init").addEventListener("click", async () => {
  downloadBox.hidden = true;
  const body = {
    dryRun: document.getElementById("dry-run").checked,
    force: document.getElementById("force").checked,
    includeReality: document.getElementById("include-reality").checked,
    insecureDevInject: document.getElementById("insecure-dev").checked,
    publicOrigin: document.getElementById("public-origin").value.trim(),
    allowedEmails: document.getElementById("allowed-emails").value.trim(),
    workspaces: document.getElementById("workspaces").value.trim()
  };
  try {
    const data = await api("/api/deploy/initialize", {
      method: "POST",
      body: JSON.stringify(body)
    });
    showResult(data);
    if (data.download?.path) {
      downloadBox.hidden = false;
      downloadLink.href = `${apiBase()}${data.download.path}`;
    }
    if (!body.dryRun) await refreshStatus();
  } catch (error) {
    showResult(error.data || { error: error.message });
  }
});

async function sync(apply) {
  try {
    const data = await api("/api/deploy/sync", {
      method: "POST",
      body: JSON.stringify({ apply, dryRun: !apply, git: true, compose: true })
    });
    showResult(data);
    await refreshStatus();
  } catch (error) {
    showResult(error.data || { error: error.message });
  }
}

document.getElementById("btn-sync-dry").addEventListener("click", () => sync(false));
document.getElementById("btn-sync-apply").addEventListener("click", () => {
  if (!confirm("将 git ff-only 拉取并 docker compose up -d --build。确认？")) return;
  sync(true);
});

// Auto-enter if session or CF Access already valid
refreshStatus()
  .then(() => enterWizard())
  .catch(() => {
    /* stay on login */
  });
