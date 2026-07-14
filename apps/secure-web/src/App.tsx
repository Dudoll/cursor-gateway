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
import { SecureGatewayClient, progressLabel, type DecryptedRun } from "./secureClient.js";
import type { E2eeConversationRecord, E2eeRunnerDirectoryEntry } from "@cursor-gateway/shared";

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
      const keys = await SecureWebKeyStore.open();
      const device = await keys.device();
      if (cancelled) return;
      setBoot({ kind: "ready", keys, device });
      if (device.pairedRunnerId) setStep(3);
    })().catch((error) => {
      if (!cancelled) {
        setBoot({ kind: "blocked", reason: errorText(error) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (boot.kind !== "ready" || !api) return;
    if (!parseMagicLinkFragment(window.location.hash)) return;
    let cancelled = false;
    setBusy(true);
    setStatus({ tone: "info", text: "Completing magic-link pairing…" });
    tryConsumeMagicLink({ api, keys: boot.keys })
      .then(async (result) => {
        if (cancelled || !result) return;
        setStatus({ tone: "ok", text: `Paired with runner ${result.runnerId}` });
        setRunnerId(result.runnerId);
        setStep(3);
        await refreshDirectory(api, boot.keys);
      })
      .catch((error) => {
        if (!cancelled) {
          setStatus({ tone: "error", text: `Pairing failed: ${errorText(error)}` });
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [boot, api]);

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
    if (device.pairedRunnerId) {
      setRunnerId(device.pairedRunnerId);
      setStep(3);
    } else if (directory[0]) {
      setRunnerId(directory[0].runnerId);
    }
  }

  async function onSaveGateway(event: FormEvent) {
    event.preventDefault();
    try {
      const origin = saveGatewayOrigin(gatewayInput);
      setGatewayInput(origin);
      setStatus({
        tone: "ok",
        text: `Gateway saved: ${origin}. Log in via Cloudflare Access on that origin if needed, then start pairing.`
      });
      setStep(2);
    } catch (error) {
      setStatus({ tone: "error", text: errorText(error) });
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
          `Pairing started (${started.pairId}).\n` +
          `Check email (or runner pairing-mail.log in dev) for the magic link.\n` +
          `Open the link in THIS browser. Expires ${started.expiresAt}.`
      });
      setStep(2);
    } catch (error) {
      setStatus({ tone: "error", text: `Start failed: ${errorText(error)}` });
    } finally {
      setBusy(false);
    }
  }

  async function onManualComplete() {
    if (boot.kind !== "ready" || !api) return;
    setBusy(true);
    try {
      const result = await completePairingFromFragment({ api, keys: boot.keys });
      setStatus({ tone: "ok", text: `Paired with runner ${result.runnerId}` });
      setRunnerId(result.runnerId);
      setStep(3);
      await refreshDirectory(api, boot.keys);
    } catch (error) {
      setStatus({ tone: "error", text: `Complete failed: ${errorText(error)}` });
    } finally {
      setBusy(false);
    }
  }

  async function onRefresh() {
    if (boot.kind !== "ready" || !api) return;
    setBusy(true);
    try {
      await refreshDirectory(api, boot.keys);
      setStatus({ tone: "ok", text: "Directory refreshed." });
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
      setStatus({ tone: "ok", text: `Submitted run ${run.id}` });
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
        <p className="lede">Checking WebCrypto + IndexedDB persistence…</p>
      </div>
    );
  }

  if (boot.kind === "blocked") {
    return (
      <div className="app">
        <h1 className="brand">Cursor Gateway Secure</h1>
        <div className="panel blocker">
          <h2>Device storage unavailable</h2>
          <p>
            This browser cannot keep non-exportable device keys (private / ephemeral mode,
            blocked storage, or insecure context). Open a normal HTTPS window and retry.
          </p>
          <div className="status error">{boot.reason}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <h1 className="brand">Cursor Gateway Secure</h1>
      <p className="lede">
        Cross-browser E2EE client. Keys stay non-exportable in this device. Gateway only relays
        ciphertext. Protocol: <code>cg-e2ee/1</code>.
      </p>

      <ol className="steps">
        <li className={step > 1 ? "done" : step === 1 ? "active" : ""}>
          <span className="n">1</span>
          <span>Configure Gateway origin (Cloudflare Access login)</span>
        </li>
        <li className={step > 2 ? "done" : step === 2 ? "active" : ""}>
          <span className="n">2</span>
          <span>Start pairing → open magic link from email</span>
        </li>
        <li className={step === 3 ? "active done" : ""}>
          <span className="n">3</span>
          <span>Chat with paired Runner over E2EE</span>
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
              Save origin
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={onRefresh}>
              Refresh directory
            </button>
          </div>
        </form>
        <p className="meta">
          Device clientId: <code>{boot.device.clientId}</code>
          {boot.device.pairedRunnerId ? (
            <>
              {" "}
              · paired runner: <code>{boot.device.pairedRunnerId}</code>
            </>
          ) : null}
        </p>
      </section>

      <section className="panel">
        <h2>2. Magic-link pairing</h2>
        <p className="meta">
          Token never leaves the URL fragment / Runner mail path. Gateway stores only public
          pairing metadata.
        </p>
        <div className="row">
          <button type="button" disabled={busy || !api} onClick={onStartPairing}>
            Start pairing
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || !api || !parseMagicLinkFragment(window.location.hash)}
            onClick={onManualComplete}
          >
            Complete from URL fragment
          </button>
        </div>
        {pairId ? (
          <p className="meta">
            Active pairId: <code>{pairId}</code>
          </p>
        ) : null}
      </section>

      <section className="panel">
        <h2>3. Encrypted chat</h2>
        {runners.length === 0 ? (
          <p className="meta">No runners advertised yet. Pair first, then refresh.</p>
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
                + New encrypted conversation
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
                  <div className="role">You</div>
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
                        Runner ({run.result.status})
                      </div>
                      <div>{run.result.response ?? run.result.error ?? "(no body)"}</div>
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
                placeholder="Encrypted prompt…"
                required
              />
              <label className="meta" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={allowWrites}
                  onChange={(event) => setAllowWrites(event.target.checked)}
                />
                Allow writes (requires signed approval)
              </label>
              <div className="row">
                <button type="submit" disabled={busy || !runnerId || !prompt.trim()}>
                  Send encrypted run
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
