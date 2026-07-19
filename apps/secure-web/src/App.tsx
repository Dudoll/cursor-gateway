import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from "react";
import { flushSync } from "react-dom";
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
import { pairWithPasskey } from "./passkeyPairing.js";
import { errorText } from "./errorText.js";
import {
  decideDeviceApproval,
  listPendingApprovals,
  requestDeviceApproval,
  waitForDeviceApprovalResult
} from "./deviceApprovalClient.js";
import {
  clearRecoveryFragment,
  pairWithRecovery,
  parseRecoveryFragment
} from "./recoveryPairingClient.js";
import {
  confirmRunnerCode,
  deriveRunnerCodeSas,
  startRunnerCodeEnrollment
} from "./runnerCodePairingClient.js";
import type { E2eeRunnerCodePairingOffer } from "@cursor-gateway/shared";
import {
  ackRootSas,
  computeRootSas,
  isRootSasAcked,
  matchRootSas,
  normalizeSasInput,
  type RootSasEntry
} from "./rootSasVerify.js";
import {
  CS_AUTH_RETURNING_NOTICE,
  captureCsAuthRedirectParams,
  completeCsAuthReturn,
  delayBeforeCsRedirect,
  formatCsAuthReturnError,
  loadPendingCsAuthRedirect
} from "./csAuthReturn.js";
import type { CsAuthRedirectParams } from "@cursor-gateway/e2ee";
import { SecureGatewayClient, type DecryptedRun } from "./secureClient.js";
import type {
  E2eeConversationRecord,
  E2eeDeviceApprovalRequest,
  E2eeRunnerDirectoryEntry,
  RunProgressKind
} from "@cursor-gateway/shared";
import {
  E2EE_ACCESS_LOGOUT_CONFIRM,
  E2EE_LOGOUT_CONFIRM,
  E2EE_LOGOUT_DONE,
  E2EE_LOGOUT_LABEL,
  clearLocalE2eeAuthorization
} from "./e2eeLogout.js";
import {
  desktopAccessShow,
  desktopAppVersion,
  desktopDiagnosticsPath,
  desktopInstallUpdate,
  desktopReadDiagnostics,
  isDesktopShell
} from "./desktopShell.js";
import {
  ArrowUp,
  ArrowUpCircle,
  LockKeyhole,
  LogOut,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw
} from "lucide-react";
import {
  initialFlowState,
  transitionFlow,
  type FlowEvent,
  type FlowState,
  type PairingMethod
} from "./flowMachine.js";
import {
  normalizeFailure,
  persistDiagnostic,
  persistOperationalDiagnostic,
  type FailureContext
} from "./diagnostics.js";
import { StatusNotice, type UiStatus } from "./StatusNotice.js";
import {
  checkDesktopUpdate,
  DESKTOP_UPDATE_METADATA_URL,
  type DesktopUpdateMetadata
} from "./updateChecker.js";
import {
  waitForStableAccess,
  type AccessRetryEvent
} from "./accessRetry.js";
import { Markdown } from "./Markdown.js";

type BootState =
  | { kind: "loading" }
  | { kind: "blocked"; reason: string }
  | { kind: "ready"; keys: SecureWebKeyStore; device: DeviceRecord };

type DesktopAccessPolicy = {
  cfAccessLogoutUrl?: string | null;
  runnerCodePairingEnabled?: boolean;
  secureClientOrigin?: string | null;
};

/**
 * Desktop: after the Access bridge window pops, poll the Gateway until Cloudflare
 * Access login completes (the bridge stops returning `cloudflare_login_required`).
 * The Rust `desktop_access_show` command returns immediately so the window is
 * visible right away; login is detected here instead of blocking the invoke.
 */
async function waitForDesktopAccessLogin(
  clientApi: GatewayApi,
  options?: {
    signal?: AbortSignal;
    onAttempt?: (event: AccessRetryEvent) => void;
  }
): Promise<DesktopAccessPolicy> {
  return waitForStableAccess({
    probe: () => clientApi.get<DesktopAccessPolicy>("/api/e2ee-policy"),
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.onAttempt ? { onAttempt: options.onAttempt } : {}),
    totalTimeoutMs: 300_000,
    maxAttempts: 120,
    maxTransientFailures: 8,
    requiredConsecutiveSuccesses: 2
  });
}

function flowReducer(
  state: FlowState,
  event: FlowEvent
): FlowState {
  return transitionFlow(state, event).state;
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

function MessageMetrics({ run }: { run: DecryptedRun }) {
  if (!run.record.finishedAt) return null;
  const inputTokens = run.result?.inputTokens;
  const outputTokens = run.result?.outputTokens;
  const hasInput = typeof inputTokens === "number";
  const hasOutput = typeof outputTokens === "number";
  return (
    <div className="message-metrics">
      <span>
        Latency {formatLatency(run.record.startedAt ?? run.record.createdAt, run.record.finishedAt)}
      </span>
      {hasInput ? <span>Input {inputTokens!.toLocaleString()} tokens</span> : null}
      {hasOutput ? <span>Output {outputTokens!.toLocaleString()} tokens</span> : null}
      {hasInput && hasOutput ? (
        <span>Total {(inputTokens! + outputTokens!).toLocaleString()} tokens</span>
      ) : null}
    </div>
  );
}

function E2eeRunProgressPanel({ run }: { run: DecryptedRun }) {
  const now = useNow();
  if (run.result || (run.record.status !== "queued" && run.record.status !== "running")) {
    return null;
  }
  const kind: RunProgressKind | "queued" =
    run.progress?.progressKind ?? (run.record.status === "queued" ? "queued" : "thinking");
  const message =
    run.progress?.message?.trim() ||
    (run.record.status === "queued"
      ? "已进入队列，正在等待 Runner 接收任务。"
      : "Runner 已接收任务，正在安全处理。实时进度会显示在这里。");
  return (
    <div className="run-progress" data-kind={kind}>
      <div className="run-progress-bar">
        <span className="run-progress-kind">{kind}</span>
        <span className="run-progress-status">{run.record.status}</span>
        <span>elapsed {formatElapsed(now - Date.parse(run.record.createdAt))}</span>
        <span className="run-progress-pulse" aria-hidden="true" />
      </div>
      <pre className="run-progress-body">{message}</pre>
    </div>
  );
}

export function App() {
  const [boot, setBoot] = useState<BootState>({ kind: "loading" });
  const [gatewayInput, setGatewayInput] = useState(
    savedGatewayOrigin() || "https://cs.joelzt.org"
  );
  const [status, setStatus] = useState<UiStatus | null>(null);
  const [pairId, setPairId] = useState<string | null>(null);
  const [flow, dispatchFlow] = useReducer(flowReducer, initialFlowState);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<
    Array<{ approvalId: string; request: E2eeDeviceApprovalRequest; expiresAt: string }>
  >([]);
  const [recoveryIdInput, setRecoveryIdInput] = useState("");
  const [recoverySecretInput, setRecoverySecretInput] = useState("");
  const [runnerCodeEnabled, setRunnerCodeEnabled] = useState(false);
  const [runnerCodeEnrollId, setRunnerCodeEnrollId] = useState<string | null>(null);
  const [runnerCodeOffer, setRunnerCodeOffer] = useState<E2eeRunnerCodePairingOffer | null>(null);
  const [runnerCodeInput, setRunnerCodeInput] = useState("");
  const [runnerCodeSasWords, setRunnerCodeSasWords] = useState<string[] | null>(null);
  const [rootSasEntries, setRootSasEntries] = useState<RootSasEntry[]>([]);
  const [rootSasInput, setRootSasInput] = useState("");
  const [rootSasState, setRootSasState] = useState<"unknown" | "verified" | "failed">("unknown");
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [csAuthPending, setCsAuthPending] = useState<CsAuthRedirectParams | null>(null);
  const [cfAccessLogoutUrl, setCfAccessLogoutUrl] = useState<string | null>(null);
  const [desktopShell] = useState(() => isDesktopShell());
  const [accessReady, setAccessReady] = useState(!isDesktopShell());
  const [updateAvailable, setUpdateAvailable] = useState<DesktopUpdateMetadata | null>(null);
  const [updateDiagnostic, setUpdateDiagnostic] = useState<UiStatus | null>(null);
  const [localDesktopVersion, setLocalDesktopVersion] = useState<string | null>(null);
  const [passkeyOrigin, setPasskeyOrigin] = useState("https://secure.joelzt.org");
  const [updateCheckGeneration, setUpdateCheckGeneration] = useState(0);
  const [diagnosticHistory, setDiagnosticHistory] = useState<{
    count: number;
    path: string | null;
  }>({ count: 0, path: null });
  const accessStepRef = useRef<HTMLElement>(null);
  const pairingStepRef = useRef<HTMLElement>(null);
  const verificationStepRef = useRef<HTMLElement>(null);
  const completeStepRef = useRef<HTMLElement>(null);
  const chatStepRef = useRef<HTMLElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const verificationAbortRef = useRef<AbortController | null>(null);
  const accessLoginAbortRef = useRef<AbortController | null>(null);
  const accessAutoRetryArmedRef = useRef(false);
  const updateAbortRef = useRef<AbortController | null>(null);

  const pairingPanel: PairingMethod =
    flow.phase === "pairing" || flow.phase === "verification"
      ? (flow.method ?? (runnerCodeEnabled ? "runnercode" : "passkey"))
      : "passkey";
  const activeRunner = runners.find((item) => item.runnerId === runnerId);
  const activeRunnerOffline = runners.length > 0 && (!activeRunner || !activeRunner.online);
  const workspaceOptions = activeRunner?.workspaces ?? [];
  const modelOptions = activeRunner?.models ?? [];
  const activeConversation = conversations.find((item) => item.id === activeConversationId);
  const activeConversationTitle = activeConversationId
    ? (titles[activeConversationId] ?? "未命名对话")
    : "新加密会话";

  const api = useMemo(() => {
    try {
      return new GatewayApi(normalizeGatewayOrigin(gatewayInput));
    } catch {
      return null;
    }
  }, [gatewayInput]);

  function selectPairingMethod(method: PairingMethod) {
    dispatchFlow({ type: "SELECT_METHOD", method });
  }

  function showFailure(error: unknown, context: FailureContext) {
    const diagnostic = normalizeFailure(error, context);
    persistDiagnostic(diagnostic);
    setStatus({ tone: "error", text: diagnostic.title, diagnostic });
    if (diagnostic.code === "cloudflare_login_required") {
      setAccessReady(false);
      dispatchFlow({ type: "ACCESS_EXPIRED" });
    }
    return diagnostic;
  }

  useEffect(
    () => () => {
      accessLoginAbortRef.current?.abort();
      verificationAbortRef.current?.abort();
      updateAbortRef.current?.abort();
    },
    []
  );

  useEffect(() => {
    const target =
      flow.phase === "access"
        ? accessStepRef.current
        : flow.phase === "pairing"
          ? pairingStepRef.current
          : flow.phase === "verification"
            ? verificationStepRef.current
            : flow.phase === "complete"
              ? completeStepRef.current
              : chatStepRef.current;
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    const focusable = target.querySelector<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex='-1']"
    );
    window.setTimeout(() => focusable?.focus({ preventScroll: true }), 100);
  }, [flow.phase]);

  useEffect(() => {
    if (flow.phase !== "chat") return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [flow.phase, runs]);

  useEffect(() => {
    if (flow.phase !== "chat" || status?.tone !== "ok") return;
    const timer = window.setTimeout(() => setStatus(null), 3500);
    return () => window.clearTimeout(timer);
  }, [flow.phase, status]);

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
          text: "请先完成设备验证，随后会自动返回。"
        });
      }
      const keys = await SecureWebKeyStore.open();
      const device = await keys.device();
      if (cancelled) return;
      setBoot({ kind: "ready", keys, device });
      if (isDesktopShell()) {
        try {
          const ver = await desktopAppVersion();
          if (!cancelled) setLocalDesktopVersion(ver);
        } catch (error) {
          if (!cancelled) {
            const diagnostic = normalizeFailure(error, {
              stage: "update-check",
              operation: "读取当前客户端版本"
            });
            persistDiagnostic(diagnostic);
            setUpdateDiagnostic({ tone: "error", text: diagnostic.title, diagnostic });
          }
        }
      }
      const saved =
        savedGatewayOrigin() ||
        (isDesktopShell() ? saveGatewayOrigin("https://cs.joelzt.org") : "");
      if (saved) {
        try {
          const clientApi = new GatewayApi(saved);
          const policy = await clientApi.get<DesktopAccessPolicy>("/api/e2ee-policy");
          if (!cancelled) setAccessReady(true);
          if (!cancelled && policy.secureClientOrigin) {
            setPasskeyOrigin(policy.secureClientOrigin);
          }
          if (!cancelled && policy.cfAccessLogoutUrl) {
            setCfAccessLogoutUrl(policy.cfAccessLogoutUrl);
          }
          if (!cancelled && policy.runnerCodePairingEnabled) {
            setRunnerCodeEnabled(true);
          }
          if (!cancelled) {
            dispatchFlow({
              type: "BOOT",
              accessReady: true,
              runnerId: device.pairedRunnerId
            });
            if (policy.runnerCodePairingEnabled && !device.pairedRunnerId) {
              dispatchFlow({ type: "SELECT_METHOD", method: "runnercode" });
            }
            if (device.pairedRunnerId) {
              await refreshDirectory(clientApi, keys);
            }
          }
        } catch (error) {
          if (!cancelled) {
            setAccessReady(false);
            dispatchFlow({
              type: "BOOT",
              accessReady: false,
              runnerId: device.pairedRunnerId
            });
            if (
              !(error instanceof GatewayApiError) ||
              error.code !== "cloudflare_login_required"
            ) {
              showFailure(error, {
                stage: "access",
                operation: "检查登录状态",
                endpoint: "/api/e2ee-policy"
              });
            }
          }
        }
      } else if (!cancelled) {
        setAccessReady(false);
        dispatchFlow({
          type: "BOOT",
          accessReady: false,
          runnerId: device.pairedRunnerId
        });
      }
    })().catch((error) => {
      if (!cancelled) {
        const diagnostic = normalizeFailure(error, {
          stage: "startup",
          operation: "初始化本地安全存储"
        });
        setBoot({ kind: "blocked", reason: diagnostic.message });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!desktopShell) return;
    let cancelled = false;
    const controller = new AbortController();
    updateAbortRef.current?.abort();
    updateAbortRef.current = controller;
    (async () => {
      const local = localDesktopVersion ?? (await desktopAppVersion());
      if (cancelled) return;
      setLocalDesktopVersion(local);
      const decision = await checkDesktopUpdate({
        localVersion: local,
        signal: controller.signal,
        onAttempt: ({ attempt, code }) => {
          persistOperationalDiagnostic({
            stage: "update-check",
            operation: "检查更新清单",
            endpoint: DESKTOP_UPDATE_METADATA_URL,
            errorCode: code ?? "request_ok",
            retryAttempt: attempt
          });
        },
        ...(accessReady && api
          ? {
              authenticatedLoader: () =>
                api.get<DesktopUpdateMetadata>("/api/desktop/version")
            }
          : {})
      });
      if (cancelled) return;
      if (decision.kind === "available") {
        setUpdateAvailable(decision.metadata);
        setUpdateDiagnostic(null);
      } else if (decision.kind === "hidden") {
        setUpdateAvailable(null);
        if (decision.reason === "installer_unavailable") {
          const diagnostic = normalizeFailure(
            new Error("desktop_installer_unavailable"),
            {
              stage: "update-check",
              operation: "检查安装包",
              endpoint: "/api/desktop/version"
            }
          );
          persistDiagnostic(diagnostic);
          setUpdateDiagnostic({ tone: "warn", text: diagnostic.title, diagnostic });
        } else {
          setUpdateDiagnostic(null);
        }
      } else {
        setUpdateAvailable(null);
        const diagnostic = normalizeFailure(new Error(decision.code), {
          stage: "update-check",
          operation: "检查新版本",
          endpoint: DESKTOP_UPDATE_METADATA_URL
        });
        persistDiagnostic(diagnostic, decision.attempts);
        setUpdateDiagnostic({ tone: "warn", text: diagnostic.title, diagnostic });
      }
    })().catch((error) => {
      if (!cancelled) {
        const diagnostic = normalizeFailure(error, {
          stage: "update-check",
          operation: "检查新版本",
          endpoint: DESKTOP_UPDATE_METADATA_URL
        });
        persistDiagnostic(diagnostic);
        setUpdateDiagnostic({ tone: "warn", text: diagnostic.title, diagnostic });
      }
    });
    return () => {
      cancelled = true;
      controller.abort();
      if (updateAbortRef.current === controller) updateAbortRef.current = null;
    };
  }, [
    desktopShell,
    api,
    accessReady,
    localDesktopVersion,
    updateCheckGeneration
  ]);

  useEffect(() => {
    if (!desktopShell) return;
    const refresh = () => setUpdateCheckGeneration((value) => value + 1);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    const timer = window.setInterval(refresh, 15 * 60_000);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      window.clearInterval(timer);
    };
  }, [desktopShell]);

  useEffect(() => {
    if (!desktopShell) return;
    const resumeAccess = () => {
      if (
        accessAutoRetryArmedRef.current &&
        flow.phase === "access" &&
        !accessReady &&
        !busy &&
        !accessLoginAbortRef.current
      ) {
        void onDesktopAccessLogin();
      }
    };
    window.addEventListener("online", resumeAccess);
    window.addEventListener("focus", resumeAccess);
    return () => {
      window.removeEventListener("online", resumeAccess);
      window.removeEventListener("focus", resumeAccess);
    };
  }, [desktopShell, flow.phase, accessReady, busy]);

  useEffect(() => {
    if (!desktopShell) return;
    Promise.all([desktopReadDiagnostics(100), desktopDiagnosticsPath()])
      .then(([records, path]) => {
        setDiagnosticHistory({ count: records.length, path });
      })
      .catch(() => {
        // Logging is diagnostic-only and must never block startup.
      });
  }, [desktopShell, status?.diagnostic?.diagnosticId]);

  async function tryFinishCsAuth(
    clientApi: GatewayApi,
    keys: SecureWebKeyStore,
    params: CsAuthRedirectParams
  ): Promise<boolean> {
    setBusy(true);
    setStatus({ tone: "info", text: "正在完成设备授权…" });
    try {
      const { returnUrl } = await completeCsAuthReturn({
        api: clientApi,
        keys,
        params
      });
      setCsAuthPending(null);
      // Flush so the notice paints before navigation (avoid blank instant jump).
      flushSync(() => {
        setStatus({ tone: "ok", text: CS_AUTH_RETURNING_NOTICE });
      });
      await delayBeforeCsRedirect();
      // replace：避免用户再按返回键停在 Secure 聊天页。
      window.location.replace(returnUrl);
      return true;
    } catch (error) {
      const diagnostic = showFailure(error, {
        stage: "runner-confirmation",
        operation: "完成设备授权",
        endpoint: "/api/e2ee/v1/cs-auth"
      });
      if (diagnostic.code === "internal_client_error") {
        setStatus({ tone: "error", text: formatCsAuthReturnError(error), diagnostic });
      }
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
    const device = await keys.device();
    setBoot({ kind: "ready", keys, device });
    setRunnerId(runnerIdValue);
    await refreshDirectory(clientApi, keys);
    dispatchFlow({ type: "PAIRED", runnerId: runnerIdValue });
    const pending = csAuthPending ?? loadPendingCsAuthRedirect();
    if (!pending) {
      setStatus({ tone: "ok", text: "设备已通过验证。" });
      return;
    }
    setStatus({ tone: "ok", text: "设备已通过验证，正在返回…" });
    setCsAuthPending(pending);
    await tryFinishCsAuth(clientApi, keys, pending);
  }

  useEffect(() => {
    if (boot.kind !== "ready" || !api || !accessReady) return;
    const recovery = parseRecoveryFragment(window.location.hash);
    if (recovery) {
      let cancelled = false;
      setBusy(true);
      dispatchFlow({ type: "SELECT_METHOD", method: "recovery" });
      dispatchFlow({ type: "START_VERIFICATION" });
      setStatus({ tone: "info", text: "正在验证恢复码…" });
      pairWithRecovery({
        api,
        keys: boot.keys,
        recoveryId: recovery.recoveryId,
        secret: recovery.secret,
        onStatus: (text) => {
          if (!cancelled) setStatus({ tone: "info", text });
        }
      })
        .then(async (result) => {
          if (cancelled) return;
          await finishPairingThenMaybeReturnToCs(api, boot.keys, result.runnerId);
        })
        .catch((error) => {
          if (!cancelled) {
            showFailure(error, {
              stage: "pairing-submit",
              operation: "验证恢复码",
              endpoint: "/api/e2ee/v1/recovery"
            });
            dispatchFlow({ type: "VERIFICATION_FAILED" });
            clearRecoveryFragment();
          }
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
      return () => {
        cancelled = true;
      };
    }
    if (!parseMagicLinkFragment(window.location.hash)) return;
    let cancelled = false;
    setBusy(true);
    dispatchFlow({ type: "SELECT_METHOD", method: "mail" });
    dispatchFlow({ type: "START_VERIFICATION" });
    setStatus({ tone: "info", text: "正在验证链接…" });
    tryConsumeMagicLink({ api, keys: boot.keys })
      .then(async (result) => {
        if (cancelled || !result) return;
        await finishPairingThenMaybeReturnToCs(api, boot.keys, result.runnerId);
      })
      .catch((error) => {
        if (!cancelled) {
          showFailure(error, {
            stage: "pairing-submit",
            operation: "验证授权链接",
            endpoint: "/api/e2ee/v1/pairings"
          });
          dispatchFlow({ type: "VERIFICATION_FAILED" });
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [boot, api, accessReady]);

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
      const preferred = directory.find((runner) => runner.runnerId === preferredRunnerId);
      const firstWorkspace = preferred?.workspaces[0]?.id;
      if (firstWorkspace && preferred) {
        setWorkspaceId((current) =>
          preferred.workspaces.some((item) => item.id === current) ? current : firstWorkspace
        );
      }
      const firstModel =
        preferred?.models.find((item) => item.id === "auto")?.id ?? preferred?.models[0]?.id;
      if (firstModel && preferred) {
        setModel((current) =>
          preferred.models.some((item) => item.id === current) ? current : firstModel
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
        text: "服务地址已保存。"
      });
      try {
        const clientApi = new GatewayApi(origin);
        const policy = await clientApi.get<DesktopAccessPolicy>("/api/e2ee-policy");
        setAccessReady(true);
        if (policy.secureClientOrigin) setPasskeyOrigin(policy.secureClientOrigin);
        if (policy.cfAccessLogoutUrl) setCfAccessLogoutUrl(policy.cfAccessLogoutUrl);
        if (policy.runnerCodePairingEnabled) {
          setRunnerCodeEnabled(true);
        }
        dispatchFlow({
          type: "ACCESS_READY",
          runnerId: boot.kind === "ready" ? boot.device.pairedRunnerId : null
        });
        if (
          policy.runnerCodePairingEnabled &&
          boot.kind === "ready" &&
          !boot.device.pairedRunnerId
        ) {
          dispatchFlow({ type: "SELECT_METHOD", method: "runnercode" });
        }
      } catch (error) {
        if (
          desktopShell &&
          error instanceof GatewayApiError &&
          error.code === "cloudflare_login_required"
        ) {
          setAccessReady(false);
          setStatus({
            tone: "warn",
            text: "请登录以继续。"
          });
        } else {
          showFailure(error, {
            stage: "access",
            operation: "检查服务地址",
            endpoint: "/api/e2ee-policy"
          });
        }
      }
    } catch (error) {
      showFailure(error, {
        stage: "access",
        operation: "保存服务地址"
      });
    }
  }

  async function onDesktopAccessLogin(): Promise<boolean> {
    if (!desktopShell) return false;
    if (accessLoginAbortRef.current) return false;
    let origin: string;
    try {
      origin = normalizeGatewayOrigin(gatewayInput);
    } catch (error) {
      showFailure(error, {
        stage: "access",
        operation: "检查服务地址"
      });
      return false;
    }
    const controller = new AbortController();
    accessLoginAbortRef.current = controller;
    accessAutoRetryArmedRef.current = true;
    setBusy(true);
    try {
      saveGatewayOrigin(origin);
      setGatewayInput(origin);
      setStatus({
        tone: "info",
        text: "请在弹出的窗口中完成登录。"
      });
      // Pops the bridge window immediately (does not block on login).
      await desktopAccessShow(origin);
      const clientApi = new GatewayApi(origin);
      // Poll the Gateway until Access login completes (bridge becomes ready).
      const policy = await waitForDesktopAccessLogin(clientApi, {
        signal: controller.signal,
        onAttempt: (event) => {
          persistOperationalDiagnostic({
            stage: "access",
            operation: "检查登录状态",
            endpoint: `${clientApi.origin}/api/e2ee-policy`,
            errorCode: event.code ?? "request_ok",
            retryAttempt: event.attempt
          });
        }
      });
      setAccessReady(true);
      if (policy.secureClientOrigin) setPasskeyOrigin(policy.secureClientOrigin);
      if (policy.cfAccessLogoutUrl) setCfAccessLogoutUrl(policy.cfAccessLogoutUrl);
      if (policy.runnerCodePairingEnabled) {
        setRunnerCodeEnabled(true);
      }
      dispatchFlow({
        type: "ACCESS_READY",
        runnerId: boot.kind === "ready" ? boot.device.pairedRunnerId : null
      });
      if (
        policy.runnerCodePairingEnabled &&
        boot.kind === "ready" &&
        !boot.device.pairedRunnerId
      ) {
        dispatchFlow({ type: "SELECT_METHOD", method: "runnercode" });
      }
      if (boot.kind === "ready" && boot.device.pairedRunnerId) {
        await refreshDirectory(clientApi, boot.keys);
      }
      setUpdateCheckGeneration((value) => value + 1);
      setStatus({
        tone: "ok",
        text: "登录成功。"
      });
      accessAutoRetryArmedRef.current = false;
      return true;
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof Error && error.message === "access_login_cancelled")
      ) {
        accessAutoRetryArmedRef.current = false;
        setStatus({ tone: "info", text: "已取消登录。" });
        return false;
      }
      const code = errorText(error);
      if (
        code !== "access_network_retry_exhausted" &&
        code !== "access_bridge_login_timeout"
      ) {
        accessAutoRetryArmedRef.current = false;
      }
      setAccessReady(false);
      showFailure(error, {
        stage: "access",
        operation: "完成登录",
        endpoint: "/api/e2ee-policy"
      });
      return false;
    } finally {
      if (accessLoginAbortRef.current === controller) {
        accessLoginAbortRef.current = null;
      }
      setBusy(false);
    }
  }

  function onCancelAccessLogin() {
    accessAutoRetryArmedRef.current = false;
    accessLoginAbortRef.current?.abort();
  }

  async function onDesktopUpgrade() {
    if (!desktopShell || !updateAvailable) return;
    let origin: string;
    try {
      origin = normalizeGatewayOrigin(new URL(updateAvailable.installerUrl).origin);
    } catch (error) {
      showFailure(error, {
        stage: "update-download",
        operation: "检查下载地址"
      });
      return;
    }
    if (!accessReady && !(await onDesktopAccessLogin())) return;
    setBusy(true);
    try {
      setStatus({
        tone: "info",
        text: `正在安装 ${updateAvailable.version}…`
      });
      await desktopInstallUpdate({
        gatewayOrigin: origin,
        expectedVersion: updateAvailable.version,
        expectedSha256: updateAvailable.sha256
      });
      setStatus({
        tone: "ok",
        text: "已启动安装程序。完成后请重新打开客户端。"
      });
    } catch (error) {
      showFailure(error, {
        stage: "update-download",
        operation: "下载并校验安装包",
        endpoint: "/api/desktop/download"
      });
    } finally {
      setBusy(false);
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
      dispatchFlow(
        accessReady
          ? { type: "BOOT", accessReady: true, runnerId: null }
          : { type: "LOGGED_OUT" }
      );
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
      showFailure(error, {
        stage: "pairing-submit",
        operation: "清除本机授权",
        endpoint: "/api/e2ee/v1/devices"
      });
    } finally {
      setBusy(false);
    }
  }

  async function onPasskeyPair() {
    if (boot.kind !== "ready" || !api) return;
    dispatchFlow({ type: "START_VERIFICATION" });
    setBusy(true);
    try {
      saveGatewayOrigin(gatewayInput);
      const result = await pairWithPasskey({
        api,
        keys: boot.keys,
        ceremonyOrigin: passkeyOrigin,
        onStatus: (text) => setStatus({ tone: "info", text })
      });
      await finishPairingThenMaybeReturnToCs(api, boot.keys, result.runnerId);
    } catch (error) {
      showFailure(error, {
        stage: "passkey",
        operation: "完成 Passkey 验证",
        endpoint:
          error instanceof GatewayApiError
            ? (error.endpoint ?? "/api/e2ee/v1/passkey")
            : passkeyOrigin
      });
      dispatchFlow({ type: "VERIFICATION_FAILED" });
    } finally {
      setBusy(false);
    }
  }

  async function onRequestApproval() {
    if (boot.kind !== "ready" || !api) return;
    dispatchFlow({ type: "START_VERIFICATION" });
    const controller = new AbortController();
    verificationAbortRef.current = controller;
    setBusy(true);
    try {
      saveGatewayOrigin(gatewayInput);
      const started = await requestDeviceApproval({ api, keys: boot.keys });
      setApprovalId(started.approvalId);
      setStatus({
        tone: "warn",
        text: "请在已授权设备上批准此设备。"
      });
      const result = await waitForDeviceApprovalResult({
        api,
        keys: boot.keys,
        approvalId: started.approvalId,
        signal: controller.signal,
        onStatus: (text) => setStatus({ tone: "info", text })
      });
      await finishPairingThenMaybeReturnToCs(api, boot.keys, result.runnerId);
    } catch (error) {
      if (controller.signal.aborted) return;
      showFailure(error, {
        stage: "runner-confirmation",
        operation: "等待已授权设备批准",
        endpoint: "/api/e2ee/v1/approvals"
      });
      dispatchFlow({ type: "VERIFICATION_FAILED" });
    } finally {
      if (verificationAbortRef.current === controller) {
        verificationAbortRef.current = null;
      }
      setBusy(false);
    }
  }

  function onCancelVerification() {
    verificationAbortRef.current?.abort();
    verificationAbortRef.current = null;
    setRunnerCodeOffer(null);
    setRunnerCodeEnrollId(null);
    setRunnerCodeInput("");
    setRunnerCodeSasWords(null);
    setBusy(false);
    dispatchFlow({ type: "CANCEL_VERIFICATION" });
    setStatus({ tone: "info", text: "已取消，可以选择其他方式。" });
  }

  async function onRefreshApprovals() {
    if (!api) return;
    setBusy(true);
    try {
      const list = await listPendingApprovals(api);
      setPendingApprovals(list);
      setStatus({
        tone: "ok",
        text: list.length === 0 ? "当前没有待批准的新设备。" : `待批准：${list.length} 台设备`
      });
    } catch (error) {
      showFailure(error, {
        stage: "directory",
        operation: "读取待批准设备",
        endpoint: "/api/e2ee/v1/approvals"
      });
    } finally {
      setBusy(false);
    }
  }

  /** Paired Secure browser: auto-load pending approvals while the panel is open. */
  useEffect(() => {
    if (boot.kind !== "ready" || !api) return;
    if (pairingPanel !== "approval") return;
    if (!boot.device.pairedRunnerId) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const list = await listPendingApprovals(api);
        if (!cancelled) setPendingApprovals(list);
      } catch {
        // Keep last list; manual refresh still surfaces errors.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [boot, api, pairingPanel]);

  // RAMC: recompute the browser-side 6-word SAS as the operator types the code,
  // so they can compare it against the SAS shown on the Runner terminal before
  // submitting (P2 mode-B human channel).
  useEffect(() => {
    if (!runnerCodeOffer || !runnerCodeInput.trim()) {
      setRunnerCodeSasWords(null);
      return;
    }
    let cancelled = false;
    deriveRunnerCodeSas(runnerCodeOffer, runnerCodeInput)
      .then((words) => {
        if (!cancelled) setRunnerCodeSasWords(words);
      })
      .catch(() => {
        if (!cancelled) setRunnerCodeSasWords(null);
      });
    return () => {
      cancelled = true;
    };
  }, [runnerCodeOffer, runnerCodeInput]);

  // RAMC P4: compute the pinned trust-root SAS for first-install verification.
  useEffect(() => {
    if (boot.kind !== "ready" || !api) return;
    let cancelled = false;
    computeRootSas(api)
      .then((entries) => {
        if (cancelled) return;
        setRootSasEntries(entries);
        if (entries.some((e) => isRootSasAcked(e.fingerprint))) setRootSasState("verified");
      })
      .catch(() => {
        // Trust roots may be unavailable before Access login; panel stays hidden.
      });
    return () => {
      cancelled = true;
    };
  }, [boot, api]);

  function onVerifyRootSas() {
    const typed = normalizeSasInput(rootSasInput);
    const matched = matchRootSas(rootSasEntries, typed);
    if (matched) {
      ackRootSas(matched.fingerprint);
      setRootSasState("verified");
      setStatus({ tone: "ok", text: "信任根 SAS 校验通过：本页锚定的离线根与 Runner 一致。" });
    } else {
      setRootSasState("failed");
      setStatus({
        tone: "error",
        text: "信任根 SAS 不匹配！请勿在本页配对——可能是被替换的页面/根。请改用可信 PWA 或桌面 localhost verifier。"
      });
    }
  }

  async function onDecideApproval(
    request: E2eeDeviceApprovalRequest,
    decision: "approved" | "rejected"
  ) {
    if (boot.kind !== "ready" || !api) return;
    setBusy(true);
    try {
      await decideDeviceApproval({ api, keys: boot.keys, request, decision });
      setPendingApprovals((current) =>
        current.filter((item) => item.approvalId !== request.approvalId)
      );
      setStatus({
        tone: "ok",
        text: decision === "approved" ? "已批准新设备。" : "已拒绝新设备。"
      });
    } catch (error) {
      showFailure(error, {
        stage: "pairing-submit",
        operation: decision === "approved" ? "批准新设备" : "拒绝新设备",
        endpoint: "/api/e2ee/v1/approvals"
      });
    } finally {
      setBusy(false);
    }
  }

  async function onRecoveryPair() {
    if (boot.kind !== "ready" || !api) return;
    dispatchFlow({ type: "START_VERIFICATION" });
    setBusy(true);
    try {
      saveGatewayOrigin(gatewayInput);
      const fromFragment = parseRecoveryFragment();
      const recoveryId = (fromFragment?.recoveryId || recoveryIdInput).trim();
      const secret = fromFragment?.secret || recoverySecretInput;
      if (!recoveryId || !secret) {
        throw new Error("recovery_code_missing");
      }
      const result = await pairWithRecovery({
        api,
        keys: boot.keys,
        recoveryId,
        secret,
        onStatus: (text) => setStatus({ tone: "info", text })
      });
      await finishPairingThenMaybeReturnToCs(api, boot.keys, result.runnerId);
    } catch (error) {
      showFailure(error, {
        stage: "pairing-submit",
        operation: "验证恢复码",
        endpoint: "/api/e2ee/v1/recovery"
      });
      dispatchFlow({ type: "VERIFICATION_FAILED" });
    } finally {
      setBusy(false);
    }
  }

  async function onStartRunnerCode() {
    if (boot.kind !== "ready" || !api) return;
    dispatchFlow({ type: "START_VERIFICATION" });
    setBusy(true);
    setRunnerCodeOffer(null);
    setRunnerCodeInput("");
    setRunnerCodeSasWords(null);
    try {
      saveGatewayOrigin(gatewayInput);
      setStatus({ tone: "info", text: "正在联系授权设备…" });
      const { enrollId, offer } = await startRunnerCodeEnrollment({
        api,
        keys: boot.keys,
        label: boot.device.clientId.slice(0, 16),
        onStatus: (text) => setStatus({ tone: "info", text })
      });
      setRunnerCodeEnrollId(enrollId);
      setRunnerCodeOffer(offer);
      setStatus({
        tone: "warn",
        text: "请输入授权设备上显示的代码，并确认两边的 6 个词一致。"
      });
    } catch (error) {
      showFailure(error, {
        stage: "pairing-start",
        operation: "请求设备代码",
        endpoint: "/api/e2ee/v1/runner-code/start"
      });
      dispatchFlow({ type: "VERIFICATION_FAILED" });
    } finally {
      setBusy(false);
    }
  }

  async function onConfirmRunnerCode() {
    if (boot.kind !== "ready" || !api || !runnerCodeEnrollId || !runnerCodeOffer) return;
    if (!runnerCodeInput.trim()) {
      showFailure(new Error("runner_code_missing"), {
        stage: "pairing-submit",
        operation: "确认设备代码",
        endpoint: "/api/e2ee/v1/runner-code/confirm"
      });
      return;
    }
    setBusy(true);
    try {
      const result = await confirmRunnerCode({
        api,
        keys: boot.keys,
        enrollId: runnerCodeEnrollId,
        offer: runnerCodeOffer,
        code: runnerCodeInput,
        onStatus: (text) => setStatus({ tone: "info", text })
      });
      setRunnerCodeOffer(null);
      setRunnerCodeEnrollId(null);
      setRunnerCodeInput("");
      setRunnerCodeSasWords(null);
      await finishPairingThenMaybeReturnToCs(api, boot.keys, result.runnerId);
    } catch (error) {
      const raw = errorText(error);
      const mismatch = raw.match(/^runner_code_code_mismatch_(\d+)$/);
      if (mismatch) {
        showFailure(error, {
          stage: "pairing-submit",
          operation: "确认设备代码",
          endpoint: "/api/e2ee/v1/runner-code/confirm"
        });
        setRunnerCodeInput("");
      } else if (raw === "runner_code_locked") {
        showFailure(error, {
          stage: "pairing-submit",
          operation: "确认设备代码",
          endpoint: "/api/e2ee/v1/runner-code/confirm"
        });
        setRunnerCodeOffer(null);
        setRunnerCodeEnrollId(null);
        dispatchFlow({ type: "VERIFICATION_FAILED" });
      } else {
        showFailure(error, {
          stage: "pairing-submit",
          operation: "确认设备代码",
          endpoint: "/api/e2ee/v1/runner-code/confirm"
        });
      }
    } finally {
      setBusy(false);
    }
  }

  async function onStartPairing() {
    if (boot.kind !== "ready" || !api) return;
    dispatchFlow({ type: "START_VERIFICATION" });
    setBusy(true);
    try {
      saveGatewayOrigin(gatewayInput);
      const started = await startPairing({ api, keys: boot.keys });
      setPairId(started.pairId);
      setStatus({
        tone: "warn",
        text: "请打开邮件中的授权链接。"
      });
    } catch (error) {
      showFailure(error, {
        stage: "pairing-start",
        operation: "发送授权邮件",
        endpoint: "/api/e2ee/v1/pairings/start"
      });
      dispatchFlow({ type: "VERIFICATION_FAILED" });
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
      showFailure(error, {
        stage: "pairing-submit",
        operation: "验证授权链接",
        endpoint: "/api/e2ee/v1/pairings"
      });
      dispatchFlow({ type: "VERIFICATION_FAILED" });
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
      showFailure(error, {
        stage: "directory",
        operation: "刷新设备列表",
        endpoint: "/api/e2ee/v1/runners"
      });
    } finally {
      setBusy(false);
    }
  }

  async function openConversation(id: string) {
    if (boot.kind !== "ready" || !api) return;
    setBusy(true);
    try {
      const client = new SecureGatewayClient(api, boot.keys);
      const [decrypted, secret] = await Promise.all([
        client.runs(id),
        boot.keys.conversation(id)
      ]);
      if (secret) {
        setRunnerId(secret.runnerId);
        setWorkspaceId(secret.workspaceId);
        setModel(secret.model);
      }
      setActiveConversationId(id);
      setRuns(decrypted);
    } catch (error) {
      showFailure(error, {
        stage: "chat",
        operation: "打开对话",
        endpoint: `/api/e2ee/v1/conversations/${encodeURIComponent(id)}/runs`
      });
    } finally {
      setBusy(false);
    }
  }

  function startNewConversation() {
    setActiveConversationId(null);
    setRuns([]);
    setStatus(null);
    window.setTimeout(() => promptRef.current?.focus(), 0);
  }

  function selectRunner(nextRunnerId: string) {
    const nextRunner = runners.find((item) => item.runnerId === nextRunnerId);
    setRunnerId(nextRunnerId);
    setActiveConversationId(null);
    setRuns([]);
    if (nextRunner?.workspaces[0]) setWorkspaceId(nextRunner.workspaces[0].id);
    const nextModel =
      nextRunner?.models.find((item) => item.id === "auto") ?? nextRunner?.models[0];
    if (nextModel) setModel(nextModel.id);
  }

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      busy
    ) {
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
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
      setStatus({ tone: "ok", text: "消息已发送。" });
    } catch (error) {
      showFailure(error, {
        stage: "chat",
        operation: "发送消息",
        endpoint: "/api/e2ee/v1/runs"
      });
    } finally {
      setBusy(false);
    }
  }

  if (boot.kind === "loading") {
    return (
      <div className="app">
        <h1 className="brand">安全对话</h1>
        <p className="lede">正在准备客户端…</p>
      </div>
    );
  }

  if (boot.kind === "blocked") {
    return (
      <div className="app">
        <h1 className="brand">安全对话</h1>
        <div className="panel blocker" role="alert">
          <h2>无法使用本机存储</h2>
          <p>请关闭隐私模式，允许此应用保存数据，然后重新打开。</p>
          <p className="meta">{boot.reason}</p>
        </div>
      </div>
    );
  }

  const activeGuideStep =
    flow.phase === "access"
      ? 1
      : flow.phase === "pairing" || flow.phase === "verification"
        ? 2
        : flow.phase === "complete"
          ? 3
          : 4;
  const guideLabels = ["登录", "验证设备", "完成", "加密聊天"];

  return (
    <div className={flow.phase === "chat" ? "app chat-app" : "app"}>
      <header className="app-top">
        <div className="app-top-row">
          <div>
            <h1 className="brand">安全对话</h1>
            <p className="lede">按顺序完成当前步骤即可继续。</p>
          </div>
          {desktopShell && updateAvailable ? (
            <div className="app-top-actions">
              <button
                type="button"
                className="icon-action icon-action-attention"
                disabled={busy}
                onClick={onDesktopUpgrade}
                title={`升级到 ${updateAvailable.version}`}
                aria-label={`升级到 ${updateAvailable.version}`}
                data-testid="desktop-upgrade"
              >
                <ArrowUpCircle aria-hidden="true" size={20} strokeWidth={1.75} />
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <ol className="steps" aria-label="设置进度">
        {guideLabels.map((label, index) => {
          const number = index + 1;
          return (
            <li
              key={label}
              className={
                number < activeGuideStep
                  ? "done"
                  : number === activeGuideStep
                    ? "active"
                    : "locked"
              }
              aria-current={number === activeGuideStep ? "step" : undefined}
            >
              <span className="n">{number}</span>
              <span>{label}</span>
            </li>
          );
        })}
      </ol>

      {status ? (
        <div className={flow.phase === "chat" ? "chat-status-overlay" : undefined}>
          <StatusNotice status={status} />
        </div>
      ) : null}

      {flow.phase === "access" ? (
        <section className="panel flow-panel" data-flow-step="access" ref={accessStepRef}>
          <h2 tabIndex={-1}>登录以继续</h2>
          <p>完成登录后，客户端会自动进入下一步。</p>
          {desktopShell ? (
            <div className="row">
              <button type="button" disabled={busy} onClick={onDesktopAccessLogin}>
                {busy ? "等待登录…" : "登录以继续"}
              </button>
              {accessLoginAbortRef.current ? (
                <button type="button" className="secondary" onClick={onCancelAccessLogin}>
                  取消
                </button>
              ) : null}
            </div>
          ) : (
            <form onSubmit={onSaveGateway}>
              <label htmlFor="gateway">服务地址</label>
              <input
                id="gateway"
                value={gatewayInput}
                onChange={(event) => setGatewayInput(event.target.value)}
                placeholder="https://cs.example.com"
                autoComplete="url"
              />
              <div className="row">
                <button type="submit" disabled={busy}>
                  继续
                </button>
              </div>
            </form>
          )}
        </section>
      ) : null}

      {flow.phase === "pairing" ? (
        <section className="panel flow-panel" data-flow-step="pairing" ref={pairingStepRef}>
          <h2 tabIndex={-1}>验证此设备</h2>
          <p>选择一种方式。</p>
          <div className="method-list" role="group" aria-label="设备验证方式">
            <button
              type="button"
              className={flow.method === "approval" ? "method active" : "method secondary"}
              aria-pressed={flow.method === "approval"}
              onClick={() => selectPairingMethod("approval")}
            >
              在已授权设备上批准
            </button>
            <button
              type="button"
              className={flow.method === "passkey" ? "method active" : "method secondary"}
              aria-pressed={flow.method === "passkey"}
              onClick={() => selectPairingMethod("passkey")}
            >
              使用 Passkey
            </button>
            {runnerCodeEnabled ? (
              <button
                type="button"
                className={flow.method === "runnercode" ? "method active" : "method secondary"}
                aria-pressed={flow.method === "runnercode"}
                onClick={() => selectPairingMethod("runnercode")}
              >
                输入设备代码
              </button>
            ) : null}
            <button
              type="button"
              className={flow.method === "recovery" ? "method active" : "method secondary"}
              aria-pressed={flow.method === "recovery"}
              onClick={() => selectPairingMethod("recovery")}
            >
              使用恢复码
            </button>
            <button
              type="button"
              className={flow.method === "mail" ? "method active" : "method secondary"}
              aria-pressed={flow.method === "mail"}
              onClick={() => selectPairingMethod("mail")}
            >
              使用邮件链接
            </button>
          </div>

          {flow.method === "approval" ? (
            <div className="pairing-action">
              <p>在另一台已授权设备上批准这台设备。</p>
              <button type="button" disabled={busy || !api} onClick={onRequestApproval}>
                发起批准请求
              </button>
            </div>
          ) : null}

          {flow.method === "passkey" ? (
            <div className="pairing-action">
              <p>使用 Windows Hello、指纹或设备 PIN 完成验证。</p>
              <button type="button" disabled={busy || !api} onClick={onPasskeyPair}>
                使用 Passkey 继续
              </button>
            </div>
          ) : null}

          {flow.method === "runnercode" ? (
            <div className="pairing-action">
              <p>从已授权设备读取一次性代码。</p>
              <button type="button" disabled={busy || !api} onClick={onStartRunnerCode}>
                获取设备代码
              </button>
            </div>
          ) : null}

          {flow.method === "recovery" ? (
            <div className="pairing-action">
              <p>输入为此设备生成的一次性恢复信息。</p>
              <label htmlFor="recoveryId">恢复编号</label>
              <input
                id="recoveryId"
                value={recoveryIdInput}
                onChange={(event) => setRecoveryIdInput(event.target.value)}
                autoComplete="off"
              />
              <label htmlFor="recoverySecret">恢复码</label>
              <input
                id="recoverySecret"
                value={recoverySecretInput}
                onChange={(event) => setRecoverySecretInput(event.target.value)}
                autoComplete="off"
              />
              <button type="button" disabled={busy || !api} onClick={onRecoveryPair}>
                验证恢复码
              </button>
            </div>
          ) : null}

          {flow.method === "mail" ? (
            <div className="pairing-action">
              <p>我们会向你的登录邮箱发送一次性链接。</p>
              <button type="button" disabled={busy || !api} onClick={onStartPairing}>
                发送授权邮件
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {flow.phase === "verification" ? (
        <section
          className="panel flow-panel"
          data-flow-step="verification"
          ref={verificationStepRef}
        >
          <h2 tabIndex={-1}>完成验证</h2>

          {flow.method === "approval" ? (
            <>
              <p>请在已授权设备上批准此设备。本页会自动继续。</p>
              <button type="button" className="secondary" onClick={onCancelVerification}>
                取消
              </button>
            </>
          ) : null}

          {flow.method === "passkey" ? (
            <p>请在弹出的安全窗口和系统窗口中完成验证。</p>
          ) : null}

          {flow.method === "runnercode" ? (
            runnerCodeOffer ? (
              <>
                <label htmlFor="runnerCode">设备代码</label>
                <input
                  id="runnerCode"
                  value={runnerCodeInput}
                  onChange={(event) => setRunnerCodeInput(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="characters"
                />
                {runnerCodeSasWords ? (
                  <div className="word-check" role="status">
                    <span>确认两边都显示：</span>
                    <strong>{runnerCodeSasWords.join(" ")}</strong>
                  </div>
                ) : (
                  <p>输入代码后会显示 6 个确认词。</p>
                )}
                <div className="row">
                  <button
                    type="button"
                    disabled={busy || !runnerCodeSasWords}
                    onClick={onConfirmRunnerCode}
                  >
                    两边一致，继续
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={onCancelVerification}
                  >
                    取消
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>正在等待授权设备生成代码…</p>
                <button type="button" className="secondary" onClick={onCancelVerification}>
                  取消
                </button>
              </>
            )
          ) : null}

          {flow.method === "recovery" ? <p>正在验证恢复码…</p> : null}

          {flow.method === "mail" ? (
            <>
              <p>请打开邮件中的授权链接，本页会自动继续。</p>
              {parseMagicLinkFragment(window.location.hash) ? (
                <button type="button" disabled={busy} onClick={onManualComplete}>
                  继续
                </button>
              ) : null}
              <button type="button" className="secondary" onClick={onCancelVerification}>
                取消
              </button>
            </>
          ) : null}
        </section>
      ) : null}

      {flow.phase === "complete" ? (
        <section className="panel flow-panel" data-flow-step="complete" ref={completeStepRef}>
          <h2 tabIndex={-1}>设备已通过验证</h2>
          <p>现在可以开始安全对话。</p>
          <button type="button" onClick={() => dispatchFlow({ type: "CONTINUE_TO_CHAT" })}>
            开始对话
          </button>
        </section>
      ) : null}

      {flow.phase === "chat" ? (
        <section
          className={`secure-chat-layout${sidebarCollapsed ? " sidebar-collapsed" : ""}`}
          data-flow-step="chat"
          ref={chatStepRef}
        >
          <aside className="secure-chat-sidebar" aria-label="对话">
            <div className="sidebar-toolbar">
              <button
                className="new-chat-button"
                type="button"
                onClick={startNewConversation}
                title="新对话"
              >
                <Plus aria-hidden="true" size={17} strokeWidth={2} />
                <span>新对话</span>
              </button>
              <button
                className="sidebar-collapse-toggle"
                type="button"
                onClick={() => setSidebarCollapsed((value) => !value)}
                title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
                aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
              >
                {sidebarCollapsed ? (
                  <PanelLeftOpen aria-hidden="true" size={16} strokeWidth={1.75} />
                ) : (
                  <PanelLeftClose aria-hidden="true" size={16} strokeWidth={1.75} />
                )}
              </button>
            </div>

            <div className="secure-conversation-list">
              {conversations.map((conversation, index) => (
                <button
                  className={conversation.id === activeConversationId ? "active" : ""}
                  key={conversation.id}
                  onClick={() => void openConversation(conversation.id)}
                  style={{ ["--i" as string]: index } as CSSProperties}
                  title={titles[conversation.id] ?? "未命名对话"}
                  type="button"
                >
                  <span className="conversation-glyph">
                    <LockKeyhole aria-hidden="true" size={15} strokeWidth={1.75} />
                  </span>
                  <span>
                    <strong>{titles[conversation.id] ?? "未命名对话"}</strong>
                    <small>加密 · {conversation.workspaceId}</small>
                  </span>
                </button>
              ))}
              {conversations.length === 0 ? (
                <p className="sidebar-empty">新建加密会话后会出现在这里。</p>
              ) : null}
            </div>

            <div className="secure-sidebar-footer" title="消息内容仅在本机和已授权 Runner 解密">
              <LockKeyhole aria-hidden="true" size={15} strokeWidth={1.75} />
              <span>
                <strong>端到端加密</strong>
                <small>{runnerId || "等待 Runner"}</small>
              </span>
            </div>
          </aside>

          <section className="secure-chat-pane">
            <header className="secure-chat-header">
              <div>
                <h1 tabIndex={-1}>{activeConversationTitle}</h1>
                <p>
                  <span className={`runner-dot ${activeRunner?.online ? "online" : ""}`} />
                  {activeRunner?.online ? "Ready" : "Will queue"} · {model}
                </p>
              </div>
              <div className="secure-header-actions">
                <select
                  aria-label="模型"
                  className="model-switcher"
                  value={model}
                  disabled={Boolean(activeConversation)}
                  onChange={(event) => setModel(event.target.value)}
                >
                  {!modelOptions.some((item) => item.id === model) ? (
                    <option value={model}>{model}</option>
                  ) : null}
                  {modelOptions.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.displayName ?? item.id}
                    </option>
                  ))}
                </select>
                <button
                  className={`chat-icon-button${busy ? " busy" : ""}`}
                  type="button"
                  disabled={busy}
                  onClick={onRefresh}
                  title="重新检查"
                  aria-label="重新检查"
                >
                  <RefreshCw aria-hidden="true" size={16} strokeWidth={1.75} />
                </button>
                {desktopShell && updateAvailable ? (
                  <button
                    className="chat-icon-button update-ready"
                    type="button"
                    disabled={busy}
                    onClick={onDesktopUpgrade}
                    title={`升级到 ${updateAvailable.version}`}
                    aria-label={`升级到 ${updateAvailable.version}`}
                  >
                    <ArrowUpCircle aria-hidden="true" size={17} strokeWidth={1.75} />
                  </button>
                ) : null}
                <button
                  className="chat-icon-button logout-button"
                  type="button"
                  disabled={busy}
                  onClick={onLogoutE2ee}
                  title={E2EE_LOGOUT_LABEL}
                  aria-label={E2EE_LOGOUT_LABEL}
                >
                  <LogOut aria-hidden="true" size={16} strokeWidth={1.75} />
                </button>
              </div>
            </header>

            <div className="secure-messages" aria-live="polite">
              {runners.length === 0 || activeRunnerOffline ? (
                <section className="runner-offline-notice" role="status">
                  <RefreshCw aria-hidden="true" size={20} strokeWidth={1.75} />
                  <div>
                    <strong>授权设备离线</strong>
                    <p>启动 Runner 后点击“重新检查”，恢复后即可继续发送加密消息。</p>
                    <button type="button" disabled={busy} onClick={onRefresh}>
                      重新检查
                    </button>
                  </div>
                </section>
              ) : null}

              {runs.length === 0 ? (
                <div className="secure-chat-welcome">
                  <div className="welcome-mark">
                    <MessageSquare aria-hidden="true" size={22} strokeWidth={1.7} />
                  </div>
                  <h2>开始一段安全对话</h2>
                  <p>消息在本机加密，只会在已授权的 Runner 上解密和处理。</p>
                </div>
              ) : null}

              {runs.map((run, index) => (
                <div
                  className="chat-turn"
                  key={run.record.id}
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
                      <E2eeRunProgressPanel run={run} />
                      <MessageMetrics run={run} />
                      <div
                        className="e2ee-run-meta"
                        title={`端到端加密已验证 · ${run.record.id}`}
                      >
                        e2ee-v1 · {run.record.id.slice(0, 8)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            <div className="secure-composer-shell">
              <form className="secure-composer" onSubmit={onSubmitRun}>
                <div className="composer-input">
                  <textarea
                    id="prompt"
                    aria-label="消息"
                    ref={promptRef}
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={submitOnEnter}
                    placeholder={activeRunner?.online ? "加密消息发给已配对 Runner" : "等待 Runner 上线…"}
                    rows={1}
                    required
                    disabled={!activeRunner?.online}
                  />
                  <button
                    type="submit"
                    aria-label="发送消息"
                    disabled={busy || !activeRunner?.online || !prompt.trim()}
                  >
                    {busy ? (
                      <span className="send-loading" aria-hidden="true" />
                    ) : (
                      <ArrowUp aria-hidden="true" size={18} strokeWidth={2} />
                    )}
                  </button>
                </div>
                <div className="composer-options">
                  {runners.length > 1 ? (
                    <label>
                      <span>Runner</span>
                      <select
                        value={runnerId}
                        disabled={Boolean(activeConversation)}
                        onChange={(event) => selectRunner(event.target.value)}
                      >
                        {runners.map((runner) => (
                          <option key={runner.runnerId} value={runner.runnerId}>
                            {runner.runnerId}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <label>
                    <span>Workspace</span>
                    <select
                      value={workspaceId}
                      disabled={Boolean(activeConversation)}
                      onChange={(event) => setWorkspaceId(event.target.value)}
                    >
                      {!workspaceOptions.some((workspace) => workspace.id === workspaceId) ? (
                        <option value={workspaceId}>{workspaceId}</option>
                      ) : null}
                      {workspaceOptions.map((workspace) => (
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
                      disabled={!activeRunner?.online}
                      onChange={(event) => setAllowWrites(event.target.checked)}
                    />
                    允许修改文件
                  </label>
                  <span className="composer-hint">
                    {activeConversation
                      ? "此会话的 Runner、工作区和模型已固定"
                      : "Enter 发送 · Shift+Enter 换行"}
                  </span>
                </div>
              </form>
            </div>
          </section>
        </section>
      ) : null}

      {updateDiagnostic && !updateAvailable ? (
        <details className="update-diagnostic">
          <summary>更新状态</summary>
          <StatusNotice status={updateDiagnostic} />
        </details>
      ) : null}
      {desktopShell && diagnosticHistory.path ? (
        <details className="update-diagnostic">
          <summary>诊断记录</summary>
          <p>
            已保留最近 {diagnosticHistory.count} 条脱敏记录。
            <br />
            <code>{diagnosticHistory.path}</code>
          </p>
        </details>
      ) : null}
    </div>
  );
}
