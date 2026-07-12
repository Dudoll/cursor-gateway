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
  Download,
  FileText,
  Home,
  LockKeyhole,
  LockKeyholeOpen,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Sparkles,
  Target,
  Trash2
} from "lucide-react";
import {
  createRunPollingLoop,
  isRunStatusInFlight
} from "@cursor-gateway/shared";
import type {
  Conversation,
  E2eeDeviceApprovalRequest,
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
import { GatewayApi } from "./api.js";
import {
  beginCsDeviceAuth,
  completeCsDeviceAuthFromFragment
} from "./csAuth.js";
import { decideDeviceApproval, listPendingApprovals } from "./deviceApproval.js";
import {
  CsWebKeyStore,
  detectIncompatibleStorage,
  requestPersistentStorage,
  type DeviceRecord
} from "./keyStore.js";
import { SecureGatewayClient, type DecryptedRun } from "./secureClient.js";
import {
  E2EE_ENCRYPTED_BADGE,
  e2eeRunEvidenceTitle
} from "./e2eeStatusUi.js";
import {
  E2EE_ACCESS_LOGOUT_CONFIRM,
  E2EE_LOGOUT_CONFIRM,
  E2EE_LOGOUT_DONE,
  E2EE_LOGOUT_LABEL,
  buildCfAccessLogoutUrl,
  clearLocalE2eeAuthorization
} from "./e2eeLogout.js";
import {
  HISTORICAL_PLAINTEXT_LABEL,
  buildMergedTimeline,
  mergeConversationLists,
  type MergedConversationItem
} from "./mergedChat.js";
import { buildPairedModelCatalog, modelIsAvailable } from "./pairedCatalog.js";

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

type ConversationRunPollSnapshot =
  | { kind: "plaintext"; runs: RunRecord[] }
  | { kind: "e2ee"; runs: DecryptedRun[] };

type ConversationRunPollTarget = {
  conversationId: string;
  kind: ConversationRunPollSnapshot["kind"];
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
    cache: "no-store",
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

function formatMessageTime(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function formatLatency(startedAt: string, finishedAt: string) {
  const milliseconds = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
  if (milliseconds < 1000) return `${milliseconds} ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
}

/** Latency + token usage under a finished reply. Omit missing token fields (no placeholders). */
function MessageMetrics(props: {
  startedAt: string;
  finishedAt: string | null | undefined;
  inputTokens?: number | null | undefined;
  outputTokens?: number | null | undefined;
}) {
  if (!props.finishedAt) return null;
  const hasInput = typeof props.inputTokens === "number";
  const hasOutput = typeof props.outputTokens === "number";
  return (
    <div className="message-metrics">
      <span>Latency {formatLatency(props.startedAt, props.finishedAt)}</span>
      {hasInput ? <span>Input {props.inputTokens!.toLocaleString()} tokens</span> : null}
      {hasOutput ? <span>Output {props.outputTokens!.toLocaleString()} tokens</span> : null}
      {hasInput && hasOutput ? (
        <span>
          Total {(props.inputTokens! + props.outputTokens!).toLocaleString()} tokens
        </span>
      ) : null}
    </div>
  );
}

function isQuestionRun(run: RunRecord) {
  return run.idempotencyKey?.startsWith("qa:") ?? false;
}

/** Report calendar / display timezone for the web UI (server OS TZ unchanged). */
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
  return isRunStatusInFlight(run.status);
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

/**
 * Live heartbeat panel for an in-flight E2EE run. E2EE runs never reach the
 * plaintext RunProgressPanel path, so without this the conversation went silent
 * during long thinks — this ticks elapsed/beat locally and streams decrypted
 * runner progress while the model works.
 */
function E2eeRunProgressPanel({ run }: { run: DecryptedRun }) {
  const now = useNow(1000);
  const record = run.record;
  if (run.result) return null;
  if (record.status !== "queued" && record.status !== "running") return null;

  const elapsed = now - Date.parse(record.createdAt);
  const sinceUpdate = now - Date.parse(record.updatedAt);
  const kind: RunProgressKind | "queued" =
    run.progress?.progressKind ?? (record.status === "queued" ? "queued" : "thinking");
  const message =
    run.progress?.message?.trim() ||
    (record.status === "queued"
      ? "Queued — waiting for a runner to claim this job."
      : "Runner claimed the job. Live traces will stream here while the model works.");

  return (
    <div className="run-progress" data-kind={kind}>
      <div className="run-progress-bar">
        <span className="run-progress-kind">{kind}</span>
        <span className="run-progress-status">{record.status}</span>
        <span className="run-progress-elapsed">elapsed {formatElapsed(elapsed)}</span>
        <span className="run-progress-fresh">beat {formatElapsed(sinceUpdate)} ago</span>
        <span className="run-progress-pulse" aria-hidden="true" />
      </div>
      <pre className="run-progress-body">{message}</pre>
    </div>
  );
}

function reportIdFromPath(pathname = window.location.pathname): ReportId | undefined {
  const match = pathname.match(/^\/reports\/([^/]+)\/?$/);
  const candidate = match?.[1] as ReportId | undefined;
  return candidate && REPORT_IDS.has(candidate) ? candidate : undefined;
}

function isReportDetailPath(pathname = window.location.pathname) {
  return /^\/reports\/[^/]+\/?$/.test(pathname);
}

function UnknownReportPage() {
  return (
    <main className="reports-app" id="main">
      <header className="reports-topbar">
        <BrandMark />
        <TopTabs active="reports" />
      </header>
      <section className="report-welcome route-not-found">
        <div className="welcome-mark"><FileText aria-hidden="true" size={21} /></div>
        <h1>Report not found</h1>
        <p>This report link is no longer available. Choose another daily report.</p>
        <a className="primary-action" href="/reports">Open daily reports</a>
      </section>
    </main>
  );
}

export function App() {
  const reportId = reportIdFromPath();
  if (reportId) return <ReportsPage initialReportId={reportId} />;
  if (isReportDetailPath()) return <UnknownReportPage />;
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

/**
 * Topbar exposes the Windows desktop client download (`/api/desktop/download`).
 * This is the Tauri + WebView2 shell, NOT the legacy browser extension
 * (whose bundle still lives at `/api/extension/download` but is no longer promoted).
 */
const SECURE_WEB_ORIGIN = "https://secure.joelzt.org";

const SIDEBAR_COLLAPSED_KEY = "cursor-gateway:sidebar-collapsed";

function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      /* ignore quota / private mode */
    }
  }, [collapsed]);

  return [collapsed, setCollapsed] as const;
}

function SidebarCollapseToggle({
  collapsed,
  onToggle
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      aria-expanded={!collapsed}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className="sidebar-collapse-toggle"
      onClick={onToggle}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      type="button"
    >
      {collapsed ? (
        <PanelLeftOpen aria-hidden="true" size={16} strokeWidth={1.75} />
      ) : (
        <PanelLeftClose aria-hidden="true" size={16} strokeWidth={1.75} />
      )}
    </button>
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
  const [runPollTarget, setRunPollTarget] =
    useState<ConversationRunPollTarget | null>(null);
  const [prompt, setPrompt] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);
  const [memoryText, setMemoryText] = useState("");
  const [e2eeRequired, setE2eeRequired] = useState(false);
  const [secureClientOrigin, setSecureClientOrigin] = useState(SECURE_WEB_ORIGIN);
  const [e2eeKeys, setE2eeKeys] = useState<CsWebKeyStore | null>(null);
  const [e2eeDevice, setE2eeDevice] = useState<DeviceRecord | null>(null);
  const [e2eeRuns, setE2eeRuns] = useState<DecryptedRun[]>([]);
  const [e2eeTitles, setE2eeTitles] = useState<Record<string, string>>({});
  const [e2eeConversations, setE2eeConversations] = useState<
    Array<{ id: string; workspaceId: string; updatedAt: string }>
  >([]);
  const [lastE2eeRunId, setLastE2eeRunId] = useState<string | null>(null);
  const [e2eeEvidenceOpen, setE2eeEvidenceOpen] = useState(false);
  const [cfAccessLogoutUrl, setCfAccessLogoutUrl] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<
    Array<{ approvalId: string; request: E2eeDeviceApprovalRequest; expiresAt: string }>
  >([]);
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapsed();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const promptRef = useAutosizeTextarea(prompt);
  const e2eeEvidenceRef = useRef<HTMLDivElement>(null);
  const autoAuthStartedRef = useRef(false);
  const gatewayApi = useMemo(() => new GatewayApi(window.location.origin), []);
  const e2eePaired = Boolean(e2eeDevice?.pairedRunnerId);
  /** New messages always use E2EE once paired; required mode forces pairing first. */
  const useE2eeChat = e2eePaired;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const blocked = await detectIncompatibleStorage();
      if (cancelled) return;
      if (blocked) {
        setError(`本浏览器无法保存设备密钥：${blocked}`);
        return;
      }
      await requestPersistentStorage();
      const keys = await CsWebKeyStore.open();
      if (cancelled) return;
      setE2eeKeys(keys);
      if (window.location.hash.includes("cs_auth=")) {
        try {
          await completeCsDeviceAuthFromFragment({
            api: gatewayApi,
            keys
          });
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
      const device = await keys.device();
      if (!cancelled) setE2eeDevice(device);
    })().catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [gatewayApi]);

  useEffect(() => {
    if (!e2eeEvidenceOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (!e2eeEvidenceRef.current?.contains(event.target as Node)) {
        setE2eeEvidenceOpen(false);
      }
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setE2eeEvidenceOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [e2eeEvidenceOpen]);

  async function refresh(conversationId = selectedConversationId) {
    const [me, models, workspaces, runners, conversations, memory, policy, conversationRuns] =
      await Promise.all([
      api<{ principal: Principal }>("/api/me"),
      api<{ models: ModelInfo[]; defaultModelId?: string }>("/api/models"),
      api<{ workspaces: Workspace[] }>("/api/workspaces"),
      api<{ runners: ApiState["runners"] }>("/api/dashboard-runners"),
      api<{ conversations: Conversation[] }>("/api/conversations"),
      api<{ facts: MemoryFact[] }>("/api/memory"),
      api<{
        requiredForWeb: boolean;
        secureClientOrigin?: string | null;
        cfAccessLogoutUrl?: string | null;
        cfAccessTeamDomain?: string | null;
      }>("/api/e2ee-policy"),
      // Historical plaintext runs stay readable; e2ee ids return 404 → empty.
      conversationId
        ? api<{ runs: RunRecord[] }>(`/api/conversations/${conversationId}/runs`).catch(() => ({
            runs: [] as RunRecord[]
          }))
        : Promise.resolve({ runs: [] as RunRecord[] })
      ]);
    setE2eeRequired(policy.requiredForWeb);
    if (policy.secureClientOrigin) {
      setSecureClientOrigin(policy.secureClientOrigin);
    }
    if (policy.cfAccessLogoutUrl) {
      setCfAccessLogoutUrl(policy.cfAccessLogoutUrl);
    } else if (policy.cfAccessTeamDomain) {
      setCfAccessLogoutUrl(buildCfAccessLogoutUrl(policy.cfAccessTeamDomain));
    }

    // When E2EE is paired, the run routes to that runner's advertised workspaces
    // and models. Legacy `/api/workspaces` / `/api/models` only reflect in-memory
    // legacy/Hermes heartbeats — empty or Hermes-only under E2EE-only runners —
    // which left the dropdown at Auto and caused workspace_not_available_on_runner.
    let availableWorkspaces = workspaces.workspaces;
    let availableModels = models.models;
    let availableRunners = runners.runners;
    let e2eeConversationWorkspaceId: string | undefined;
    if (e2eeKeys && e2eePaired) {
      const client = new SecureGatewayClient(gatewayApi, e2eeKeys);
      // Each E2EE fetch is isolated: a failure in the runner catalog or the
      // conversation/title list must NEVER skip the runs refresh below, or the
      // conversation's latency/token metrics freeze at their last value while the
      // rest of the UI keeps ticking (the "prints once, never refreshes" bug).
      const pairedRunnerId = e2eeDevice?.pairedRunnerId;
      if (pairedRunnerId) {
        try {
          const directory = await client.runners();
          const paired = directory.find((runner) => runner.runnerId === pairedRunnerId);
          if (paired) {
            // Hermes is a plaintext Q&A-only sidecar that lives on the legacy
            // heartbeat registry (`/api/models` / `/api/dashboard-runners`), not
            // on the E2EE paired runner. Merge it in so E2EE web users can still
            // pick Hermes; its runs go over the plaintext `/api/runs` path.
            const hermesModels = models.models.filter((item) =>
              item.id.startsWith("hermes:")
            );
            // Legacy heartbeat entries have no `online` flag; derive it from
            // heartbeat freshness (Hermes beats every ~60s) so the header reads
            // "Ready" instead of "Will queue" for a live sidecar.
            const hermesRunners = runners.runners
              .filter((runner) => runner.models.some((item) => item.id.startsWith("hermes:")))
              .map((runner) => ({
                ...runner,
                online:
                  runner.online ??
                  Date.now() - Date.parse(runner.lastSeenAt) < 120_000
              }));
            availableModels = buildPairedModelCatalog(paired.models, hermesModels);
            availableRunners = [
              {
                runnerId: paired.runnerId,
                lastSeenAt: paired.lastSeenAt,
                online: paired.online,
                workspaces: paired.workspaces.map((item) => ({
                  id: item.id,
                  label: item.label,
                  path: "",
                  writable: item.writable
                })),
                models: paired.models
              },
              ...hermesRunners
            ];
            if (paired.workspaces.length) {
              availableWorkspaces = paired.workspaces.map((item) => ({
                id: item.id,
                label: item.label,
                path: "",
                writable: item.writable
              }));
            }
          }
        } catch (err) {
          // Runner directory is best-effort; keep the last-known catalog.
          setError(err instanceof Error ? err.message : String(err));
        }
      }
      try {
        const list = await client.conversations();
        e2eeConversationWorkspaceId = list.find((item) => item.id === conversationId)?.workspaceId;
        setE2eeConversations(
          list.map((item) => ({
            id: item.id,
            workspaceId: item.workspaceId,
            updatedAt: item.updatedAt
          }))
        );
        const titles: Record<string, string> = {};
        for (const conversation of list) {
          titles[conversation.id] = await client.title(conversation);
        }
        setE2eeTitles(titles);
      } catch (err) {
        // Keep the last-known conversation list/titles; still refresh runs below.
        setError(err instanceof Error ? err.message : String(err));
      }
      if (conversationId) {
        try {
          const decrypted = await client.runs(conversationId);
          setE2eeRuns(decrypted);
        } catch {
          setE2eeRuns([]);
        }
      } else {
        setE2eeRuns([]);
      }
    } else {
      setE2eeConversations([]);
      setE2eeRuns([]);
    }

    setState({
      principal: me.principal,
      models: availableModels,
      workspaces: availableWorkspaces,
      runners: availableRunners,
      conversations: conversations.conversations,
      conversationRuns: conversationRuns.runs,
      memory: memory.facts
    });

    const selected = conversations.conversations.find((item) => item.id === conversationId);
    if (selected) setWorkspaceId(selected.workspaceId);
    else if (e2eeConversationWorkspaceId) setWorkspaceId(e2eeConversationWorkspaceId);
    else {
      setWorkspaceId((current) =>
        availableWorkspaces.some((item) => item.id === current)
          ? current
          : availableWorkspaces[0]?.id || ""
      );
    }
    const preferredDefault = models.defaultModelId || "auto";
    setDefaultModelId(preferredDefault);
    setModel((current) => {
      // Keep an explicit, still-valid user choice; otherwise fall back to the
      // server-configured default model. Treat the legacy implicit "auto" as
      // unset so a newly configured default takes effect.
      if (current && current !== "auto" && modelIsAvailable(availableModels, current)) {
        return current;
      }
      if (modelIsAvailable(availableModels, preferredDefault)) return preferredDefault;
      return "auto";
    });
  }

  useEffect(() => {
    let current = true;
    refresh(selectedConversationId).catch((err) =>
      current ? setError(err instanceof Error ? err.message : String(err)) : undefined
    );
    return () => {
      current = false;
    };
  }, [selectedConversationId, e2eeKeys, e2eePaired]);

  /** When E2EE is required, auto-enter Secure authorization after login (no manual「启用加密」). */
  useEffect(() => {
    if (!e2eeRequired) {
      autoAuthStartedRef.current = false;
      return;
    }
    if (e2eePaired) {
      autoAuthStartedRef.current = false;
      return;
    }
    if (!e2eeKeys) return;
    if (window.location.hash.includes("cs_auth=")) return;
    if (autoAuthStartedRef.current) return;
    autoAuthStartedRef.current = true;
    void authorizeE2ee();
    // authorizeE2ee is stable enough via closure; intentional one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e2eeRequired, e2eePaired, e2eeKeys, secureClientOrigin]);

  /** Old paired CS browser: poll Secure "paired-device approval" requests for this Access user. */
  useEffect(() => {
    if (!e2eePaired || !e2eeKeys) {
      setPendingApprovals([]);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const list = await listPendingApprovals(gatewayApi);
        if (!cancelled) setPendingApprovals(list);
      } catch {
        // Non-fatal: approval banner is best-effort while chatting.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [e2eePaired, e2eeKeys, gatewayApi]);

  async function onDecidePendingApproval(
    request: E2eeDeviceApprovalRequest,
    decision: "approved" | "rejected"
  ) {
    if (!e2eeKeys) return;
    setApprovalBusyId(request.approvalId);
    setError("");
    try {
      await decideDeviceApproval({ api: gatewayApi, keys: e2eeKeys, request, decision });
      setPendingApprovals((current) =>
        current.filter((item) => item.approvalId !== request.approvalId)
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? `设备批准失败：${err.message}`
          : "设备批准失败"
      );
    } finally {
      setApprovalBusyId(null);
    }
  }

  async function authorizeE2ee() {
    if (!e2eeKeys) {
      setError("设备密钥尚未就绪");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await beginCsDeviceAuth({
        api: gatewayApi,
        keys: e2eeKeys,
        secureOrigin: secureClientOrigin || SECURE_WEB_ORIGIN
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }

  async function logoutE2ee() {
    if (!window.confirm(E2EE_LOGOUT_CONFIRM)) return;
    setLoading(true);
    setError("");
    setE2eeEvidenceOpen(false);
    try {
      await clearLocalE2eeAuthorization({
        api: gatewayApi,
        keys: e2eeKeys,
        clientId: e2eeDevice?.clientId ?? null
      });
      setE2eeKeys(null);
      setE2eeDevice(null);
      setE2eeRuns([]);
      setE2eeTitles({});
      setE2eeConversations([]);
      setLastE2eeRunId(null);
      setSelectedConversationId("");
      setRunPollTarget(null);
      const keys = await CsWebKeyStore.open();
      const device = await keys.device();
      setE2eeKeys(keys);
      setE2eeDevice(device);
      window.alert(E2EE_LOGOUT_DONE);
      if (cfAccessLogoutUrl && window.confirm(E2EE_ACCESS_LOGOUT_CONFIRM)) {
        try {
          const url = new URL(cfAccessLogoutUrl);
          url.searchParams.set("returnTo", window.location.origin);
          window.location.assign(url.toString());
        } catch {
          window.location.assign(cfAccessLogoutUrl);
        }
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const selectedWorkspace = useMemo(
    () => state.workspaces.find((workspace) => workspace.id === workspaceId),
    [state.workspaces, workspaceId]
  );
  const mergedConversations = useMemo(
    () =>
      mergeConversationLists({
        plaintext: state.conversations,
        e2ee: e2eeConversations,
        e2eeTitles
      }),
    [state.conversations, e2eeConversations, e2eeTitles]
  );
  const selectedMerged: MergedConversationItem | undefined = useMemo(
    () => mergedConversations.find((conversation) => conversation.id === selectedConversationId),
    [mergedConversations, selectedConversationId]
  );
  const selectedConversation = useMemo(
    () => state.conversations.find((conversation) => conversation.id === selectedConversationId),
    [state.conversations, selectedConversationId]
  );
  const timeline = useMemo(
    () =>
      buildMergedTimeline({
        plaintextRuns: state.conversationRuns,
        e2eeRuns
      }),
    [state.conversationRuns, e2eeRuns]
  );
  const selectedRunKind =
    (runPollTarget?.conversationId === selectedConversationId
      ? runPollTarget.kind
      : undefined) ??
    selectedMerged?.kind ??
    (e2eeRuns.some((run) => run.record.conversationId === selectedConversationId)
      ? "e2ee"
      : state.conversationRuns.some(
            (run) => run.conversationId === selectedConversationId
          )
        ? "plaintext"
        : undefined);
  const selectedConversationHasInFlightRun =
    state.conversationRuns.some(
      (run) =>
        run.conversationId === selectedConversationId && isRunInFlight(run)
    ) ||
    e2eeRuns.some(
      (run) =>
        run.record.conversationId === selectedConversationId &&
        isRunStatusInFlight(run.record.status)
    );
  const selectedConversationNeedsPolling =
    selectedConversationHasInFlightRun ||
    runPollTarget?.conversationId === selectedConversationId;
  const viewingHistoricalPlaintext = selectedMerged?.kind === "plaintext";
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
    if (
      !selectedConversationId ||
      !selectedRunKind ||
      !selectedConversationNeedsPolling ||
      loading
    ) {
      return;
    }
    if (selectedRunKind === "e2ee" && !e2eeKeys) return;

    const conversationId = selectedConversationId;
    const kind = selectedRunKind;
    const secureClient =
      kind === "e2ee" && e2eeKeys
        ? new SecureGatewayClient(gatewayApi, e2eeKeys)
        : null;
    const poller = createRunPollingLoop<ConversationRunPollSnapshot>({
      load: async () => {
        if (kind === "e2ee") {
          return {
            kind,
            runs: await secureClient!.runs(conversationId)
          };
        }
        const response = await api<{ runs: RunRecord[] }>(
          `/api/conversations/${conversationId}/runs`
        );
        return { kind, runs: response.runs };
      },
      apply: (snapshot) => {
        const statuses =
          snapshot.kind === "e2ee"
            ? snapshot.runs.map((run) => run.record.status)
            : snapshot.runs.map((run) => run.status);
        if (snapshot.kind === "e2ee") {
          setE2eeRuns(snapshot.runs);
        } else {
          setState((current) => ({
            ...current,
            conversationRuns: snapshot.runs
          }));
        }
        if (!statuses.some(isRunStatusInFlight)) {
          setRunPollTarget((current) =>
            current?.conversationId === conversationId ? null : current
          );
        }
      },
      statuses: (snapshot) =>
        snapshot.kind === "e2ee"
          ? snapshot.runs.map((run) => run.record.status)
          : snapshot.runs.map((run) => run.status),
      isBackground: () => document.visibilityState === "hidden"
    });
    const wakeWhenVisible = () => {
      if (document.visibilityState === "visible") poller.wake();
    };
    const wakeOnFocus = () => poller.wake();

    document.addEventListener("visibilitychange", wakeWhenVisible);
    window.addEventListener("focus", wakeOnFocus);
    poller.start();
    return () => {
      document.removeEventListener("visibilitychange", wakeWhenVisible);
      window.removeEventListener("focus", wakeOnFocus);
      poller.stop();
    };
  }, [
    e2eeKeys,
    gatewayApi,
    loading,
    selectedConversationId,
    selectedConversationNeedsPolling,
    selectedRunKind
  ]);

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
    timeline.length,
    timeline.map((turn) => turn.id).join(","),
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
    setRunPollTarget(null);
    setPrompt("");
    setError("");
  }

  async function submitRun(event: FormEvent) {
    event.preventDefault();
    if (e2eeRequired && !e2eePaired) {
      setError("此 Gateway 要求加密聊天：正在引导完成设备授权…");
      if (!autoAuthStartedRef.current && e2eeKeys) {
        autoAuthStartedRef.current = true;
        void authorizeE2ee();
      }
      return;
    }
    setLoading(true);
    setError("");
    try {
      // Hermes is a plaintext Q&A-only sidecar and cannot run over E2EE (the
      // encrypted submit path rejects it). Route it through the plaintext
      // `/api/runs` path even while this browser is E2EE-paired.
      const useHermesPlaintext = model.startsWith("hermes:");
      if (e2eePaired && e2eeKeys && e2eeDevice?.pairedRunnerId && !useHermesPlaintext) {
        const client = new SecureGatewayClient(gatewayApi, e2eeKeys);
        // Historical plaintext threads are read-only; replies open a new E2EE conversation.
        const continueE2eeId =
          selectedConversationId && selectedMerged?.kind === "e2ee"
            ? selectedConversationId
            : undefined;
        const run = await client.submitRun({
          runnerId: e2eeDevice.pairedRunnerId,
          workspaceId,
          model,
          prompt,
          allowWrites,
          ...(continueE2eeId ? { conversationId: continueE2eeId } : {})
        });
        setLastE2eeRunId(run.id);
        setRunPollTarget({ conversationId: run.conversationId, kind: "e2ee" });
        setPrompt("");
        setSelectedConversationId(run.conversationId);
        await refresh(run.conversationId);
      } else {
        const result = await api<{ run: RunRecord }>("/api/runs", {
          method: "POST",
          body: JSON.stringify({
            origin: "web",
            prompt,
            ...(selectedConversationId && selectedMerged?.kind === "plaintext"
              ? { conversationId: selectedConversationId }
              : {}),
            model,
            workspaceId,
            memoryEnabled: true,
            allowWrites
          })
        });
        setPrompt("");
        setRunPollTarget({
          conversationId: result.run.conversationId,
          kind: "plaintext"
        });
        setSelectedConversationId(result.run.conversationId);
        await refresh(result.run.conversationId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function addMemory(event: FormEvent) {
    event.preventDefault();
    if (e2eeRequired || useE2eeChat) {
      setError(
        e2eeRequired && !e2eePaired
          ? "Memory 写入需先完成加密授权。"
          : "本页 Memory 明文写入已关闭；请使用 Secure Web 或仅浏览历史。"
      );
      return;
    }
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
    if (!selectedConversation || selectedMerged?.kind === "e2ee") return;
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
        <div className="topbar-actions">
          {e2eePaired ? (
            <div className="e2ee-status-slot" ref={e2eeEvidenceRef}>
              <button
                aria-expanded={e2eeEvidenceOpen}
                aria-label={E2EE_ENCRYPTED_BADGE}
                className={`e2ee-status-badge${e2eeEvidenceOpen ? " is-open" : ""}`}
                onClick={() => setE2eeEvidenceOpen((open) => !open)}
                title={E2EE_ENCRYPTED_BADGE}
                type="button"
              >
                <LockKeyhole aria-hidden="true" size={15} strokeWidth={2} />
              </button>
              {e2eeEvidenceOpen ? (
                <div className="e2ee-evidence-panel" role="dialog" aria-label="加密证据">
                  <p className="e2ee-evidence-title">
                    <LockKeyhole aria-hidden="true" size={14} strokeWidth={2} />
                    <span>{E2EE_ENCRYPTED_BADGE}</span>
                  </p>
                  <p className="e2ee-evidence-note">
                    此徽章仅为 UI 状态，不是密码学证明。请结合 Network / 审计 / DB 自证。
                  </p>
                  <dl>
                    <div>
                      <dt>协议</dt>
                      <dd>cg-e2ee/1</dd>
                    </div>
                    <div>
                      <dt>content_mode</dt>
                      <dd>e2ee-v1</dd>
                    </div>
                    <div>
                      <dt>Runner</dt>
                      <dd>{e2eeDevice?.pairedRunnerId ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>最近 runId</dt>
                      <dd title={lastE2eeRunId ?? undefined}>
                        {lastE2eeRunId ?? "发送一条加密消息后显示"}
                      </dd>
                    </div>
                  </dl>
                  <button
                    className="e2ee-logout-in-panel"
                    disabled={loading}
                    onClick={logoutE2ee}
                    type="button"
                  >
                    {E2EE_LOGOUT_LABEL}并重新配对
                  </button>
                </div>
              ) : null}
            </div>
          ) : e2eeRequired ? (
            <button
              className="topbar-link e2ee-enable-link"
              disabled={loading || !e2eeKeys}
              onClick={authorizeE2ee}
              title="必须完成加密授权后才能聊天"
              type="button"
            >
              <LockKeyholeOpen aria-hidden="true" size={15} strokeWidth={1.75} />
              <span>{loading ? "授权中…" : "完成加密授权"}</span>
            </button>
          ) : (
            <button
              className="topbar-link e2ee-enable-link"
              disabled={loading || !e2eeKeys}
              onClick={authorizeE2ee}
              title="可选：经 Secure 一次性授权后，本页用 cg-e2ee/1 加密"
              type="button"
            >
              <LockKeyholeOpen aria-hidden="true" size={15} strokeWidth={1.75} />
              <span>启用加密</span>
            </button>
          )}
          <a
            className="topbar-link"
            href="/api/desktop/download"
            title="下载 Windows 加密对话客户端安装包（NSIS .exe，本地加载 UI，非浏览器扩展）"
          >
            <Download aria-hidden="true" size={15} strokeWidth={1.75} />
            <span>下载 Windows 客户端</span>
          </a>
          <a className="topbar-link" href="/trash">
            <Trash2 aria-hidden="true" size={15} strokeWidth={1.75} />
            <span>Recycle Bin</span>
          </a>
        </div>
      </header>

      <div className={`home-layout${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
        <aside className="home-sidebar" aria-label="Conversations">
          <div className="sidebar-toolbar">
            <button
              className="new-chat-button"
              type="button"
              onClick={startNewConversation}
              title="New chat"
            >
              <Plus aria-hidden="true" size={17} strokeWidth={2} />
              <span>New chat</span>
            </button>
            <SidebarCollapseToggle
              collapsed={sidebarCollapsed}
              onToggle={() => setSidebarCollapsed((value) => !value)}
            />
          </div>

          <div className="conversation-list">
            {mergedConversations.map((conversation, index) => (
              <button
                className={conversation.id === selectedConversationId ? "active" : ""}
                key={conversation.id}
                onClick={() => {
                  setSelectedConversationId(conversation.id);
                  setWorkspaceId(conversation.workspaceId);
                }}
                style={{ ["--i" as string]: index } as CSSProperties}
                title={conversation.title}
                type="button"
              >
                <span className="conversation-glyph">
                  {conversation.kind === "e2ee" ? (
                    <LockKeyhole aria-hidden="true" size={15} strokeWidth={1.75} />
                  ) : (
                    <MessageSquare aria-hidden="true" size={15} strokeWidth={1.75} />
                  )}
                </span>
                <span>
                  <strong>{conversation.title}</strong>
                  <small>
                    {conversation.kind === "e2ee"
                      ? `加密 · ${conversation.workspaceId}`
                      : `${HISTORICAL_PLAINTEXT_LABEL} · ${conversation.runCount ?? 0} 组`}
                  </small>
                </span>
              </button>
            ))}
            {mergedConversations.length === 0 ? (
              <p className="sidebar-empty">
                {e2eeRequired && !e2eePaired
                  ? "完成加密授权后开始聊天。"
                  : "新建加密会话后会出现在这里。"}
              </p>
            ) : null}
          </div>

          <details className="memory-drawer">
            <summary><Database aria-hidden="true" size={14} /> Memory <span>{state.memory.length}</span></summary>
            <form onSubmit={addMemory}>
              <textarea
                value={memoryText}
                onChange={(event) => setMemoryText(event.target.value)}
                placeholder={
                  e2eeRequired && !e2eePaired
                    ? "Authorize this browser for E2EE first"
                    : useE2eeChat
                      ? "E2EE memory: use Secure Web for now"
                      : "Add a durable preference…"
                }
                rows={2}
                disabled={e2eeRequired || useE2eeChat}
              />
              <button disabled={e2eeRequired || !memoryText.trim()}>Save memory</button>
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
              <h1>{selectedMerged?.title ?? "新加密会话"}</h1>
              <p>
                <span className={`runner-dot ${selectedModelOnline ? "online" : ""}`} />
                {selectedModelOnline ? "Ready" : "Will queue"} · {selectedModelName}
                {viewingHistoricalPlaintext ? ` · ${HISTORICAL_PLAINTEXT_LABEL}` : null}
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
              {selectedConversation && selectedMerged?.kind === "plaintext" ? (
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
            {e2eePaired && pendingApprovals.length > 0 ? (
              <section className="e2ee-device-approval" aria-live="polite">
                <LockKeyhole aria-hidden="true" size={22} />
                <div>
                  <h2>有新设备请求配对批准</h2>
                  <p>
                    另一台设备在 Secure Web 选择了「已配对设备批准」。请在此用本机已授权密钥批准或拒绝（同一
                    Cloudflare Access 账号）。
                  </p>
                  <ul className="e2ee-device-approval-list">
                    {pendingApprovals.map((item) => (
                      <li key={item.approvalId}>
                        <span>
                          {item.request.label?.trim() || "新设备"}
                          {" · "}
                          <code>{item.request.newClientId.slice(0, 8)}…</code>
                          {" · 过期 "}
                          {new Date(item.expiresAt).toLocaleString()}
                        </span>
                        <span className="e2ee-device-approval-actions">
                          <button
                            disabled={approvalBusyId === item.approvalId}
                            onClick={() => void onDecidePendingApproval(item.request, "approved")}
                            type="button"
                          >
                            批准
                          </button>
                          <button
                            className="secondary"
                            disabled={approvalBusyId === item.approvalId}
                            onClick={() => void onDecidePendingApproval(item.request, "rejected")}
                            type="button"
                          >
                            拒绝
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            ) : null}
            {e2eeRequired && !e2eePaired ? (
              <section className="e2ee-required" aria-live="polite">
                <LockKeyhole aria-hidden="true" size={22} />
                <div>
                  <h2>必须完成加密授权才能使用</h2>
                  <p>
                    登录后会自动跳转授权。私钥只留本页，经{" "}
                    <a href={secureClientOrigin || SECURE_WEB_ORIGIN} rel="noreferrer">
                      Secure Web
                    </a>{" "}
                    配对后返回并带上授权。手机请尽量用同一浏览器打开邮件链接。
                  </p>
                  <p>
                    <button disabled={loading || !e2eeKeys} onClick={authorizeE2ee} type="button">
                      {loading ? "跳转中…" : "立即授权本浏览器"}
                    </button>
                  </p>
                </div>
              </section>
            ) : null}
            {timeline.map((turn, index) => {
              if (turn.kind === "e2ee") {
                const run = turn.run as (typeof e2eeRuns)[number];
                return (
                  <div
                    className="chat-turn"
                    key={`e2ee:${run.record.id}`}
                    style={{ ["--i" as string]: index } as CSSProperties}
                  >
                    <div className="chat-message user-message">
                      <div className="message-body">{run.request.prompt}</div>
                      <div className="user-message-meta">
                        <time dateTime={run.record.createdAt}>
                          Sent {formatMessageTime(run.record.createdAt)}
                        </time>
                      </div>
                    </div>
                    <div className="chat-message assistant-message">
                      <div className="message-avatar">AI</div>
                      <div className="message-main">
                        <div className="message-meta">
                          <strong>Agent</strong>
                          <span className="message-model">{run.request.routing.model}</span>
                        </div>
                        {run.result?.response ? <Markdown>{run.result.response}</Markdown> : null}
                        {run.result?.error ? <pre className="error-pre">{run.result.error}</pre> : null}
                        {!run.result &&
                        (run.record.status === "error" ||
                          run.record.status === "cancelled") ? (
                          <pre className="error-pre">
                            请求已由执行端安全终止。请确认设备仍已配对后重试。
                          </pre>
                        ) : null}
                        <E2eeRunProgressPanel run={run} />
                        <MessageMetrics
                          startedAt={run.record.startedAt ?? run.record.createdAt}
                          finishedAt={run.record.finishedAt}
                          inputTokens={run.result?.inputTokens}
                          outputTokens={run.result?.outputTokens}
                        />
                        <div
                          className="e2ee-run-meta"
                          title={e2eeRunEvidenceTitle(run.record.id)}
                        >
                          e2ee-v1 · {run.record.id.slice(0, 8)}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }

              const run = turn.run as RunRecord;
              return (
                <div
                  className="chat-turn"
                  key={`plain:${run.id}`}
                  style={{ ["--i" as string]: index } as CSSProperties}
                >
                  <div className="chat-message user-message">
                    <div className="message-body">{run.prompt}</div>
                    <div className="user-message-meta">
                      <time dateTime={run.createdAt}>Sent {formatMessageTime(run.createdAt)}</time>
                      <span className="historical-plain-tag">{HISTORICAL_PLAINTEXT_LABEL}</span>
                    </div>
                  </div>
                  <div className="chat-message assistant-message">
                    <div className="message-avatar">{run.model.startsWith("hermes:") ? "H" : "AI"}</div>
                    <div className="message-main">
                      <div className="message-meta">
                        <strong>{run.model.startsWith("hermes:") ? "Hermes" : "Agent"}</strong>
                        <span className="message-model">{run.model}</span>
                        <span className="historical-plain-tag">{HISTORICAL_PLAINTEXT_LABEL}</span>
                        {run.finishedAt ? (
                          <time dateTime={run.finishedAt}>
                            Answered {formatMessageTime(run.finishedAt)}
                          </time>
                        ) : null}
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
                      <MessageMetrics
                        startedAt={run.createdAt}
                        finishedAt={run.finishedAt}
                        inputTokens={run.inputTokens}
                        outputTokens={run.outputTokens}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
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
                    e2eeRequired && !e2eePaired
                      ? "先完成加密授权…"
                      : selectedHermesModel
                        ? "Hermes 明文问答（不加密、只读）"
                        : viewingHistoricalPlaintext
                          ? "历史明文只读；发送将开启新的加密会话"
                          : "加密消息发给已配对 Runner"
                  }
                  rows={1}
                  disabled={e2eeRequired && !e2eePaired}
                />
                <button
                  aria-label="Send message"
                  disabled={
                    (e2eeRequired && !e2eePaired) ||
                    loading ||
                    !prompt.trim() ||
                    !workspaceId
                  }
                >
                  {loading ? <SendBusy /> : <ArrowUp aria-hidden="true" size={18} strokeWidth={2} />}
                </button>
              </div>
              <div className="composer-options">
                <label>
                  <span>Workspace</span>
                  <select
                    value={workspaceId}
                    disabled={Boolean(selectedMerged?.kind === "e2ee" && selectedConversationId)}
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
                    disabled={
                      (e2eeRequired && !e2eePaired) ||
                      selectedHermesModel ||
                      !selectedWorkspace?.writable
                    }
                    onChange={(event) => setAllowWrites(event.target.checked)}
                  />
                  Allow writes
                </label>
                <span className="composer-hint">
                  {selectedHermesModel
                    ? "Hermes 明文问答（不加密、只读）"
                    : viewingHistoricalPlaintext
                      ? "历史明文可查看；回复会新建加密会话"
                      : selectedMerged?.kind === "e2ee"
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
  canAskQuestions?: boolean;
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
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapsed();
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
        <div className="topbar-actions">
          <a
            className="topbar-link"
            href="/api/desktop/download"
            title="下载 Windows 加密对话客户端安装包（NSIS .exe，本地加载 UI，非浏览器扩展）"
          >
            <Download aria-hidden="true" size={15} strokeWidth={1.75} />
            <span>下载 Windows 客户端</span>
          </a>
          <a className="topbar-link" href="/trash">
            <Trash2 aria-hidden="true" size={15} strokeWidth={1.75} />
            <span>Recycle Bin</span>
          </a>
        </div>
      </header>

      <div className={`reports-layout${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
        <aside className="reports-sidebar" aria-label="Daily reports">
          <div className="sidebar-toolbar">
            <div className="sidebar-heading">
              <span>Daily reports</span>
              <small>{configured ? "AI ready" : "Setup pending"}</small>
            </div>
            <SidebarCollapseToggle
              collapsed={sidebarCollapsed}
              onToggle={() => setSidebarCollapsed((value) => !value)}
            />
          </div>
          <div className="report-thread-list">
            {reports.map((report, index) => (
              <a
                className={report.id === selectedReportId ? "active" : ""}
                href={`/reports/${report.id}`}
                key={report.id}
                style={{ ["--i" as string]: index } as CSSProperties}
                title={report.shortName}
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

          {detail?.canAskQuestions === false ? (
            <div className="report-release-cta">
              <div>
                <strong>把今天的面经变成你的训练计划</strong>
                <span>付款激活后，可使用个人进度、题目推荐和定制化 AI 面试问答。</span>
              </div>
              <a href="/interview">进入定制训练</a>
            </div>
          ) : (
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
          )}
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
        <div className="topbar-actions">
          <a className="topbar-link" href="/trash" aria-current="page">
            <Trash2 aria-hidden="true" size={15} strokeWidth={1.75} />
            <span>Recycle Bin</span>
          </a>
        </div>
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
