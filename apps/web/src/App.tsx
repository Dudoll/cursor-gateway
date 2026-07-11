import { FormEvent, KeyboardEvent, CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArchiveRestore,
  ArrowLeft,
  ArrowUp,
  Bot,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  FileText,
  Home,
  LockKeyhole,
  MessageSquare,
  Plus,
  Sparkles,
  Target,
  Trash2
} from "lucide-react";
import type {
  Conversation,
  InterviewProfile,
  InterviewProfileUpdate,
  InterviewProgress,
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

type InterviewAccess = {
  entitled: boolean;
  activationRequired: boolean;
  plan: "starter" | "pro" | "coaching" | null;
  expiresAt: string | null;
  email: string | null;
};

type InterviewDashboardState = {
  profile: InterviewProfile | null;
  progress: InterviewProgress[];
  recommendations: Array<{ id: string; title: string; detail: string; href: string }>;
  coachRuns: RunRecord[];
  latestReports: Array<{ reportId: ReportId; run: RunRecord | null }>;
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
  "ai-infra-interview",
  "ai-infra-mianshi",
  "ai-agent-mianshi"
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

/** Report calendar / display timezone; independent from the server OS timezone. */
const REPORT_DISPLAY_TIMEZONE = "Asia/Shanghai";

function formatInReportTz(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", {
    timeZone: REPORT_DISPLAY_TIMEZONE,
    hour12: false
  });
}

function runDayKey(run: RunRecord) {
  if (!isQuestionRun(run) && run.idempotencyKey) {
    const last = run.idempotencyKey.split(":").at(-1) ?? "";
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(last);
    if (match?.[1]) return match[1];
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_DISPLAY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(run.createdAt));
}

function formatDayLabel(day: string) {
  const [year, month, date] = day.split("-").map((part) => Number(part));
  if (!year || !month || !date) return day;
  return `${year}/${month}/${date}（UTC+8）`;
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
  if (window.location.pathname === "/interview/activate") return <InterviewPortal activate />;
  if (window.location.pathname === "/interview") return <InterviewPortal />;
  if (window.location.pathname === "/trash") return <TrashPage />;
  return <GatewayDashboard />;
}

function TopTabs({ active }: { active: "home" | "reports" | "interview" }) {
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
      <a className={active === "interview" ? "active" : ""} href="/interview">
        <Target aria-hidden="true" size={15} strokeWidth={1.75} />
        <span>Interview</span>
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
                          <time>{formatInReportTz(run.createdAt)}</time>
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

const EMPTY_INTERVIEW_PROFILE: InterviewProfileUpdate = {
  targetRole: "AI Agent 开发工程师",
  sourceStack: "Java / Spring Boot",
  targetCompanies: [],
  currentLevel: "starting",
  weeklyHours: 7,
  targetDate: null,
  goals: ""
};

function InterviewPortal({ activate = false }: { activate?: boolean }) {
  const [access, setAccess] = useState<InterviewAccess | null>(null);
  const [dashboard, setDashboard] = useState<InterviewDashboardState | null>(null);
  const [profile, setProfile] = useState<InterviewProfileUpdate>(EMPTY_INTERVIEW_PROFILE);
  const [companies, setCompanies] = useState("");
  const [question, setQuestion] = useState("");
  const [progressKey, setProgressKey] = useState("");
  const [progressReport, setProgressReport] = useState<ReportId>("ai-agent-mianshi");
  const [progressStatus, setProgressStatus] = useState<"new" | "practicing" | "mastered">(
    "practicing"
  );
  const [progressConfidence, setProgressConfidence] = useState(3);
  const [busy, setBusy] = useState(false);
  const [activationState, setActivationState] = useState<"idle" | "working" | "done">("idle");
  const [error, setError] = useState("");
  const questionRef = useAutosizeTextarea(question, 180);

  async function loadAccess() {
    const next = await api<InterviewAccess>("/api/interview/access");
    setAccess(next);
    return next;
  }

  async function loadDashboard() {
    const next = await api<InterviewDashboardState>("/api/interview/dashboard");
    setDashboard(next);
    if (next.profile) {
      const { updatedAt: _updatedAt, ...editable } = next.profile;
      setProfile(editable);
      setCompanies(next.profile.targetCompanies.join("、"));
    }
    return next;
  }

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        setError("");
        const current = await loadAccess();
        if (!cancelled && current.entitled) await loadDashboard();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activate || activationState !== "idle") return;
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setError("激活链接缺少 token。请使用付款后邮件中的完整链接。");
      return;
    }
    setActivationState("working");
    api<{ activated: boolean }>("/api/interview/activate", {
      method: "POST",
      body: JSON.stringify({ token })
    })
      .then(async () => {
        window.history.replaceState({}, "", "/interview");
        setActivationState("done");
        await loadAccess();
        await loadDashboard();
      })
      .catch((err) => {
        setActivationState("idle");
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [activate, activationState]);

  useEffect(() => {
    const inFlight = dashboard?.coachRuns.some(isRunInFlight) ?? false;
    if (!inFlight) return;
    const timer = window.setTimeout(() => {
      loadDashboard().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, 1_800);
    return () => window.clearTimeout(timer);
  }, [dashboard?.coachRuns]);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload: InterviewProfileUpdate = {
        ...profile,
        targetCompanies: companies
          .split(/[、,，]/)
          .map((item) => item.trim())
          .filter(Boolean)
      };
      await api("/api/interview/profile", {
        method: "PUT",
        body: JSON.stringify(payload)
      });
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveProgress(event: FormEvent) {
    event.preventDefault();
    if (!progressKey.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/interview/progress", {
        method: "POST",
        body: JSON.stringify({
          reportId: progressReport,
          questionKey: progressKey.trim(),
          status: progressStatus,
          confidence: progressConfidence,
          notes: "",
          nextReviewAt: null
        })
      });
      setProgressKey("");
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function askCoach(event: FormEvent) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/interview/questions", {
        method: "POST",
        body: JSON.stringify({ question: trimmed, requestId: crypto.randomUUID() })
      });
      setQuestion("");
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const coachRuns = [...(dashboard?.coachRuns ?? [])].reverse();

  return (
    <main className="interview-app" id="main">
      <header className="reports-topbar">
        <BrandMark />
        <TopTabs active="interview" />
        <span className={access?.entitled ? "status-ready" : "status-pending"}>
          {access?.entitled ? `${access.plan ?? "paid"} plan` : "locked"}
        </span>
      </header>

      <div className="interview-shell">
        {error ? <div className="error interview-error">{error}</div> : null}

        {!access ? (
          <section className="interview-loading" aria-live="polite">
            <SendBusy />
            <p>正在验证你的训练空间…</p>
          </section>
        ) : !access.entitled ? (
          <section className="interview-gate">
            <div className="gate-mark"><LockKeyhole size={24} aria-hidden="true" /></div>
            <p className="eyebrow">Paid interview workspace</p>
            <h1>付款邮箱，是这间训练室唯一的钥匙。</h1>
            <p>
              付款成功后，系统会把一次性激活链接发送到 <strong>{access.email}</strong>。
              Cloudflare 登录邮箱与付款邮箱一致后，才能激活并查看个人资料、进度和 AI 对话。
            </p>
            <div className="gate-proof">
              <span><CheckCircle2 size={15} /> 每个账号独立数据</span>
              <span><CheckCircle2 size={15} /> 激活 token 仅存哈希</span>
              <span><CheckCircle2 size={15} /> 付款记录可审计</span>
            </div>
            <small>
              {access.activationRequired
                ? "你的付款记录已创建，请打开邮件里的完整激活链接。"
                : "尚未发现有效付款记录。付款渠道接入后会自动生成邮件链接。"}
            </small>
          </section>
        ) : (
          <div className="interview-dashboard">
            <section className="interview-hero">
              <div>
                <p className="eyebrow">Personal interview OS</p>
                <h1>把每日面经，变成你的训练节奏。</h1>
                <p>
                  真实面经负责提供信号；个人目标、复习进度和 AI 教练负责把信号变成下一步。
                </p>
              </div>
              <div className="hero-metric">
                <strong>{dashboard?.progress.length ?? 0}</strong>
                <span>tracked questions</span>
              </div>
            </section>

            <section className="interview-grid report-preview-grid" aria-label="最新真实面经">
              {(dashboard?.latestReports ?? []).map(({ reportId, run }) => (
                <a className="interview-card report-preview" href={`/reports/${reportId}`} key={reportId}>
                  <span className="card-icon"><FileText size={16} /></span>
                  <small>{reportId === "ai-infra-mianshi" ? "AI INFRA" : "AI AGENT"}</small>
                  <h2>{run?.idempotencyKey?.split(":").at(-1) ?? "等待首篇日报"}</h2>
                  <p>{run?.response?.replace(/[#*`]/g, "").slice(0, 150) ?? "内容生成后会出现在这里。"}</p>
                  <span>打开完整面经 →</span>
                </a>
              ))}
            </section>

            <section className="interview-grid">
              <article className="interview-card recommendations-card">
                <div className="card-heading">
                  <Target size={17} />
                  <div><small>NEXT BEST ACTION</small><h2>今日推荐</h2></div>
                </div>
                <div className="recommendation-list">
                  {(dashboard?.recommendations ?? []).map((item, index) => (
                    <a href={item.href} key={item.id}>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <div><strong>{item.title}</strong><p>{item.detail}</p></div>
                    </a>
                  ))}
                </div>
              </article>

              <form className="interview-card profile-card" onSubmit={saveProfile}>
                <div className="card-heading">
                  <Sparkles size={17} />
                  <div><small>YOUR CONTEXT</small><h2>训练规划</h2></div>
                </div>
                <label>目标岗位<input value={profile.targetRole} onChange={(e) => setProfile({ ...profile, targetRole: e.target.value })} /></label>
                <label>当前技术栈<input value={profile.sourceStack} onChange={(e) => setProfile({ ...profile, sourceStack: e.target.value })} /></label>
                <label>目标公司<input value={companies} onChange={(e) => setCompanies(e.target.value)} placeholder="字节、阿里、OpenAI" /></label>
                <div className="profile-row">
                  <label>阶段<select value={profile.currentLevel} onChange={(e) => setProfile({ ...profile, currentLevel: e.target.value as InterviewProfileUpdate["currentLevel"] })}><option value="starting">刚开始</option><option value="building">项目实战</option><option value="interviewing">面试中</option></select></label>
                  <label>每周小时<input type="number" min="1" max="80" value={profile.weeklyHours} onChange={(e) => setProfile({ ...profile, weeklyHours: Number(e.target.value) })} /></label>
                </div>
                <label>目标日期<input type="date" value={profile.targetDate ?? ""} onChange={(e) => setProfile({ ...profile, targetDate: e.target.value || null })} /></label>
                <label>补充目标<textarea value={profile.goals} onChange={(e) => setProfile({ ...profile, goals: e.target.value })} rows={3} /></label>
                <button className="primary-action" disabled={busy}>保存规划</button>
              </form>
            </section>

            <section className="interview-grid" id="progress">
              <form className="interview-card progress-card" onSubmit={saveProgress}>
                <div className="card-heading">
                  <CheckCircle2 size={17} />
                  <div><small>SPACED PRACTICE</small><h2>记录一道题</h2></div>
                </div>
                <label>题目标识<input value={progressKey} onChange={(e) => setProgressKey(e.target.value)} placeholder="例如：2026-07-12 / Q2" /></label>
                <div className="profile-row">
                  <label>栏目<select value={progressReport} onChange={(e) => setProgressReport(e.target.value as ReportId)}><option value="ai-agent-mianshi">AI Agent</option><option value="ai-infra-mianshi">AI Infra</option></select></label>
                  <label>状态<select value={progressStatus} onChange={(e) => setProgressStatus(e.target.value as typeof progressStatus)}><option value="new">新题</option><option value="practicing">练习中</option><option value="mastered">已掌握</option></select></label>
                </div>
                <label>信心 {progressConfidence}/5<input type="range" min="1" max="5" value={progressConfidence} onChange={(e) => setProgressConfidence(Number(e.target.value))} /></label>
                <button className="secondary-action" disabled={busy || !progressKey.trim()}>保存进度</button>
              </form>

              <article className="interview-card progress-list-card">
                <div className="card-heading">
                  <Target size={17} />
                  <div><small>PROGRESS</small><h2>最近练习</h2></div>
                </div>
                {(dashboard?.progress.length ?? 0) === 0 ? <p className="empty-copy">还没有记录。先从今天的 Q1 开始。</p> : null}
                <div className="progress-list">
                  {(dashboard?.progress ?? []).slice(0, 8).map((item) => (
                    <div key={`${item.reportId}:${item.questionKey}`}>
                      <span data-status={item.status}>{item.status}</span>
                      <div><strong>{item.questionKey}</strong><small>{item.reportId} · confidence {item.confidence}/5</small></div>
                    </div>
                  ))}
                </div>
              </article>
            </section>

            <section className="interview-card coach-card" id="coach">
              <div className="card-heading">
                <Bot size={17} />
                <div><small>PRIVATE AI THREAD</small><h2>定制化面经问答</h2></div>
              </div>
              <div className="coach-messages">
                {coachRuns.length === 0 ? (
                  <div className="coach-empty"><Bot size={22} /><p>告诉我你的目标、薄弱点，或让我基于今天的真实面经做一轮模拟面试。</p></div>
                ) : coachRuns.map((run) => (
                  <div className="coach-turn" key={run.id}>
                    <div className="coach-user">{questionFromPrompt(run.prompt)}</div>
                    <div className="coach-answer">
                      {run.response ? <Markdown>{run.response}</Markdown> : null}
                      {run.error ? <pre className="error-pre">{run.error}</pre> : null}
                      <RunProgressPanel run={run} />
                    </div>
                  </div>
                ))}
              </div>
              <form className="coach-composer" onSubmit={askCoach}>
                <textarea ref={questionRef} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="例如：我是 Java 后端，基于今天 Agent 面经给我安排 30 分钟模拟面试" rows={1} />
                <button disabled={busy || !question.trim()} aria-label="发送给 AI 教练">{busy ? <SendBusy /> : <ArrowUp size={18} />}</button>
              </form>
            </section>
          </div>
        )}
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
