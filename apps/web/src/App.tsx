import { FormEvent, KeyboardEvent, CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArchiveRestore,
  ArrowLeft,
  ArrowUp,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Database,
  FileText,
  Home,
  MessageSquare,
  Plus,
  Sparkles,
  Trash2
} from "lucide-react";
import type {
  Conversation,
  MemoryFact,
  ModelInfo,
  Principal,
  ReportDefinition,
  ReportId,
  RunProgressKind,
  RunRecord,
  Workspace
} from "@cursor-gateway/shared";
import { Markdown } from "./Markdown.js";

type ReportSummary = ReportDefinition & {
  runCount: number;
  latestRun: RunRecord | null;
};

type TrashConversation = {
  id: string;
  workspaceId: string;
  title: string | null;
  runCount: number;
  deletedAt: string;
};

type TrashRun = {
  id: string;
  conversationId: string;
  status: RunRecord["status"];
  model: string;
  prompt: string;
  deletedAt: string;
  createdAt: string;
};

type ApiState = {
  principal?: Principal;
  models: ModelInfo[];
  workspaces: Workspace[];
  runners: Array<{
    runnerId: string;
    lastSeenAt: string;
    online: boolean;
    workspaces: Workspace[];
    models: ModelInfo[];
  }>;
  conversations: Conversation[];
  conversationRuns: RunRecord[];
  memory: MemoryFact[];
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    throw new Error(`${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

const REPORT_IDS = new Set<ReportId>([
  "finance",
  "news",
  "ai-infra-tips",
  "ai-infra-interview"
]);

function useAutosizeTextarea(value: string, maxHeight = 220) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [maxHeight, value]);

  return ref;
}

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function isQuestionRun(run: RunRecord) {
  return run.idempotencyKey?.startsWith("qa:") ?? false;
}

function runDayKey(run: RunRecord) {
  if (!isQuestionRun(run) && run.idempotencyKey) {
    const last = run.idempotencyKey.split(":").at(-1) ?? "";
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(last);
    if (match?.[1]) return match[1];
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(run.createdAt));
}

function formatDayLabel(day: string) {
  const [year, month, date] = day.split("-").map((part) => Number(part));
  if (!year || !month || !date) return day;
  return `${year}/${month}/${date}`;
}

function isRunInFlight(run: RunRecord) {
  if (run.response || run.error) return false;
  return run.status === "queued" || run.status === "running" || run.status === "waiting_approval";
}

function RunProgressPanel({ run }: { run: RunRecord }) {
  const now = useNow(1000);
  if (!isRunInFlight(run) || run.status === "waiting_approval") return null;

  const elapsed = now - Date.parse(run.createdAt);
  const sinceUpdate = now - Date.parse(run.updatedAt);
  const kind: RunProgressKind | "queued" = run.progressKind ?? (run.status === "queued" ? "queued" : "thinking");
  const message =
    run.progress?.trim() ||
    (run.status === "queued"
      ? "Queued — waiting for a runner to claim this job."
      : "Runner claimed the job. Live traces will stream here while the model works.");

  return (
    <div className="run-progress" data-kind={kind}>
      <div className="run-progress-bar">
        <span className="run-progress-kind">{kind}</span>
        <span className="run-progress-status">{run.status}</span>
        <span className="run-progress-elapsed">elapsed {formatElapsed(elapsed)}</span>
        <span className="run-progress-fresh">beat {formatElapsed(sinceUpdate)} ago</span>
        <span className="run-progress-pulse" aria-hidden="true" />
      </div>
      <pre className="run-progress-body">{message}</pre>
    </div>
  );
}

function reportIdFromPath(): ReportId | undefined {
  const match = window.location.pathname.match(/^\/reports\/([^/]+)\/?$/);
  const candidate = match?.[1] as ReportId | undefined;
  return candidate && REPORT_IDS.has(candidate) ? candidate : undefined;
}

export function App() {
  const reportId = reportIdFromPath();
  if (reportId) return <ReportsPage initialReportId={reportId} />;
  if (window.location.pathname === "/reports") return <ReportsPage />;
  if (window.location.pathname === "/trash") return <TrashPage />;
  return <GatewayDashboard />;
}

function TopTabs({ active }: { active: "home" | "reports" }) {
  return (
    <nav className="top-tabs" aria-label="Primary navigation">
      <a className={active === "home" ? "active" : ""} href="/">
        <Home aria-hidden="true" size={15} strokeWidth={1.75} />
        <span>Home</span>
      </a>
      <a className={active === "reports" ? "active" : ""} href="/reports">
        <FileText aria-hidden="true" size={15} strokeWidth={1.75} />
        <span>Reports</span>
      </a>
    </nav>
  );
}

function BrandMark() {
  return (
    <a className="reports-brand" href="/">
      <strong>
        <Sparkles aria-hidden="true" size={15} strokeWidth={2} />
      </strong>
      <span>CS Gateway</span>
    </a>
  );
}

function SendBusy() {
  return <span className="send-loading" aria-hidden="true" />;
}

function GatewayDashboard() {
  const [state, setState] = useState<ApiState>({
    models: [],
    workspaces: [],
    runners: [],
    conversations: [],
    conversationRuns: [],
    memory: []
  });
  const [model, setModel] = useState(
    () => window.localStorage.getItem("cursor-gateway:model") || ""
  );
  const [defaultModelId, setDefaultModelId] = useState("auto");
  const [workspaceId, setWorkspaceId] = useState(
    () => window.localStorage.getItem("cursor-gateway:workspace") || ""
  );
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);
  const [memoryText, setMemoryText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const promptRef = useAutosizeTextarea(prompt);

  async function refresh(conversationId = selectedConversationId) {
    const [me, models, workspaces, runners, conversations, memory, conversationRuns] =
      await Promise.all([
      api<{ principal: Principal }>("/api/me"),
      api<{ models: ModelInfo[]; defaultModelId?: string }>("/api/models"),
      api<{ workspaces: Workspace[] }>("/api/workspaces"),
      api<{ runners: ApiState["runners"] }>("/api/dashboard-runners"),
      api<{ conversations: Conversation[] }>("/api/conversations"),
      api<{ facts: MemoryFact[] }>("/api/memory"),
      conversationId
        ? api<{ runs: RunRecord[] }>(`/api/conversations/${conversationId}/runs`)
        : Promise.resolve({ runs: [] })
      ]);

    setState({
      principal: me.principal,
      models: models.models,
      workspaces: workspaces.workspaces,
      runners: runners.runners,
      conversations: conversations.conversations,
      conversationRuns: conversationRuns.runs,
      memory: memory.facts
    });

    const selected = conversations.conversations.find((item) => item.id === conversationId);
    if (selected) setWorkspaceId(selected.workspaceId);
    else {
      setWorkspaceId((current) =>
        workspaces.workspaces.some((item) => item.id === current)
          ? current
          : workspaces.workspaces[0]?.id || ""
      );
    }
    const preferredDefault = models.defaultModelId || "auto";
    setDefaultModelId(preferredDefault);
    setModel((current) => {
      // Keep an explicit, still-valid user choice; otherwise fall back to the
      // server-configured default model. Treat the legacy implicit "auto" as
      // unset so a newly configured default takes effect.
      if (current && current !== "auto" && models.models.some((item) => item.id === current)) {
        return current;
      }
      if (models.models.some((item) => item.id === preferredDefault)) return preferredDefault;
      return current || preferredDefault || "auto";
    });
  }

  useEffect(() => {
    refresh(selectedConversationId).catch((err) =>
      setError(err instanceof Error ? err.message : String(err))
    );
    const timer = window.setInterval(() => {
      refresh(selectedConversationId).catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [selectedConversationId]);

  const selectedWorkspace = useMemo(
    () => state.workspaces.find((workspace) => workspace.id === workspaceId),
    [state.workspaces, workspaceId]
  );
  const selectedConversation = useMemo(
    () => state.conversations.find((conversation) => conversation.id === selectedConversationId),
    [state.conversations, selectedConversationId]
  );
  const selectedHermesModel = model.startsWith("hermes:");
  const hasOnlineRunner = state.runners.some((runner) => runner.online);
  const selectedModelName =
    state.models.find((item) => item.id === model)?.displayName ?? model;
  const selectedModelOnline =
    model === "auto"
      ? hasOnlineRunner
      : state.runners.some(
          (runner) =>
            runner.online && runner.models.some((runnerModel) => runnerModel.id === model)
        );

  useEffect(() => {
    if (!selectedWorkspace?.writable || selectedHermesModel) setAllowWrites(false);
  }, [selectedWorkspace, selectedHermesModel]);

  useEffect(() => {
    if (model) window.localStorage.setItem("cursor-gateway:model", model);
  }, [model]);

  useEffect(() => {
    if (workspaceId) window.localStorage.setItem("cursor-gateway:workspace", workspaceId);
  }, [workspaceId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [
    state.conversationRuns.length,
    state.conversationRuns.map((run) => run.status).join(",")
  ]);

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function startNewConversation() {
    setSelectedConversationId("");
    setPrompt("");
    setError("");
  }

  async function submitRun(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await api<{ run: RunRecord }>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          origin: "web",
          prompt,
          ...(selectedConversationId ? { conversationId: selectedConversationId } : {}),
          model,
          workspaceId,
          memoryEnabled: true,
          allowWrites
        })
      });
      setPrompt("");
      setSelectedConversationId(result.run.conversationId);
      await refresh(result.run.conversationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function addMemory(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!memoryText.trim()) return;
    try {
      await api("/api/memory", {
        method: "POST",
        body: JSON.stringify({
          content: memoryText,
          scope: workspaceId ? "workspace" : "user",
          workspaceId: workspaceId || undefined
        })
      });
      setMemoryText("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function approveRun(runId: string) {
    await api(`/api/runs/${runId}/approve`, { method: "POST" });
    await refresh();
  }

  async function deleteRun(run: RunRecord) {
    if (run.status === "running") return;
    if (!window.confirm("Move this run to the recycle bin?")) return;
    setError("");
    try {
      await api(`/api/runs/${run.id}`, { method: "DELETE" });
      await refresh(selectedConversationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteConversation() {
    if (!selectedConversation) return;
    if (
      !window.confirm(
        `Move “${selectedConversation.title ?? selectedConversation.id}” and all of its runs to the recycle bin?`
      )
    ) {
      return;
    }
    setError("");
    try {
      await api(`/api/conversations/${selectedConversation.id}`, { method: "DELETE" });
      setSelectedConversationId("");
      await refresh("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="home-app" id="main">
      <header className="reports-topbar">
        <BrandMark />
        <TopTabs active="home" />
        <a className="topbar-link" href="/trash">
          <Trash2 aria-hidden="true" size={15} strokeWidth={1.75} />
          <span>Recycle Bin</span>
        </a>
      </header>

      <div className="home-layout">
        <aside className="home-sidebar">
          <button className="new-chat-button" type="button" onClick={startNewConversation}>
            <Plus aria-hidden="true" size={17} strokeWidth={2} />
            <span>New chat</span>
          </button>

          <div className="conversation-list">
            {state.conversations.map((conversation, index) => (
              <button
                className={conversation.id === selectedConversationId ? "active" : ""}
                key={conversation.id}
                onClick={() => {
                  setSelectedConversationId(conversation.id);
                  setWorkspaceId(conversation.workspaceId);
                }}
                style={{ ["--i" as string]: index } as CSSProperties}
                type="button"
              >
                <span className="conversation-glyph"><MessageSquare aria-hidden="true" size={15} strokeWidth={1.75} /></span>
                <span>
                  <strong>{conversation.title ?? "Untitled conversation"}</strong>
                  <small>{conversation.runCount} message pair(s)</small>
                </span>
              </button>
            ))}
            {state.conversations.length === 0 ? (
              <p className="sidebar-empty">Start a chat to pin context here.</p>
            ) : null}
          </div>

          <details className="memory-drawer">
            <summary><Database aria-hidden="true" size={14} /> Memory <span>{state.memory.length}</span></summary>
            <form onSubmit={addMemory}>
              <textarea
                value={memoryText}
                onChange={(event) => setMemoryText(event.target.value)}
                placeholder="Add a durable preference…"
                rows={2}
              />
              <button disabled={!memoryText.trim()}>Save memory</button>
            </form>
            <div>
              {state.memory.slice(0, 6).map((fact) => (
                <p key={fact.id}>{fact.content}</p>
              ))}
            </div>
          </details>
        </aside>

        <section className="home-chat">
          <header className="home-chat-header">
            <div>
              <h1>{selectedConversation?.title ?? "New conversation"}</h1>
              <p>
                <span className={`runner-dot ${selectedModelOnline ? "online" : ""}`} />
                {selectedModelOnline ? "Ready" : "Will queue"} · {selectedModelName}
              </p>
            </div>
            <div className="home-header-actions">
              <select
                aria-label="Model"
                className="model-switcher"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {state.models.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.displayName ?? item.id}
                  </option>
                ))}
              </select>
              {selectedConversation ? (
                <button
                  aria-label="Move conversation to recycle bin"
                  className="icon-danger-button"
                  onClick={deleteConversation}
                  title="Move conversation to recycle bin"
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={16} />
                </button>
              ) : null}
            </div>
          </header>

          {error ? <div className="error chat-error">{error}</div> : null}

          <div className="home-messages">
            {state.conversationRuns.length === 0 ? (
              <div className="home-welcome">
                <div className="welcome-mark"><Sparkles aria-hidden="true" size={21} strokeWidth={1.75} /></div>
                <h2>Ask the runner</h2>
                <p className="welcome-copy">
                  Hermes answers on the VPS host. Switch to a Windows Cursor model when you need
                  workspace-aware reads or writes.
                </p>
              </div>
            ) : null}

            {state.conversationRuns.map((run, index) => (
              <div className="chat-turn" key={run.id} style={{ ["--i" as string]: index } as CSSProperties}>
                <div className="chat-message user-message">
                  <div className="message-body">{run.prompt}</div>
                </div>
                <div className="chat-message assistant-message">
                  <div className="message-avatar">{run.model.startsWith("hermes:") ? "H" : "AI"}</div>
                  <div className="message-main">
                    <div className="message-meta">
                      <strong>{run.model.startsWith("hermes:") ? "Hermes" : "Cursor"}</strong>
                      <span>{run.model}</span>
                      <time>{new Date(run.createdAt).toLocaleString()}</time>
                      <button
                        className="message-delete"
                        disabled={run.status === "running"}
                        onClick={() => deleteRun(run)}
                        title="Recycle this message pair"
                        type="button"
                      >
                        <Trash2 aria-hidden="true" size={15} strokeWidth={1.75} />
                      </button>
                    </div>
                    {run.status === "waiting_approval" ? (
                      <button onClick={() => approveRun(run.id)}>Approve write access</button>
                    ) : null}
                    {run.response ? <Markdown>{run.response}</Markdown> : null}
                    {run.error ? <pre className="error-pre">{run.error}</pre> : null}
                    <RunProgressPanel run={run} />
                  </div>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <div className="home-composer-shell">
            <form className="home-composer" onSubmit={submitRun}>
              <div className="composer-input">
                <textarea
                  ref={promptRef}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={submitOnEnter}
                  placeholder={
                    selectedHermesModel
                      ? "Message Hermes on the VPS"
                      : "Message Cursor about your workspace"
                  }
                  rows={1}
                />
                <button
                  aria-label="Send message"
                  disabled={loading || !prompt.trim() || !workspaceId}
                >
                  {loading ? <SendBusy /> : <ArrowUp aria-hidden="true" size={18} strokeWidth={2} />}
                </button>
              </div>
              <div className="composer-options">
                <label>
                  <span>Workspace</span>
                  <select
                    value={workspaceId}
                    disabled={Boolean(selectedConversation)}
                    onChange={(event) => setWorkspaceId(event.target.value)}
                  >
                    {state.workspaces.map((workspace) => (
                      <option value={workspace.id} key={workspace.id}>
                        {workspace.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="compact-checkbox">
                  <input
                    type="checkbox"
                    checked={allowWrites}
                    disabled={selectedHermesModel || !selectedWorkspace?.writable}
                    onChange={(event) => setAllowWrites(event.target.checked)}
                  />
                  Allow writes
                </label>
                <span className="composer-hint">
                  {selectedHermesModel
                    ? "Hermes is Q&A-only"
                    : selectedConversation
                      ? "Workspace fixed for this conversation"
                      : "Enter to send · Shift+Enter for newline"}
                </span>
              </div>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}

type ReportDetail = {
  report: ReportDefinition;
  runs: RunRecord[];
  configured: boolean;
};

function questionFromPrompt(prompt: string) {
  const marker = "读者问题：\n";
  const index = prompt.lastIndexOf(marker);
  return index >= 0 ? prompt.slice(index + marker.length).trim() : prompt;
}

function ReportsPage({ initialReportId }: { initialReportId?: ReportId }) {
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [selectedReportId, setSelectedReportId] = useState<ReportId | undefined>(
    initialReportId
  );
  const [detail, setDetail] = useState<ReportDetail>();
  const [configured, setConfigured] = useState(false);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [asking, setAsking] = useState(false);
  const [selectedDay, setSelectedDay] = useState("");
  const [slideDir, setSlideDir] = useState<"left" | "right" | "none">("none");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef<number | null>(null);
  const questionRef = useAutosizeTextarea(question);

  async function refresh() {
    const index = await api<{ reports: ReportSummary[]; configured: boolean }>("/api/reports");
    setReports(index.reports);
    setConfigured(index.configured);
    const target = selectedReportId ?? initialReportId ?? index.reports[0]?.id;
    if (!target) return;
    if (target !== selectedReportId) setSelectedReportId(target);
    const next = await api<ReportDetail>(`/api/reports/${target}`);
    setDetail(next);
  }

  useEffect(() => {
    refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    const timer = window.setInterval(() => {
      refresh().catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [selectedReportId]);

  const editionsByDay = useMemo(() => {
    const map = new Map<string, RunRecord>();
    for (const run of detail?.runs ?? []) {
      if (isQuestionRun(run)) continue;
      const day = runDayKey(run);
      const existing = map.get(day);
      if (!existing || Date.parse(run.createdAt) > Date.parse(existing.createdAt)) {
        map.set(day, run);
      }
    }
    return map;
  }, [detail?.runs]);

  const questionsByDay = useMemo(() => {
    const map = new Map<string, RunRecord[]>();
    for (const run of detail?.runs ?? []) {
      if (!isQuestionRun(run)) continue;
      const day = runDayKey(run);
      const list = map.get(day) ?? [];
      list.push(run);
      map.set(day, list);
    }
    for (const [day, list] of map) {
      map.set(
        day,
        [...list].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      );
    }
    return map;
  }, [detail?.runs]);

  const dayKeys = useMemo(() => {
    const keys = new Set<string>([...editionsByDay.keys(), ...questionsByDay.keys()]);
    return [...keys].sort((a, b) => b.localeCompare(a));
  }, [editionsByDay, questionsByDay]);

  useEffect(() => {
    if (dayKeys.length === 0) {
      setSelectedDay("");
      return;
    }
    setSelectedDay((current) => (current && dayKeys.includes(current) ? current : (dayKeys[0] ?? "")));
  }, [dayKeys, selectedReportId]);

  const progressFingerprint = (detail?.runs ?? [])
    .map((run) => `${run.id}:${run.status}:${run.progressKind ?? ""}:${run.progress?.length ?? 0}:${run.updatedAt}`)
    .join("|");

  const dayIndex = selectedDay ? dayKeys.indexOf(selectedDay) : -1;
  const activeEdition = selectedDay ? editionsByDay.get(selectedDay) : undefined;
  const activeQuestions = selectedDay ? questionsByDay.get(selectedDay) ?? [] : [];

  // Open each day from the edition title, not the bottom of the thread.
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    container.scrollTop = 0;
  }, [selectedDay, selectedReportId]);

  // Only stick to the bottom while a follow-up question is still running.
  useEffect(() => {
    const hasInFlightQa = activeQuestions.some((run) => isRunInFlight(run));
    if (!hasInFlightQa) return;
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [progressFingerprint, activeQuestions]);

  function goToDay(nextDay: string, direction: "left" | "right") {
    if (!nextDay || nextDay === selectedDay) return;
    setSlideDir(direction);
    setSelectedDay(nextDay);
    window.requestAnimationFrame(() => {
      window.setTimeout(() => setSlideDir("none"), 280);
    });
  }

  function shiftDay(delta: number) {
    if (dayIndex < 0) return;
    const nextIndex = dayIndex + delta;
    const nextDay = dayKeys[nextIndex];
    if (!nextDay) return;
    // dayKeys are newest-first: +1 = older, -1 = newer.
    // Slide older in from the left, newer in from the right.
    goToDay(nextDay, delta > 0 ? "right" : "left");
  }

  async function askQuestion(event: FormEvent) {
    event.preventDefault();
    if (!question.trim() || !selectedReportId) return;
    setAsking(true);
    setError("");
    try {
      await api(`/api/reports/${selectedReportId}/questions`, {
        method: "POST",
        body: JSON.stringify({
          question,
          requestId: window.crypto.randomUUID()
        })
      });
      setQuestion("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  }

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  const selectedSummary = reports.find((report) => report.id === selectedReportId);

  return (
    <main className="reports-app" id="main">
      <header className="reports-topbar">
        <BrandMark />
        <TopTabs active="reports" />
        <a className="topbar-link" href="/trash">
          <Trash2 aria-hidden="true" size={15} strokeWidth={1.75} />
          <span>Recycle Bin</span>
        </a>
      </header>

      <div className="reports-layout">
        <aside className="reports-sidebar">
          <div className="sidebar-heading">
            <span>Daily reports</span>
            <small>{configured ? "AI ready" : "Setup pending"}</small>
          </div>
          <div className="report-thread-list">
            {reports.map((report, index) => (
              <a
                className={report.id === selectedReportId ? "active" : ""}
                href={`/reports/${report.id}`}
                key={report.id}
                style={{ ["--i" as string]: index } as CSSProperties}
              >
                <span className="thread-icon"><FileText aria-hidden="true" size={16} strokeWidth={1.75} /></span>
                <span>
                  <strong>{report.shortName}</strong>
                  <small>
                    {report.runCount} item{report.runCount === 1 ? "" : "s"} · {report.schedule}
                  </small>
                </span>
              </a>
            ))}
          </div>
        </aside>

        <section className="report-chat">
          <header className="report-chat-header">
            <div>
              <h1>{detail?.report.name ?? selectedSummary?.name ?? "Daily Reports"}</h1>
              <p>{detail?.report.description ?? "Choose a report and ask a follow-up."}</p>
            </div>
            <span className={detail?.configured ? "status-ready" : "status-pending"}>
              {detail?.configured ? "AI ready" : "Setup pending"}
            </span>
          </header>

          {error ? <div className="error chat-error">{error}</div> : null}

          {dayKeys.length > 0 ? (
            <div className="day-pager" role="navigation" aria-label="Report day">
              <div className="day-pager-controls">
                <label className="day-pager-date">
                  <CalendarDays aria-hidden="true" size={15} strokeWidth={1.75} />
                  <span className="day-pager-date-text">{formatDayLabel(selectedDay)}</span>
                  <input
                    aria-label="Jump to date"
                    className="day-pager-date-input"
                    max={dayKeys[0]}
                    min={dayKeys[dayKeys.length - 1]}
                    type="date"
                    value={selectedDay}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (!value) return;
                      if (dayKeys.includes(value)) {
                        const nextIndex = dayKeys.indexOf(value);
                        goToDay(value, nextIndex > dayIndex ? "right" : "left");
                        return;
                      }
                      // Snap to nearest available day when the picker hits a gap.
                      const nearest = dayKeys.reduce((best, day) =>
                        Math.abs(Date.parse(day) - Date.parse(value)) <
                        Math.abs(Date.parse(best) - Date.parse(value))
                          ? day
                          : best
                      );
                      const nextIndex = dayKeys.indexOf(nearest);
                      goToDay(nearest, nextIndex > dayIndex ? "right" : "left");
                    }}
                  />
                </label>
                <button
                  aria-label="Older day"
                  className="day-pager-nav"
                  disabled={dayIndex < 0 || dayIndex >= dayKeys.length - 1}
                  onClick={() => shiftDay(1)}
                  type="button"
                >
                  <ChevronLeft aria-hidden="true" size={18} strokeWidth={1.75} />
                </button>
                <button
                  aria-label="Newer day"
                  className="day-pager-nav"
                  disabled={dayIndex <= 0}
                  onClick={() => shiftDay(-1)}
                  type="button"
                >
                  <ChevronRight aria-hidden="true" size={18} strokeWidth={1.75} />
                </button>
                <div className="day-pager-meta">
                  {dayIndex + 1}/{dayKeys.length}
                </div>
              </div>
            </div>
          ) : null}

          <div
            className="report-messages"
            ref={messagesContainerRef}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                shiftDay(1);
              }
              if (event.key === "ArrowRight") {
                event.preventDefault();
                shiftDay(-1);
              }
            }}
            onTouchEnd={(event) => {
              if (touchStartX.current == null) return;
              const endX = event.changedTouches[0]?.clientX;
              const startX = touchStartX.current;
              touchStartX.current = null;
              if (endX == null) return;
              const dx = endX - startX;
              if (Math.abs(dx) < 56) return;
              // Swipe right = older; swipe left = newer.
              shiftDay(dx > 0 ? 1 : -1);
            }}
            onTouchStart={(event) => {
              touchStartX.current = event.touches[0]?.clientX ?? null;
            }}
            tabIndex={0}
          >
            {dayKeys.length === 0 ? (
              <div className="report-welcome">
                <div className="welcome-mark"><FileText aria-hidden="true" size={21} /></div>
                <h2>Ask about {detail?.report.shortName ?? "a daily report"}</h2>
                <p>
                  Daily editions will appear here by date. Swipe or use the day controls once
                  content exists.
                </p>
              </div>
            ) : (
              <div
                className={`day-slide day-slide-${slideDir}`}
                key={selectedDay}
              >
                {activeEdition ? (
                  <article className="report-edition">
                    {activeEdition.response ? <Markdown>{activeEdition.response}</Markdown> : null}
                    {activeEdition.error ? <pre className="error-pre">{activeEdition.error}</pre> : null}
                    <RunProgressPanel run={activeEdition} />
                  </article>
                ) : (
                  <div className="day-empty">
                    <p>No daily edition for {formatDayLabel(selectedDay)}.</p>
                  </div>
                )}

                {activeQuestions.map((run, index) => (
                  <div className="chat-turn" key={run.id} style={{ ["--i" as string]: index } as CSSProperties}>
                    <div className="chat-message user-message">
                      <div className="message-body">{questionFromPrompt(run.prompt)}</div>
                    </div>
                    <div className="chat-message assistant-message">
                      <div className="message-avatar">AI</div>
                      <div className="message-main">
                        <div className="message-meta">
                          <strong>Report AI</strong>
                          <time>{new Date(run.createdAt).toLocaleString()}</time>
                        </div>
                        {run.response ? <Markdown>{run.response}</Markdown> : null}
                        {run.error ? <pre className="error-pre">{run.error}</pre> : null}
                        <RunProgressPanel run={run} />
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          <div className="report-composer-shell">
            <form className="report-composer" onSubmit={askQuestion}>
              <textarea
                ref={questionRef}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={submitOnEnter}
                placeholder={`Message ${detail?.report.shortName ?? "Report AI"}`}
                rows={1}
              />
              <button
                aria-label="Send question"
                disabled={asking || !question.trim() || !detail?.configured}
              >
                {asking ? <SendBusy /> : <ArrowUp aria-hidden="true" size={18} strokeWidth={2} />}
              </button>
            </form>
            <small className="composer-hint">
              Enter to send · swipe or ← → to change day
            </small>
          </div>
        </section>
      </div>
    </main>
  );
}

function TrashPage() {
  const [trash, setTrash] = useState<{
    conversations: TrashConversation[];
    runs: TrashRun[];
  }>({ conversations: [], runs: [] });
  const [error, setError] = useState("");

  async function refresh() {
    setTrash(
      await api<{ conversations: TrashConversation[]; runs: TrashRun[] }>("/api/trash")
    );
  }

  useEffect(() => {
    refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function restoreConversation(conversationId: string) {
    setError("");
    try {
      await api(`/api/trash/conversations/${conversationId}/restore`, { method: "POST" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function restoreRun(runId: string) {
    setError("");
    try {
      await api(`/api/trash/runs/${runId}/restore`, { method: "POST" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="shell report-shell" id="main">
      <header className="reports-topbar" style={{ marginBottom: "1.25rem" }}>
        <BrandMark />
        <TopTabs active="home" />
        <a className="topbar-link" href="/trash" aria-current="page">
          <Trash2 aria-hidden="true" size={15} strokeWidth={1.75} />
          <span>Recycle Bin</span>
        </a>
      </header>
      <header className="report-hero">
        <a href="/"><ArrowLeft aria-hidden="true" size={16} strokeWidth={1.75} /> Back</a>
        <div>
          <p className="eyebrow">Recoverable items</p>
          <h1>Recycle Bin</h1>
          <p>Deleted conversations and runs stay here until you restore them.</p>
        </div>
      </header>

      {error ? <div className="error">{error}</div> : null}

      <section className="panel">
        <h2>Conversations</h2>
        <div className="trash-list">
          {trash.conversations.map((conversation, index) => (
            <article key={conversation.id} style={{ ["--i" as string]: index } as CSSProperties}>
              <div>
                <strong>{conversation.title ?? "Untitled conversation"}</strong>
                <p className="muted">
                  {conversation.runCount} run(s) · deleted{" "}
                  {new Date(conversation.deletedAt).toLocaleString()}
                </p>
                <code>{conversation.id}</code>
              </div>
              <button onClick={() => restoreConversation(conversation.id)}><ArchiveRestore aria-hidden="true" size={16} strokeWidth={1.75} /> Restore</button>
            </article>
          ))}
          {trash.conversations.length === 0 ? (
            <p className="muted">No deleted conversations.</p>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <h2>Individual runs</h2>
        <div className="trash-list">
          {trash.runs.map((run, index) => (
            <article key={run.id} style={{ ["--i" as string]: index } as CSSProperties}>
              <div>
                <strong>{run.status} · {run.model}</strong>
                <p>{run.prompt}</p>
                <small className="muted">
                  Deleted {new Date(run.deletedAt).toLocaleString()}
                </small>
              </div>
              <button onClick={() => restoreRun(run.id)}><ArchiveRestore aria-hidden="true" size={16} strokeWidth={1.75} /> Restore</button>
            </article>
          ))}
          {trash.runs.length === 0 ? <p className="muted">No deleted runs.</p> : null}
        </div>
      </section>
    </main>
  );
}
