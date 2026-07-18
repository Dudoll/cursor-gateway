import { FormEvent, useEffect, useMemo, useState } from "react";
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
import { formatPasskeyError } from "./passkeyErrors.js";
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
import { SecureGatewayClient, progressLabel, type DecryptedRun } from "./secureClient.js";
import type {
  E2eeConversationRecord,
  E2eeDeviceApprovalRequest,
  E2eeRunnerDirectoryEntry
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
  desktopInstallUpdate,
  isDesktopShell,
  isNewerDesktopVersion
} from "./desktopShell.js";
import { ArrowUpCircle, KeyRound } from "lucide-react";

type BootState =
  | { kind: "loading" }
  | { kind: "blocked"; reason: string }
  | { kind: "ready"; keys: SecureWebKeyStore; device: DeviceRecord };

type Step = 1 | 2 | 3;
type PairingPanel = "runnercode" | "approval" | "passkey" | "recovery" | "mail";

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
  const [pairingPanel, setPairingPanel] = useState<PairingPanel>("passkey");
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
  const [busy, setBusy] = useState(false);
  const [csAuthPending, setCsAuthPending] = useState<CsAuthRedirectParams | null>(null);
  const [cfAccessLogoutUrl, setCfAccessLogoutUrl] = useState<string | null>(null);
  const [desktopShell] = useState(() => isDesktopShell());
  const [accessReady, setAccessReady] = useState(!isDesktopShell());
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
  const [localDesktopVersion, setLocalDesktopVersion] = useState<string | null>(null);

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
      if (isDesktopShell()) {
        try {
          const ver = await desktopAppVersion();
          if (!cancelled) setLocalDesktopVersion(ver);
        } catch {
          // optional
        }
      }
      const saved = savedGatewayOrigin();
      if (saved) {
        try {
          const clientApi = new GatewayApi(saved);
          const policy = await clientApi.get<{
            cfAccessLogoutUrl?: string | null;
            runnerCodePairingEnabled?: boolean;
          }>("/api/e2ee-policy");
          if (!cancelled) setAccessReady(true);
          if (!cancelled && policy.cfAccessLogoutUrl) {
            setCfAccessLogoutUrl(policy.cfAccessLogoutUrl);
          }
          if (!cancelled && policy.runnerCodePairingEnabled) {
            setRunnerCodeEnabled(true);
            if (!device.pairedRunnerId) setPairingPanel("runnercode");
          }
        } catch (error) {
          if (
            !cancelled &&
            isDesktopShell() &&
            error instanceof GatewayApiError &&
            error.code === "cloudflare_login_required"
          ) {
            setAccessReady(false);
            setStatus({
              tone: "warn",
              text: "桌面端需先完成 Cloudflare Access 登录（本地 UI 与 Gateway 跨站，Access Cookie 不会自动带上）。请点击右上角钥匙图标。"
            });
          }
        }
      } else if (isDesktopShell() && !cancelled) {
        setAccessReady(false);
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

  useEffect(() => {
    if (!desktopShell || !api || !accessReady) return;
    let cancelled = false;
    (async () => {
      try {
        const local = localDesktopVersion ?? (await desktopAppVersion());
        if (cancelled) return;
        setLocalDesktopVersion(local);
        const remote = await api.get<{
          version?: string;
          installerAvailable?: boolean;
        }>("/api/desktop/version");
        if (cancelled) return;
        if (
          remote.installerAvailable &&
          typeof remote.version === "string" &&
          isNewerDesktopVersion(remote.version, local)
        ) {
          setUpdateAvailable(remote.version);
        } else {
          setUpdateAvailable(null);
        }
      } catch {
        if (!cancelled) setUpdateAvailable(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desktopShell, api, accessReady, localDesktopVersion]);

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
      // Flush so the notice paints before navigation (avoid blank instant jump).
      flushSync(() => {
        setStatus({ tone: "ok", text: CS_AUTH_RETURNING_NOTICE });
      });
      await delayBeforeCsRedirect();
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
    const device = await keys.device();
    setBoot({ kind: "ready", keys, device });
    setRunnerId(runnerIdValue);
    setStep(3);
    await refreshDirectory(clientApi, keys);
    const pending = csAuthPending ?? loadPendingCsAuthRedirect();
    if (!pending) {
      // Pure Secure pairing — no CS return context; do not imply redirect.
      setStatus({ tone: "ok", text: `已配对（Runner ${runnerIdValue}）` });
      return;
    }
    setStatus({ tone: "ok", text: `已配对，正在完成 CS 授权…` });
    setCsAuthPending(pending);
    await tryFinishCsAuth(clientApi, keys, pending);
  }

  useEffect(() => {
    if (boot.kind !== "ready" || !api) return;
    const recovery = parseRecoveryFragment(window.location.hash);
    if (recovery) {
      let cancelled = false;
      setBusy(true);
      setPairingPanel("recovery");
      setStatus({ tone: "info", text: "检测到恢复码链接，正在配对…" });
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
            setStatus({ tone: "error", text: `恢复码配对失败：${errorText(error)}` });
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
    setPairingPanel("mail");
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
          runnerCodePairingEnabled?: boolean;
        }>("/api/e2ee-policy");
        setAccessReady(true);
        if (policy.cfAccessLogoutUrl) setCfAccessLogoutUrl(policy.cfAccessLogoutUrl);
        if (policy.runnerCodePairingEnabled) {
          setRunnerCodeEnabled(true);
          if (boot.kind === "ready" && !boot.device.pairedRunnerId) setPairingPanel("runnercode");
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
            text: "Gateway 已保存，但尚未完成 Cloudflare Access 登录。请点击右上角钥匙图标。"
          });
        }
        // Policy is optional for logout link.
      }
    } catch (error) {
      setStatus({ tone: "error", text: errorText(error) });
    }
  }

  async function onDesktopAccessLogin() {
    if (!desktopShell) return;
    let origin: string;
    try {
      origin = normalizeGatewayOrigin(gatewayInput);
    } catch (error) {
      setStatus({ tone: "error", text: errorText(error) });
      return;
    }
    setBusy(true);
    try {
      saveGatewayOrigin(origin);
      setGatewayInput(origin);
      setStatus({ tone: "info", text: "正在打开 Cloudflare Access 登录窗口…" });
      await desktopAccessShow(origin);
      const clientApi = new GatewayApi(origin);
      const policy = await clientApi.get<{
        cfAccessLogoutUrl?: string | null;
        runnerCodePairingEnabled?: boolean;
      }>("/api/e2ee-policy");
      setAccessReady(true);
      if (policy.cfAccessLogoutUrl) setCfAccessLogoutUrl(policy.cfAccessLogoutUrl);
      if (policy.runnerCodePairingEnabled) {
        setRunnerCodeEnabled(true);
        if (boot.kind === "ready" && !boot.device.pairedRunnerId) setPairingPanel("runnercode");
      }
      setStep((current) => (current < 2 ? 2 : current));
      setStatus({
        tone: "ok",
        text: "Cloudflare Access 已就绪（桥接已收纳到系统托盘）。可继续设备配对。"
      });
    } catch (error) {
      setAccessReady(false);
      const code = errorText(error);
      setStatus({
        tone: "error",
        text:
          code === "access_bridge_login_timeout"
            ? "Access 登录超时。请重试并在弹出窗口内完成身份验证。"
            : `Access 登录失败：${code}`
      });
    } finally {
      setBusy(false);
    }
  }

  async function onDesktopUpgrade() {
    if (!desktopShell || !updateAvailable) return;
    let origin: string;
    try {
      origin = normalizeGatewayOrigin(gatewayInput);
    } catch (error) {
      setStatus({ tone: "error", text: errorText(error) });
      return;
    }
    setBusy(true);
    try {
      setStatus({
        tone: "info",
        text: `正在下载并启动安装包（${updateAvailable}）…`
      });
      await desktopInstallUpdate(origin);
      setStatus({
        tone: "ok",
        text: "已启动安装程序。完成后请重新打开客户端。"
      });
    } catch (error) {
      setStatus({ tone: "error", text: `升级失败：${errorText(error)}` });
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

  async function onPasskeyPair() {
    if (boot.kind !== "ready" || !api) return;
    setBusy(true);
    try {
      saveGatewayOrigin(gatewayInput);
      const result = await pairWithPasskey({
        api,
        keys: boot.keys,
        onStatus: (text) => setStatus({ tone: "info", text })
      });
      await finishPairingThenMaybeReturnToCs(api, boot.keys, result.runnerId);
    } catch (error) {
      setStatus({ tone: "error", text: formatPasskeyError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function onRequestApproval() {
    if (boot.kind !== "ready" || !api) return;
    setBusy(true);
    try {
      saveGatewayOrigin(gatewayInput);
      const started = await requestDeviceApproval({ api, keys: boot.keys });
      setApprovalId(started.approvalId);
      setStatus({
        tone: "warn",
        text: `已发起批准请求（${started.approvalId}）。请到已授权的 CS 或已配对 Secure 浏览器批准。过期：${started.expiresAt}`
      });
      const result = await waitForDeviceApprovalResult({
        api,
        keys: boot.keys,
        approvalId: started.approvalId,
        onStatus: (text) => setStatus({ tone: "info", text })
      });
      await finishPairingThenMaybeReturnToCs(api, boot.keys, result.runnerId);
    } catch (error) {
      setStatus({ tone: "error", text: `设备批准失败：${errorText(error)}` });
    } finally {
      setBusy(false);
    }
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
      setStatus({ tone: "error", text: errorText(error) });
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
      setStatus({ tone: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  async function onRecoveryPair() {
    if (boot.kind !== "ready" || !api) return;
    setBusy(true);
    try {
      saveGatewayOrigin(gatewayInput);
      const fromFragment = parseRecoveryFragment();
      const recoveryId = (fromFragment?.recoveryId || recoveryIdInput).trim();
      const secret = fromFragment?.secret || recoverySecretInput;
      if (!recoveryId || !secret) {
        throw new Error("请输入 recoveryId 与恢复码，或扫描 Runner 二维码");
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
      setStatus({ tone: "error", text: `恢复码配对失败：${errorText(error)}` });
    } finally {
      setBusy(false);
    }
  }

  async function onStartRunnerCode() {
    if (boot.kind !== "ready" || !api) return;
    setBusy(true);
    setRunnerCodeOffer(null);
    setRunnerCodeInput("");
    setRunnerCodeSasWords(null);
    try {
      saveGatewayOrigin(gatewayInput);
      setStatus({ tone: "info", text: "正在请求 Runner 设备码…请查看 Runner 终端。" });
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
        text: "Runner 已生成一次性设备码。请在 Runner 终端查看「CODE」并输入到下方，然后核对 6 词 SAS。"
      });
    } catch (error) {
      setStatus({ tone: "error", text: `设备码请求失败：${errorText(error)}` });
    } finally {
      setBusy(false);
    }
  }

  async function onConfirmRunnerCode() {
    if (boot.kind !== "ready" || !api || !runnerCodeEnrollId || !runnerCodeOffer) return;
    if (!runnerCodeInput.trim()) {
      setStatus({ tone: "error", text: "请输入 Runner 终端显示的设备码" });
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
        setStatus({
          tone: "error",
          text: `设备码不匹配。剩余尝试次数：${mismatch[1]}。请重新核对 Runner 终端的 CODE。`
        });
        setRunnerCodeInput("");
      } else if (raw === "runner_code_locked") {
        setStatus({ tone: "error", text: "尝试次数过多，本次配对已锁定。请在 Runner 重新发起。" });
        setRunnerCodeOffer(null);
        setRunnerCodeEnrollId(null);
      } else {
        setStatus({ tone: "error", text: `设备码配对失败：${raw}` });
      }
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
          `邮件配对已开始（${started.pairId}）。\n` +
          `请查收外部邮箱中的 magic link，并尽量用本浏览器打开。\n` +
          `过期时间：${started.expiresAt}。`
      });
      setStep(2);
    } catch (error) {
      setStatus({ tone: "error", text: `启动邮件配对失败：${errorText(error)}` });
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
        <h1 className="brand">Secure Gateway</h1>
        <p className="lede">正在检查 WebCrypto 与 IndexedDB 持久化…</p>
      </div>
    );
  }

  if (boot.kind === "blocked") {
    return (
      <div className="app">
        <h1 className="brand">Secure Gateway</h1>
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
        <div className="app-top-row">
          <div>
            <h1 className="brand">Secure Gateway</h1>
            <p className="lede">
              跨浏览器 E2EE 客户端。密钥以不可导出形式保存在本设备。Gateway 仅中继密文。协议：
              <code>cg-e2ee/1</code>。
            </p>
          </div>
          {desktopShell ? (
            <div className="app-top-actions" role="toolbar" aria-label="桌面端操作">
              <button
                type="button"
                className={`icon-action${accessReady ? "" : " icon-action-attention"}`}
                disabled={busy}
                onClick={onDesktopAccessLogin}
                title={accessReady ? "重新登录 Cloudflare Access" : "登录 Cloudflare Access"}
                aria-label={accessReady ? "重新登录 Cloudflare Access" : "登录 Cloudflare Access"}
              >
                <KeyRound aria-hidden="true" size={18} strokeWidth={1.75} />
              </button>
              {updateAvailable ? (
                <button
                  type="button"
                  className="icon-action icon-action-attention"
                  disabled={busy}
                  onClick={onDesktopUpgrade}
                  title={`升级到 ${updateAvailable}`}
                  aria-label={`升级到 ${updateAvailable}`}
                >
                  <ArrowUpCircle aria-hidden="true" size={18} strokeWidth={1.75} />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      {desktopShell && !accessReady ? (
        <div className="status warn" style={{ marginBottom: 12 }} role="status">
          <p style={{ margin: "0 0 0.75rem" }}>
            桌面客户端从本地加载 UI（<code>tauri.localhost</code>），与 Gateway 跨站，无法自动带上
            Cloudflare Access Cookie。请先完成 Access 登录；成功后桥接窗口会收纳到系统托盘，再进行
            Secure Gateway 配对。
          </p>
          <div className="row">
            <button type="button" disabled={busy} onClick={onDesktopAccessLogin}>
              登录 Cloudflare Access
            </button>
          </div>
        </div>
      ) : null}

      <ol className="steps">
        <li className={step > 1 ? "done" : step === 1 ? "active" : ""}>
          <span className="n">1</span>
          <span>
            {desktopShell
              ? "配置 Gateway 并完成 Cloudflare Access 登录"
              : "配置 Gateway origin（Cloudflare Access 登录）"}
          </span>
        </li>
        <li className={step > 2 ? "done" : step === 2 ? "active" : ""}>
          <span className="n">2</span>
          <span>使用 Passkey / Face ID / 指纹完成配对</span>
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
            {desktopShell ? (
              <button
                type="button"
                disabled={busy}
                onClick={onDesktopAccessLogin}
                title={accessReady ? "重新打开 Cloudflare Access 桥接登录" : "打开 Cloudflare Access 桥接登录"}
              >
                {accessReady ? "重新登录 Access" : "登录 Cloudflare Access"}
              </button>
            ) : null}
            <button type="button" className="secondary" disabled={busy} onClick={onRefresh}>
              刷新目录
            </button>
          </div>
        </form>
        {desktopShell && accessReady ? (
          <p className="meta" style={{ marginTop: 8 }}>
            Cloudflare Access 已就绪（桥接在系统托盘）。可继续下方设备配对。
          </p>
        ) : null}
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
        <h2>2. 设备配对</h2>
        <p className="meta">
          推荐主通道：<strong>Runner 设备码</strong>（无需扫码、无需邮箱）。在 Runner 终端读取一次性
          高熵码并输入到本页，再核对 6 词 SAS。Cloudflare Access 身份 + Runner 离线证书共同锚定信任。
          其余方式作为备选保留。
        </p>

        {rootSasEntries.length > 0 ? (
          <div
            className={`status ${rootSasState === "failed" ? "error" : rootSasState === "verified" ? "" : "warn"}`}
            style={{ marginBottom: 12 }}
          >
            <strong>首次安装信任边界：校验信任根 SAS</strong>
            <p className="meta" style={{ marginTop: 4 }}>
              本页锚定的离线信任根 SAS（须与 Runner 终端启动日志或已授权设备显示的一致）：
            </p>
            {rootSasEntries.map((entry) => (
              <div key={entry.fingerprint} style={{ margin: "4px 0" }}>
                <strong style={{ letterSpacing: "0.5px" }}>{entry.words.join(" ")}</strong>{" "}
                <span className="meta">（{entry.fingerprint.slice(7, 19)}…）</span>
              </div>
            ))}
            {rootSasState === "verified" ? (
              <p className="meta">✓ 已校验：信任根与独立渠道一致。</p>
            ) : (
              <>
                <p className="meta" style={{ marginTop: 6 }}>
                  从 <strong>Runner 终端 / 已授权设备</strong>（独立渠道，非本页）读取 6 词 root SAS
                  并输入校验。不通过则不要在本页配对（fail-closed）。首次通过 PWA
                  安装后，后续从本地缓存加载可减少被替换风险。
                </p>
                <input
                  value={rootSasInput}
                  onChange={(event) => setRootSasInput(event.target.value)}
                  placeholder="six word root sas"
                  autoComplete="off"
                  style={{ marginTop: 6 }}
                />
                <div className="row" style={{ marginTop: 6 }}>
                  <button type="button" disabled={busy} onClick={onVerifyRootSas}>
                    校验 root SAS
                  </button>
                </div>
                {rootSasState === "failed" ? (
                  <p className="meta" style={{ color: "#f87171" }}>
                    ✗ 不匹配。配对入口已禁用，请改用可信 PWA 或桌面 localhost verifier 后重试。
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        <div className="row" style={{ marginBottom: 12 }}>
          {runnerCodeEnabled ? (
            <button
              type="button"
              className={pairingPanel === "runnercode" ? undefined : "secondary"}
              disabled={busy}
              onClick={() => setPairingPanel("runnercode")}
            >
              Runner 设备码（推荐）
            </button>
          ) : null}
          <button
            type="button"
            className={pairingPanel === "approval" ? undefined : "secondary"}
            disabled={busy}
            onClick={() => setPairingPanel("approval")}
          >
            已授权设备批准
          </button>
          <button
            type="button"
            className={pairingPanel === "passkey" ? undefined : "secondary"}
            disabled={busy}
            onClick={() => setPairingPanel("passkey")}
          >
            Passkey
          </button>
          <button
            type="button"
            className={pairingPanel === "recovery" ? undefined : "secondary"}
            disabled={busy}
            onClick={() => setPairingPanel("recovery")}
          >
            恢复码 / 二维码
          </button>
          <button
            type="button"
            className={pairingPanel === "mail" ? undefined : "secondary"}
            disabled={busy}
            onClick={() => setPairingPanel("mail")}
          >
            邮箱 magic-link
          </button>
        </div>

        {pairingPanel === "runnercode" ? (
          <>
            <p className="meta">
              在已运行 Runner 的机器（WSL/终端）上，Runner 会打印一次性 <code>CODE</code> 与 6 词{" "}
              <code>SAS</code>（Gateway 看不到明文）。点「请求设备码」，然后把终端上的 CODE 输入下方并
              核对 SAS 一致，再提交。若 Runner 为手动批准模式，还需在终端执行{" "}
              <code>runner-code approve &lt;enrollId&gt;</code>。
            </p>
            {!runnerCodeOffer ? (
              <div className="row">
                <button
                  type="button"
                  disabled={busy || !api || rootSasState === "failed"}
                  onClick={onStartRunnerCode}
                >
                  请求设备码
                </button>
              </div>
            ) : (
              <>
                <label htmlFor="runnerCode">Runner 终端显示的设备码</label>
                <input
                  id="runnerCode"
                  value={runnerCodeInput}
                  onChange={(event) => setRunnerCodeInput(event.target.value)}
                  placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                  autoComplete="off"
                  autoCapitalize="characters"
                />
                <p className="meta">
                  enrollId：<code>{runnerCodeEnrollId}</code>
                </p>
                {runnerCodeSasWords ? (
                  <div className="status" style={{ marginTop: 8 }}>
                    本页 SAS（须与 Runner 终端一致）：
                    <br />
                    <strong style={{ fontSize: "1.1em", letterSpacing: "0.5px" }}>
                      {runnerCodeSasWords.join(" ")}
                    </strong>
                    <br />
                    <span className="meta">
                      若两侧 SAS 不一致，请勿提交——可能存在中继篡改。
                    </span>
                  </div>
                ) : null}
                <div className="row">
                  <button
                    type="button"
                    disabled={busy || !api || !runnerCodeSasWords || rootSasState === "failed"}
                    onClick={onConfirmRunnerCode}
                  >
                    SAS 一致，提交配对
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setRunnerCodeOffer(null);
                      setRunnerCodeEnrollId(null);
                      setRunnerCodeInput("");
                      setRunnerCodeSasWords(null);
                    }}
                  >
                    取消
                  </button>
                </div>
              </>
            )}
          </>
        ) : null}

        {pairingPanel === "passkey" ? (
          <>
            <p className="meta">
              优先使用本机平台认证器（Windows Hello PIN、Face ID、指纹）。请确认地址栏为{" "}
              <code>https://secure.joelzt.org</code>，并已设置 Windows Hello。
            </p>
            <div className="row">
              <button type="button" disabled={busy || !api} onClick={onPasskeyPair}>
                使用 Passkey / Windows Hello 继续
              </button>
            </div>
          </>
        ) : null}

        {pairingPanel === "approval" ? (
          <>
            <p className="meta">
              <strong>新设备：</strong>
              点「发起批准请求」，保持本页打开等待（约 10 分钟内）。
              <br />
              <strong>旧设备：</strong>
              打开已授权的{" "}
              <a href={gatewayInput || "https://cs.joelzt.org"} rel="noreferrer">
                CS
              </a>
              （推荐，聊天页会自动弹出待批准），或在本 Secure 已配对浏览器点「刷新待批准列表」后批准。须为同一
              Cloudflare Access 账号。仅在 CS 登录、本机 Secure 未配对时无法在此批准。
            </p>
            <div className="row">
              <button
                type="button"
                disabled={busy || !api || Boolean(boot.device.pairedRunnerId)}
                onClick={onRequestApproval}
                title={
                  boot.device.pairedRunnerId
                    ? "本机已配对；请用未配对的新设备发起请求"
                    : undefined
                }
              >
                发起批准请求（新设备）
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy || !api || !boot.device.pairedRunnerId}
                onClick={onRefreshApprovals}
              >
                刷新待批准列表（已配对设备）
              </button>
            </div>
            {boot.device.pairedRunnerId ? (
              <p className="meta">本机已配对，可作为旧设备批准；正在自动检查待批准请求…</p>
            ) : (
              <p className="meta">本机尚未配对，可作为新设备发起请求。</p>
            )}
            {approvalId ? (
              <p className="meta">
                当前 approvalId：<code>{approvalId}</code>
              </p>
            ) : null}
            {pendingApprovals.length > 0 ? (
              <ul className="meta">
                {pendingApprovals.map((item) => (
                  <li key={item.approvalId} style={{ marginBottom: 8 }}>
                    <code>{item.request.newClientId.slice(0, 12)}…</code>
                    {" · "}
                    {item.request.label ?? "新设备"}
                    <div className="row" style={{ marginTop: 6 }}>
                      <button
                        type="button"
                        disabled={busy || !boot.device.pairedRunnerId}
                        onClick={() => onDecideApproval(item.request, "approved")}
                      >
                        批准
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || !boot.device.pairedRunnerId}
                        onClick={() => onDecideApproval(item.request, "rejected")}
                      >
                        拒绝
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : boot.device.pairedRunnerId ? (
              <p className="meta">暂无待批准请求。</p>
            ) : null}
          </>
        ) : null}

        {pairingPanel === "recovery" ? (
          <>
            <p className="meta">
              在 Runner 本机（WSL）生成一次性高熵二维码 / 恢复码（Gateway 看不到明文）。最短步骤：
            </p>
            <pre className="meta" style={{ whiteSpace: "pre-wrap", margin: "8px 0" }}>
              {`cd ~/cursor-e2ee
# 在已配置 RUNNER_* / GATEWAY_URL 的环境中执行（会自动发布 public handle）
npx tsx scripts/e2ee/trust-root-cli.ts recovery-code --runner-id wsl-e2ee`}
            </pre>
            <p className="meta">
              终端会打印带 <code>#recover=...</code> 的 URL 与分组恢复码。用同一浏览器打开该
              URL，或在下方粘贴 recoveryId 与恢复码。
            </p>
            <label htmlFor="recoveryId">recoveryId</label>
            <input
              id="recoveryId"
              value={recoveryIdInput}
              onChange={(event) => setRecoveryIdInput(event.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              autoComplete="off"
            />
            <label htmlFor="recoverySecret">恢复码（base64url 或 Crockford 分组）</label>
            <input
              id="recoverySecret"
              value={recoverySecretInput}
              onChange={(event) => setRecoverySecretInput(event.target.value)}
              placeholder="XXXX-XXXX-…"
              autoComplete="off"
            />
            <div className="row">
              <button type="button" disabled={busy || !api} onClick={onRecoveryPair}>
                使用恢复码完成配对
              </button>
            </div>
          </>
        ) : null}

        {pairingPanel === "mail" ? (
          <>
            <p className="meta">
              备用：外部邮箱 magic link。公司无法访问外部邮件时请使用 Passkey。Token 留在 URL
              fragment / Runner 邮件路径，Gateway 仅存公开元数据。
            </p>
            <div className="row">
              <button type="button" disabled={busy || !api} onClick={onStartPairing}>
                开始邮件配对
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
          </>
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
