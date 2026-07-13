import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Download,
  KeyRound,
  LockKeyhole,
  LogIn,
  MessageSquarePlus,
  RefreshCw,
  Send,
  ShieldAlert,
  Upload
} from "lucide-react";
import type {
  E2eeConversationRecord,
  E2eeRunnerDirectoryEntry
} from "@cursor-gateway/shared";
import {
  GatewayApi,
  GatewayApiError,
  normalizeGatewayOrigin,
  openGatewayLogin,
  requestGatewayPermission,
  saveGatewayOrigin,
  savedGatewayOrigin
} from "./api.js";
import {
  decodeRunnerPairingBundle,
  encodePairingBundle,
  SecureKeyStore,
  type LegacyArchivePayload,
  type LegacyArchiveRecord,
  type RunnerPin
} from "./keyStore.js";
import {
  progressLabel,
  SecureGatewayClient,
  type DecryptedMemory,
  type DecryptedRun
} from "./secureClient.js";

type ConversationView = {
  record: E2eeConversationRecord;
  title: string;
};

function safeError(error: unknown) {
  if (error instanceof GatewayApiError) return `${error.status}: ${error.code}`;
  if (error instanceof Error && /^[A-Za-z0-9 _.:()-]{1,180}$/.test(error.message)) {
    return error.message;
  }
  return "operation_failed";
}

export default function App() {
  const [gatewayInput, setGatewayInput] = useState(savedGatewayOrigin());
  const [gatewayOrigin, setGatewayOrigin] = useState(savedGatewayOrigin());
  const [keys, setKeys] = useState<SecureKeyStore>();
  const [client, setClient] = useState<SecureGatewayClient>();
  const [principal, setPrincipal] = useState("");
  const [runners, setRunners] = useState<E2eeRunnerDirectoryEntry[]>([]);
  const [pins, setPins] = useState<RunnerPin[]>([]);
  const [pairingInput, setPairingInput] = useState("");
  const [clientPairing, setClientPairing] = useState("");
  const [selectedRunnerId, setSelectedRunnerId] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [selectedModel, setSelectedModel] = useState("auto");
  const [conversations, setConversations] = useState<ConversationView[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [runs, setRuns] = useState<DecryptedRun[]>([]);
  const [memories, setMemories] = useState<DecryptedMemory[]>([]);
  const [prompt, setPrompt] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);
  const [memoryInput, setMemoryInput] = useState("");
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupInput, setBackupInput] = useState("");
  const [legacyArchives, setLegacyArchives] = useState<LegacyArchiveRecord[]>([]);
  const [legacyPreview, setLegacyPreview] = useState<LegacyArchivePayload>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const selectedRunner = runners.find((runner) => runner.runnerId === selectedRunnerId);
  const selectedPin = pins.find((pin) => pin.runnerId === selectedRunnerId);
  const runnerTrusted =
    Boolean(selectedRunner && selectedPin) &&
    selectedRunner!.e2ee.encryptionKey.fingerprint ===
      selectedPin!.encryptionKey.fingerprint &&
    selectedRunner!.e2ee.signingKey.fingerprint === selectedPin!.signingKey.fingerprint;

  const workspace = selectedRunner?.workspaces.find(
    (item) => item.id === selectedWorkspaceId
  );
  const availableModels = useMemo(
    () => [
      { id: "auto", displayName: "Auto" },
      ...(selectedRunner?.models.filter((model) => model.id !== "auto") ?? [])
    ],
    [selectedRunner]
  );

  useEffect(() => {
    void SecureKeyStore.open()
      .then(async (store) => {
        setKeys(store);
        setPins(await store.runners());
        setLegacyArchives(await store.legacyArchiveRecords());
        setClientPairing(encodePairingBundle(await store.clientPairingBundle()));
      })
      .catch((cause) => setError(safeError(cause)));
  }, []);

  useEffect(() => {
    if (!keys || !gatewayOrigin) return;
    setClient(new SecureGatewayClient(new GatewayApi(gatewayOrigin), keys));
  }, [gatewayOrigin, keys]);

  async function refreshDashboard(targetClient = client) {
    if (!targetClient) return;
    setError("");
    const [runnerList, conversationList, pinList, me] = await Promise.all([
      targetClient.runners(),
      targetClient.conversations(),
      targetClient.keys.runners(),
      targetClient.api.get<{
        principal?: { email?: string; displayName?: string };
      }>("/api/me")
    ]);
    const views = await Promise.all(
      conversationList.map(async (record) => ({
        record,
        title: await targetClient.title(record)
      }))
    );
    setRunners(runnerList);
    setPins(pinList);
    setConversations(views);
    setPrincipal(me.principal?.displayName ?? me.principal?.email ?? "Authenticated user");

    const preferredRunner =
      selectedRunnerId || pinList.find((pin) => runnerList.some((r) => r.runnerId === pin.runnerId))?.runnerId;
    if (preferredRunner) {
      setSelectedRunnerId(preferredRunner);
      const advertised = runnerList.find((runner) => runner.runnerId === preferredRunner);
      if (advertised && !advertised.workspaces.some((item) => item.id === selectedWorkspaceId)) {
        setSelectedWorkspaceId(advertised.workspaces[0]?.id ?? "");
      }
    }
    setStatus("Secure API connected");
  }

  async function refreshConversation(targetClient = client) {
    if (!targetClient || !selectedConversationId) {
      setRuns([]);
      return;
    }
    try {
      setRuns(await targetClient.runs(selectedConversationId));
    } catch (cause) {
      setError(safeError(cause));
    }
  }

  async function refreshMemory(targetClient = client) {
    if (!targetClient || !selectedWorkspaceId) return;
    try {
      setMemories(await targetClient.memory(selectedWorkspaceId));
    } catch (cause) {
      setError(safeError(cause));
    }
  }

  useEffect(() => {
    void refreshConversation();
    const timer = window.setInterval(() => void refreshConversation(), 4_000);
    return () => window.clearInterval(timer);
  }, [client, selectedConversationId]);

  useEffect(() => {
    void refreshMemory();
  }, [client, selectedWorkspaceId]);

  async function configureGateway(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const origin = normalizeGatewayOrigin(gatewayInput);
      if (!(await requestGatewayPermission(origin))) {
        throw new Error("Gateway host permission was not granted");
      }
      saveGatewayOrigin(origin);
      setGatewayOrigin(origin);
      const nextClient = keys
        ? new SecureGatewayClient(new GatewayApi(origin), keys)
        : undefined;
      if (nextClient) {
        setClient(nextClient);
        await refreshDashboard(nextClient);
      }
    } catch (cause) {
      setError(safeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function pairRunner(event: FormEvent) {
    event.preventDefault();
    if (!keys) return;
    setBusy(true);
    setError("");
    try {
      const pin = await keys.importRunner(decodeRunnerPairingBundle(pairingInput));
      setPins(await keys.runners());
      setSelectedRunnerId(pin.runnerId);
      setPairingInput("");
      setStatus(`Pinned runner ${pin.runnerId}; now import the client bundle on that Runner`);
      await refreshDashboard();
    } catch (cause) {
      setError(safeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submitRun(event: FormEvent) {
    event.preventDefault();
    if (!client || !prompt.trim() || !selectedRunnerId || !selectedWorkspaceId) return;
    if (!runnerTrusted) {
      setError("Runner fingerprint is not pinned or does not match");
      return;
    }
    if (
      allowWrites &&
      !window.confirm(
        "This signed request authorizes the local Cursor agent to modify files in the selected workspace."
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const run = await client.submitRun({
        runnerId: selectedRunnerId,
        workspaceId: selectedWorkspaceId,
        model: selectedModel,
        prompt: prompt.trim(),
        allowWrites,
        ...(selectedConversationId
          ? { conversationId: selectedConversationId }
          : {})
      });
      setPrompt("");
      setAllowWrites(false);
      setSelectedConversationId(run.conversationId);
      await refreshDashboard();
      await refreshConversation();
    } catch (cause) {
      setError(safeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function addMemory(event: FormEvent) {
    event.preventDefault();
    if (!client || !memoryInput.trim() || !selectedWorkspaceId) return;
    setBusy(true);
    setError("");
    try {
      await client.addMemory({
        content: memoryInput.trim(),
        scope: "workspace",
        workspaceId: selectedWorkspaceId
      });
      setMemoryInput("");
      await refreshMemory();
    } catch (cause) {
      setError(safeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function exportBackup() {
    if (!keys) return;
    setBusy(true);
    setError("");
    try {
      const backup = await keys.exportBackup(backupPassphrase);
      const blob = new Blob([backup], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `cursor-gateway-e2ee-${new Date().toISOString().slice(0, 10)}.backup`;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus("Encrypted key backup exported");
    } catch (cause) {
      setError(safeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function importBackup() {
    if (!keys || !backupInput.trim()) return;
    setBusy(true);
    setError("");
    try {
      await keys.importBackup(backupInput, backupPassphrase);
      setPins(await keys.runners());
      setLegacyArchives(await keys.legacyArchiveRecords());
      setClientPairing(encodePairingBundle(await keys.clientPairingBundle()));
      setBackupInput("");
      setStatus("Encrypted key backup restored");
      await refreshDashboard();
    } catch (cause) {
      setError(safeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function migrateLegacyData() {
    if (!client || !keys || backupPassphrase.length < 12) return;
    if (
      !window.confirm(
        "The extension will archive current plaintext conversations locally, copy plaintext Memory into E2EE records, then scrub online plaintext columns. Existing backups and WAL cannot be made retroactively secret."
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await client.archiveAndScrubLegacyData();
      setLegacyArchives(await keys.legacyArchiveRecords());
      const backup = await keys.exportBackup(backupPassphrase);
      const blob = new Blob([backup], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `cursor-gateway-e2ee-${new Date().toISOString().slice(0, 10)}.backup`;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus(
        `Archived and scrubbed ${result.scrubbed.conversations} conversations, ${result.scrubbed.runs} runs, and ${result.scrubbed.memory} Memory records`
      );
      await refreshDashboard();
      await refreshMemory();
    } catch (cause) {
      setError(safeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header>
        <div>
          <p className="eyebrow">SIGNED EXTENSION ORIGIN</p>
          <h1><LockKeyhole size={25} /> Cursor Gateway Secure</h1>
        </div>
        <div className={`trust-pill ${runnerTrusted ? "trusted" : ""}`}>
          {runnerTrusted ? <CheckCircle2 size={16} /> : <ShieldAlert size={16} />}
          {runnerTrusted ? "Runner fingerprint verified" : "Runner not yet trusted"}
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}
      {status && <div className="banner status">{status}</div>}

      <section className="setup-grid">
        <form className="panel" onSubmit={configureGateway}>
          <h2>1. Gateway connection</h2>
          <label>
            HTTPS origin
            <input
              value={gatewayInput}
              onChange={(event) => setGatewayInput(event.target.value)}
              placeholder="https://gateway.example.com"
            />
          </label>
          <div className="button-row">
            <button disabled={busy || !gatewayInput.trim()}><KeyRound size={16} /> Authorize</button>
            <button
              type="button"
              className="secondary"
              disabled={!gatewayInput.trim()}
              onClick={() => void openGatewayLogin(gatewayInput)}
            >
              <LogIn size={16} /> Cloudflare login
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!client}
              onClick={() => void refreshDashboard()}
            >
              <RefreshCw size={16} /> Refresh
            </button>
          </div>
          {principal && <small>Identity: {principal}</small>}
        </form>

        <form className="panel" onSubmit={pairRunner}>
          <h2>2. Offline Runner pairing</h2>
          <label>
            Paste the bundle printed locally by the Runner
            <textarea
              value={pairingInput}
              onChange={(event) => setPairingInput(event.target.value)}
              rows={3}
              spellCheck={false}
            />
          </label>
          <button disabled={busy || !pairingInput.trim()}><KeyRound size={16} /> Pin fingerprints</button>
          <label>
            Client bundle to import locally on the Runner
            <textarea value={clientPairing} readOnly rows={3} spellCheck={false} />
          </label>
        </form>

        <div className="panel">
          <h2>3. Encrypted key backup</h2>
          <label>
            Passphrase (minimum 12 characters)
            <input
              type="password"
              value={backupPassphrase}
              onChange={(event) => setBackupPassphrase(event.target.value)}
            />
          </label>
          <div className="button-row">
            <button
              type="button"
              disabled={busy || backupPassphrase.length < 12}
              onClick={() => void exportBackup()}
            >
              <Download size={16} /> Export
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || backupPassphrase.length < 12 || !backupInput.trim()}
              onClick={() => void importBackup()}
            >
              <Upload size={16} /> Restore
            </button>
          </div>
          <textarea
            value={backupInput}
            onChange={(event) => setBackupInput(event.target.value)}
            placeholder="Paste an encrypted backup here to restore"
            rows={2}
            spellCheck={false}
          />
          <button
            type="button"
            className="secondary migration-button"
            disabled={busy || !client || backupPassphrase.length < 12}
            onClick={() => void migrateLegacyData()}
          >
            <LockKeyhole size={16} /> Archive &amp; scrub legacy plaintext
          </button>
          <small>
            {legacyArchives.length === 0
              ? "No local legacy archives."
              : `${legacyArchives.length} encrypted local archive(s), ${legacyArchives.reduce(
                  (count, archive) => count + archive.runCount,
                  0
                )} archived runs.`}
          </small>
          {legacyArchives.map((archive) => (
            <button
              key={archive.id}
              type="button"
              className="secondary"
              onClick={() => {
                if (!keys) return;
                void keys
                  .legacyArchive(archive.id)
                  .then(setLegacyPreview)
                  .catch((cause) => setError(safeError(cause)));
              }}
            >
              View archive from {new Date(archive.createdAt).toLocaleString()}
            </button>
          ))}
        </div>
      </section>

      {legacyPreview ? (
        <section className="panel legacy-preview">
          <div className="aside-heading">
            <h2>Locally encrypted legacy archive</h2>
            <button className="secondary" onClick={() => setLegacyPreview(undefined)}>
              Close
            </button>
          </div>
          {legacyPreview.conversations.map(({ conversation, runs: legacyRuns }) => (
            <details key={conversation.id}>
              <summary>{conversation.title ?? conversation.id}</summary>
              {legacyRuns.map((run) => (
                <article key={run.id} className="legacy-turn">
                  <strong>User</strong>
                  <p>{run.prompt}</p>
                  <strong>Assistant</strong>
                  <p>{run.response ?? run.error ?? run.status}</p>
                </article>
              ))}
            </details>
          ))}
        </section>
      ) : null}

      <div className="workspace">
        <aside>
          <div className="aside-heading">
            <h2>Conversations</h2>
            <button
              className="icon-button"
              title="New encrypted conversation"
              onClick={() => {
                setSelectedConversationId("");
                setRuns([]);
              }}
            >
              <MessageSquarePlus size={18} />
            </button>
          </div>
          {conversations.map((conversation) => (
            <button
              key={conversation.record.id}
              className={`conversation ${
                selectedConversationId === conversation.record.id ? "active" : ""
              }`}
              onClick={() => setSelectedConversationId(conversation.record.id)}
            >
              <strong>{conversation.title}</strong>
              <small>{conversation.record.runCount} encrypted runs</small>
            </button>
          ))}
          {conversations.length === 0 && <p className="muted">No encrypted conversations.</p>}

          <div className="memory-panel">
            <h2>Encrypted workspace memory</h2>
            {memories.map((memory) => (
              <div className="memory" key={memory.record.id}>{memory.content}</div>
            ))}
            <form onSubmit={addMemory}>
              <textarea
                value={memoryInput}
                onChange={(event) => setMemoryInput(event.target.value)}
                placeholder="Add memory"
                rows={2}
              />
              <button disabled={busy || !memoryInput.trim() || !selectedWorkspaceId}>
                Add encrypted memory
              </button>
            </form>
          </div>
        </aside>

        <main>
          <div className="controls">
            <label>
              Paired Runner
              <select
                value={selectedRunnerId}
                onChange={(event) => {
                  setSelectedRunnerId(event.target.value);
                  setSelectedWorkspaceId("");
                }}
              >
                <option value="">Select</option>
                {pins.map((pin) => (
                  <option key={pin.runnerId} value={pin.runnerId}>{pin.runnerId}</option>
                ))}
              </select>
            </label>
            <label>
              Workspace
              <select
                value={selectedWorkspaceId}
                onChange={(event) => setSelectedWorkspaceId(event.target.value)}
              >
                <option value="">Select</option>
                {selectedRunner?.workspaces.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </label>
            <label>
              Model
              <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}>
                {availableModels.map((model) => (
                  <option key={model.id} value={model.id}>{model.displayName ?? model.id}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="transcript">
            {runs.map((run) => (
              <article key={run.record.id} className="turn">
                <div className="message user">
                  <div className="message-label">YOU · VERIFIED CLIENT SIGNATURE</div>
                  <div>{run.request.prompt}</div>
                </div>
                {run.result ? (
                  <div className={`message assistant ${run.result.status === "error" ? "failed" : ""}`}>
                    <div className="message-label">CURSOR RUNNER · VERIFIED E2EE</div>
                    <div>{run.result.response ?? run.result.error ?? run.result.status}</div>
                  </div>
                ) : run.progress ? (
                  <div className="message assistant progress">
                    <div className="message-label">{progressLabel(run.progress.progressKind)}</div>
                    <div>{run.progress.message}</div>
                  </div>
                ) : (
                  <div className="message assistant progress">Queued as encrypted payload…</div>
                )}
              </article>
            ))}
            {runs.length === 0 && (
              <div className="empty-state">
                <LockKeyhole size={38} />
                <h2>Start an encrypted conversation</h2>
                <p>Prompt plaintext stays inside this signed extension and the paired local Runner.</p>
              </div>
            )}
          </div>

          <form className="composer" onSubmit={submitRun}>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Message the paired local Cursor Runner…"
              rows={4}
            />
            <div className="composer-footer">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={allowWrites}
                  disabled={!workspace?.writable}
                  onChange={(event) => setAllowWrites(event.target.checked)}
                />
                Sign explicit file-write approval
              </label>
              <button
                disabled={
                  busy ||
                  !client ||
                  !runnerTrusted ||
                  !selectedWorkspaceId ||
                  !prompt.trim()
                }
              >
                <Send size={17} /> Send encrypted
              </button>
            </div>
          </form>
        </main>
      </div>
    </div>
  );
}
