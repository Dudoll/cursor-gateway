import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  GatewayApi,
  GatewayApiError,
  normalizeGatewayOrigin,
  saveGatewayOrigin,
  savedGatewayOrigin
} from "./api.js";
import {
  SecureWebKeyStore,
  detectIncompatibleStorage,
  parseMagicLinkFragment,
  requestPersistentStorage,
  type DeviceRecord
} from "./keyStore.js";
import {
  completePairingFromFragment,
  startPairing,
  tryConsumeMagicLink
} from "./pairing.js";
import {
  captureCsAuthRedirectParams,
  completeCsAuthReturn,
  formatCsAuthReturnError,
  loadPendingCsAuthRedirect
} from "./csAuthReturn.js";
import type { CsAuthRedirectParams } from "@cursor-gateway/e2ee";
import { SecureGatewayClient, progressLabel, type DecryptedRun } from "./secureClient.js";
import type { E2eeConversationRecord, E2eeRunnerDirectoryEntry } from "@cursor-gateway/shared";
import {
  E2EE_ACCESS_LOGOUT_CONFIRM,
  E2EE_LOGOUT_CONFIRM,
  E2EE_LOGOUT_DONE,
  E2EE_LOGOUT_LABEL,
  clearLocalE2eeAuthorization
} from "./e2eeLogout.js";

type BootState =
  | { kind: "loading" }
  | { kind: "blocked"; reason: string }
  | { kind: "ready"; keys: SecureWebKeyStore; device: DeviceRecord };

type Step = 1 | 2 | 3;

function errorText(error: unknown) {
  if (error instanceof GatewayApiError) return error.code;
  if (error instanceof Error) return error.message;
  return "unknown_error";
}

export function App() {
  const [boot, setBoot] = useState<BootState>({ kind: "loading" });
  const [gatewayInput, setGatewayInput] = useState(savedGatewayOrigin() || "https://gateway.example.com");
  const [status, setStatus] = useState<{ tone: "info" | "ok" | "warn" | "error"; text: string } | null>(
    null
  );
  const [pairId, setPairId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(1);
  const [runners, setRunners] = useState<E2eeRunnerDirectoryEntry[]>([]);
  const [conversations, setConversations] = useState<E2eeConversationRecord[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [runs, setRuns] = useState<DecryptedRun[]>([]);
  const [runnerId, setRunnerId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("default");
  const [model, setModel] = useState("auto");
  const [prompt, setPrompt] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [csAuthPending, setCsAuthPending] = useState<CsAuthRedirectParams | null>(null);
  const [cfAccessLogoutUrl, setCfAccessLogoutUrl] = useState<string | null>(null);

  const api = useMemo(() => {
    try {
      return new GatewayApi(normalizeGatewayOrigin(gatewayInput));
    } catch {
      return null;
    }
  }, [gatewayInput]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const reason = await detectIncompatibleStorage();
      if (cancelled) return;
      if (reason) {
        setBoot({ kind: "blocked", reason });
        return;
      }
      await requestPersistentStorage();
      const pendingCs = captureCsAuthRedirectParams();
      if (pendingCs && !cancelled) {
        setCsAuthPending(pendingCs);
        setStatus({
          tone: "info",
          text: "检测到 CS 设备授权请求。完成 Secure 配对后将签发一次性授权并返回 CS。"
        });
      }
      const keys = await SecureWebKeyStore.open();
      const device = await keys.device();
      if (cancelled) return;
      setBoot({ kind: "ready", keys, device });
      if (device.pairedRunnerId) setStep(3);
      const saved = savedGatewayOrigin();
      if (saved) {
        try {
          const clientApi = new GatewayApi(saved);
          const policy = await clientApi.get<{ cfAccessLogoutUrl?: string | null }>(
            "/api/e2ee-policy"
          );
          if (!cancelled && policy.cfAccessLogoutUrl) {
            setCfAccessLogoutUrl(policy.cfAccessLogoutUrl);
          }
        } catch {
          // Optional.
        }
      }
    })().catch((error) => {
      if (!cancelled) {
        setBoot({ kind: "blocked", reason: errorText(error) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function tryFinishCsAuth(
    clientApi: GatewayApi,
    keys: SecureWebKeyStore,
    params: CsAuthRedirectParams
  ): Promise<boolean> {
    setBusy(true);
    setStatus({ tone: "info", text: "正在向 Runner 请求 CS 设备授权包…" });
    try {
      const { returnUrl } = await completeCsAuthReturn({
        api: clientApi,
        keys,
        params
      });
      setCsAuthPending(null);
      setStatus({ tone: "ok", text: "授权已签发，正在返回 CS…" });
      // replace：避免用户再按返回键停在 Secure 聊天页。
      window.location.replace(returnUrl);
      return true;
    } catch (error) {
      setStatus({ tone: "error", text: formatCsAuthReturnError(error) });
      setBusy(false);
      return false;
    }
  }

  /** After pairing: if CS return context exists, must grant+redirect (never stay on Secure chat). */
  async function finishPairingThenMaybeReturnToCs(
    clientApi: GatewayApi,
    keys: SecureWebKeyStore,
    runnerIdValue: string
  ) {
    setStatus({ tone: "ok", text: `已与 Runner ${runnerIdValue} 配对` });
    setRunnerId(runnerIdValue);
    setStep(3);
    await refreshDirectory(clientApi, keys);
    const pending = csAuthPending ?? loadPendingCsAuthRedirect();
    if (!pending) return;
    setCsAuthPending(pending);
    await tryFinishCsAuth(clientApi, keys, pending);
  }

  useEffect(() => {
    if (boot.kind !== "ready" || !api) return;
    if (!parseMagicLinkFragment(window.location.hash)) return;
    let cancelled = false;
    setBusy(true);
    setStatus({ tone: "info", text: "正在完成 magic-link 配对…" });
    tryConsumeMagicLink({ api, keys: boot.keys })
      .then(async (result) => {
        if (cancelled || !result) return;
        await finishPairingThenMaybeReturnToCs(api, boot.keys, result.runnerId);
      })
      .catch((error) => {
        if (!cancelled) {
          setStatus({ tone: "error", text: `配对失败：${errorText(error)}` });
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [boot, api]);

  // Already paired + pending CS auth (e.g. return from a prior session).
  useEffect(() => {
    if (boot.kind !== "ready" || !api || !csAuthPending) return;
    if (!boot.device.pairedRunnerId) return;
    if (parseMagicLinkFragment(window.location.hash)) return;
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await tryFinishCsAuth(api, boot.keys, csAuthPending);
    })();
    return () => {
      cancelled = true;
    };
  }, [boot, api, csAuthPending]);

  async function refreshDirectory(clientApi: GatewayApi, keys: SecureWebKeyStore) {
    const client = new SecureGatewayClient(clientApi, keys);
    const [directory, list] = await Promise.all([client.runners(), client.conversations()]);
    setRunners(directory);
    setConversations(list);
    const nextTitles: Record<string, string> = {};
    for (const conversation of list) {
      nextTitles[conversation.id] = await client.title(conversation);
    }
    setTitles(nextTitles);
    const device = await keys.device();
    const preferredRunnerId = device.pairedRunnerId ?? directory[0]?.runnerId;
    if (preferredRunnerId) {
      setRunnerId(preferredRunnerId);
      if (device.pairedRunnerId) setStep(3);
      const preferred = directory.find((runner) => runner.runnerId === preferredRunnerId);
      const firstWorkspace = preferred?.workspaces[0]?.id;
      if (firstWorkspace && preferred) {
        setWorkspaceId((current) =>
          preferred.workspaces.some((item) => item.id === current) ? current : firstWorkspace
        );
      }
    }
  }

  async function onSaveGateway(event: FormEvent) {
    event.preventDefault();
    try {
      const origin = saveGatewayOrigin(gatewayInput);
      setGatewayInput(origin);
      setStatus({
        tone: "ok",
        text: `Gateway 已保存：${origin}。如需请先在该 origin 完成 Cloudflare Access 登录，再开始配对。`
      });
      setStep(2);
      try {
        const clientApi = new GatewayApi(origin);
        const policy = await clientApi.get<{
          cfAccessLogoutUrl?: string | null;
        }>("/api/e2ee-policy");
        if (policy.cfAccessLogoutUrl) setCfAccessLogoutUrl(policy.cfAccessLogoutUrl);
      } catch {
        // Policy is optional for logout link.
      }
    } catch (error) {
      setStatus({ tone: "error", text: errorText(error) });
    }
  }

  async function onLogoutE2ee() {
    if (boot.kind !== "ready") return;
    if (!window.confirm(E2EE_LOGOUT_CONFIRM)) return;
    setBusy(true);
    try {
      await clearLocalE2eeAuthorization({
        api,
        keys: boot.keys,
        clientId: boot.device.clientId
      });
      setPairId(null);
      setRunners([]);
      setConversations([]);
      setTitles({});
      setActiveConversationId(null);
      setRuns([]);
      setRunnerId("");
      setCsAuthPending(null);
      setStep(1);
      const keys = await SecureWebKeyStore.open();
      const device = await keys.device();
      setBoot({ kind: "ready", keys, device });
      setStatus({ tone: "ok", text: E2EE_LOGOUT_DONE });
      window.alert(E2EE_LOGOUT_DONE);
      if (cfAccessLogoutUrl && window.confirm(E2EE_ACCESS_LOGOUT_CONFIRM)) {
        try {
          const url = new URL(cfAccessLogoutUrl);
          if (api?.origin) url.searchParams.set("returnTo", api.origin);
          window.open(url.toString(), "_blank", "noopener,noreferrer");
        } catch {
          window.open(cfAccessLogoutUrl, "_blank", "noopener,noreferrer");
        }
      }
    } catch (error) {
      setStatus({ tone: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  async function onStartPairing() {
    if (boot.kind !== "ready" || !api) return;
    setBusy(true);
    try {
      saveGatewayOrigin(gatewayInput);
      const started = await startPairing({ api, keys: boot.keys });
      setPairId(started.pairId);
      setStatus({
        tone: "warn",
        text:
          `配对已开始（${started.pairId}）。\n` +
          `请查收邮件中的 magic link，并尽量用**本浏览器**打开（勿仅用 Gmail App 内置浏览器，以免设备密钥不一致）。\n` +
          `回跳 CS 的上下文已保存在本站；同浏览器其它标签完成配对后也会自动返回 CS。\n` +
          `过期时间：${started.expiresAt}。`
      });
      setStep(2);
    } catch (error) {
      setStatus({ tone: "error", text: `启动配对失败：${errorText(error)}` });
    } finally {
      setBusy(false);
    }
  }

  async function onManualComplete() {
    if (boot.kind !== "ready" || !api) return;
    setBusy(true);
    try {
      const result = await completePairingFromFragment({ api, keys: boot.keys });
      await finishPairingThenMaybeReturnToCs(api, boot.keys, result.runnerId);
    } catch (error) {
      setStatus({ tone: "error", text: `完成配对失败：${errorText(error)}` });
    } finally {
      setBusy(false);
    }
  }

  async function onRefresh() {
    if (boot.kind !== "ready" || !api) return;
    setBusy(true);
    try {
      await refreshDirectory(api, boot.keys);
      setStatus({ tone: "ok", text: "目录已刷新。" });
    } catch (error) {
      setStatus({ tone: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  async function openConversation(id: string) {
    if (boot.kind !== "ready" || !api) return;
    setBusy(true);
    try {
      const client = new SecureGatewayClient(api, boot.keys);
      const decrypted = await client.runs(id);
      setActiveConversationId(id);
      setRuns(decrypted);
    } catch (error) {
      setStatus({ tone: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitRun(event: FormEvent) {
    event.preventDefault();
    if (boot.kind !== "ready" || !api) return;
    setBusy(true);
    try {
      const client = new SecureGatewayClient(api, boot.keys);
      const run = await client.submitRun({
        runnerId,
        workspaceId,
        model,
        prompt,
        allowWrites,
        ...(activeConversationId ? { conversationId: activeConversationId } : {})
      });
      setPrompt("");
      setActiveConversationId(run.conversationId);
      await refreshDirectory(api, boot.keys);
      await openConversation(run.conversationId);
      setStatus({ tone: "ok", text: `已提交 run ${run.id}` });
    } catch (error) {
      setStatus({ tone: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  if (boot.kind === "loading") {
    return (
      <div className="app">
        <h1 className="brand">Cursor Gateway Secure</h1>
        <p className="lede">正在检查 WebCrypto 与 IndexedDB 持久化…</p>
      </div>
    );
  }

  if (boot.kind === "blocked") {
    return (
      <div className="app">
        <h1 className="brand">Cursor Gateway Secure</h1>
        <div className="panel blocker">
          <h2>设备存储不可用</h2>
          <p>
            当前浏览器无法保存不可导出的设备密钥（隐私 / 临时模式、存储被拦截，或不安全上下文）。
            请使用普通 HTTPS 窗口重试。
          </p>
          <div className="status error">{boot.reason}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-top">
        <div>
          <h1 className="brand">Cursor Gateway Secure</h1>
          <p className="lede">
            跨浏览器 E2EE 客户端。密钥以不可导出形式保存在本设备。Gateway 仅中继密文。协议：
            <code>cg-e2ee/1</code>。
          </p>
        </div>
      </header>

      <ol className="steps">
        <li className={step > 1 ? "done" : step === 1 ? "active" : ""}>
          <span className="n">1</span>
          <span>配置 Gateway origin（Cloudflare Access 登录）</span>
        </li>
        <li className={step > 2 ? "done" : step === 2 ? "active" : ""}>
          <span className="n">2</span>
          <span>开始配对 → 打开邮件中的 magic link</span>
        </li>
        <li className={step === 3 ? "active done" : ""}>
          <span className="n">3</span>
          <span>与已配对 Runner 进行 E2EE 聊天</span>
        </li>
      </ol>

      <section className="panel">
        <h2>1. Gateway</h2>
        <form onSubmit={onSaveGateway}>
          <label htmlFor="gateway">Gateway HTTPS origin</label>
          <input
            id="gateway"
            value={gatewayInput}
            onChange={(event) => setGatewayInput(event.target.value)}
            placeholder="https://gateway.example.com"
            autoComplete="url"
          />
          <div className="row">
            <button type="submit" disabled={busy}>
              保存 origin
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={onRefresh}>
              刷新目录
            </button>
          </div>
        </form>
        <p className="meta">
          设备 clientId：<code>{boot.device.clientId}</code>
          {boot.device.pairedRunnerId ? (
            <>
              {" "}
              · 已配对 runner：<code>{boot.device.pairedRunnerId}</code>
              {" · "}
              <button
                type="button"
                className="logout-quiet logout-in-meta"
                disabled={busy}
                onClick={onLogoutE2ee}
                title="清除本机设备密钥与配对，便于反复测试"
              >
                {E2EE_LOGOUT_LABEL}
              </button>
            </>
          ) : null}
        </p>
      </section>

      <section className="panel">
        <h2>2. Magic-link 配对</h2>
        <p className="meta">
          Token 不会离开 URL fragment / Runner 邮件路径。Gateway 仅存储公开配对元数据。手机请尽量用同一浏览器打开邮件链接；Gmail App
          可能另开标签，但 CS 回跳上下文已持久化到本站存储。
        </p>
        <div className="row">
          <button type="button" disabled={busy || !api} onClick={onStartPairing}>
            开始配对
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || !api || !parseMagicLinkFragment(window.location.hash)}
            onClick={onManualComplete}
          >
            从 URL fragment 完成配对
          </button>
        </div>
        {pairId ? (
          <p className="meta">
            当前 pairId：<code>{pairId}</code>
          </p>
        ) : null}
      </section>

      <section className="panel">
        <h2>3. 加密聊天</h2>
        {runners.length === 0 ? (
          <p className="meta">尚无 Runner。请先完成配对，再刷新目录。</p>
        ) : (
          <>
            <label htmlFor="runner">Runner</label>
            <select
              id="runner"
              value={runnerId}
              onChange={(event) => setRunnerId(event.target.value)}
            >
              {runners.map((runner) => (
                <option key={runner.runnerId} value={runner.runnerId}>
                  {runner.runnerId}
                </option>
              ))}
            </select>
            <div className="row" style={{ marginTop: 12 }}>
              <div style={{ flex: 1, minWidth: 160 }}>
                <label htmlFor="workspace">Workspace ID</label>
                <input
                  id="workspace"
                  value={workspaceId}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                />
              </div>
              <div style={{ flex: 1, minWidth: 120 }}>
                <label htmlFor="model">Model</label>
                <input
                  id="model"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                />
              </div>
            </div>

            <div className="conv-list">
              <button
                type="button"
                className="conv-item"
                onClick={() => {
                  setActiveConversationId(null);
                  setRuns([]);
                }}
              >
                + 新建加密会话
              </button>
              {conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  className="conv-item"
                  onClick={() => openConversation(conversation.id)}
                >
                  {titles[conversation.id] ?? conversation.id}
                </button>
              ))}
            </div>

            <div className="messages">
              {runs.map((run) => (
                <div key={run.record.id} className="msg">
                  <div className="role">你</div>
                  <div>{run.request.prompt}</div>
                  {run.progress && !run.result ? (
                    <>
                      <div className="role" style={{ marginTop: 8 }}>
                        Runner
                      </div>
                      <div>{progressLabel(run.progress.progressKind)}</div>
                    </>
                  ) : null}
                  {run.result ? (
                    <>
                      <div className="role" style={{ marginTop: 8 }}>
                        Runner（{run.result.status}）
                      </div>
                      <div>{run.result.response ?? run.result.error ?? "（无正文）"}</div>
                    </>
                  ) : null}
                </div>
              ))}
            </div>

            <form onSubmit={onSubmitRun}>
              <label htmlFor="prompt">Prompt</label>
              <textarea
                id="prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="加密 Prompt…"
                required
              />
              <label className="meta" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={allowWrites}
                  onChange={(event) => setAllowWrites(event.target.checked)}
                />
                允许写入（需签名审批）
              </label>
              <div className="row">
                <button type="submit" disabled={busy || !runnerId || !prompt.trim()}>
                  发送加密 run
                </button>
              </div>
            </form>
          </>
        )}
      </section>

      {status ? <div className={`status ${status.tone === "info" ? "" : status.tone}`}>{status.text}</div> : null}
    </div>
  );
}
