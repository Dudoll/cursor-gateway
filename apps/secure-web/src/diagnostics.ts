import { GatewayApiError } from "./api.js";
import { desktopLogDiagnostic } from "./desktopShell.js";

export type FailureStage =
  | "startup"
  | "access"
  | "pairing-start"
  | "pairing-options"
  | "passkey"
  | "pairing-submit"
  | "runner-confirmation"
  | "directory"
  | "chat"
  | "update-check"
  | "update-download";

export type FailureContext = {
  stage: FailureStage;
  operation: string;
  endpoint?: string;
};

export type UserDiagnostic = {
  code: string;
  title: string;
  message: string;
  possibleCause: string;
  nextStep: string;
  stage: FailureStage;
  operation: string;
  endpoint: string | null;
  diagnosticId: string;
  requestId: string | null;
  httpStatus: number | null;
};

type ErrorCopy = Pick<
  UserDiagnostic,
  "title" | "message" | "possibleCause" | "nextStep"
>;

const COPY: Record<string, ErrorCopy> = {
  network_unreachable: {
    title: "无法连接服务",
    message: "当前操作没有到达服务端。",
    possibleCause: "网络中断、域名无法访问，或安全软件拦截了连接。",
    nextStep: "检查网络后重试；如果网页可以打开，请重新登录后再试。"
  },
  network_or_cors: {
    title: "无法读取远程信息",
    message: "浏览器没有返回可读取的响应。",
    possibleCause: "网络瞬断、安全软件拦截，或目标站点未允许当前页面读取响应。",
    nextStep: "恢复网络后重试；客户端不会把它直接断定为 CORS。"
  },
  cors_origin_blocked: {
    title: "当前页面未获准连接",
    message: "服务端拒绝了这个页面来源。",
    possibleCause: "客户端地址与服务端允许的地址不一致。",
    nextStep: "只使用正式客户端或正式网站，然后重新登录。"
  },
  secure_origin_mismatch: {
    title: "当前页面地址不正确",
    message: "服务端拒绝了当前页面发起的验证。",
    possibleCause: "验证页面不是受信任的正式地址。",
    nextStep: "关闭其他镜像页面，只在正式客户端中重试。"
  },
  cloudflare_login_required: {
    title: "登录已失效",
    message: "当前操作需要重新登录。",
    possibleCause: "登录尚未完成，或登录状态已经过期。",
    nextStep: "点击“登录以继续”，完成后客户端会自动返回当前流程。"
  },
  access_bridge_login_timeout: {
    title: "登录等待超时",
    message: "客户端没有在规定时间内确认登录完成。",
    possibleCause: "登录窗口未完成验证，或登录页面网络不稳定。",
    nextStep: "重新打开登录窗口并完成验证。"
  },
  access_bridge_create: {
    title: "无法打开登录窗口",
    message: "客户端未能创建登录窗口。",
    possibleCause: "系统窗口服务暂时不可用。",
    nextStep: "关闭客户端后重新打开，再尝试登录。"
  },
  request_timeout: {
    title: "请求超时",
    message: "服务端在规定时间内没有返回结果。",
    possibleCause: "网络不稳定，或目标服务暂时繁忙。",
    nextStep: "稍后重试；如果连续失败，请先重新登录。"
  },
  access_bridge_fetch_timeout: {
    title: "请求超时",
    message: "登录窗口没有在规定时间内完成请求。",
    possibleCause: "登录窗口被系统暂停，或网络连接中断。",
    nextStep: "重新登录后重试。"
  },
  access_network_retry_exhausted: {
    title: "登录网络持续不稳定",
    message: "客户端已自动重试，但仍无法稳定确认登录。",
    possibleCause: "网络持续中断，或登录窗口无法连接服务。",
    nextStep: "确认网络恢复后重新点击登录。"
  },
  access_login_cancelled: {
    title: "登录已取消",
    message: "客户端已停止登录检查。",
    possibleCause: "你选择了取消。",
    nextStep: "准备好后重新点击登录。"
  },
  passkey_rp_id_mismatch: {
    title: "此处不能使用 Passkey",
    message: "Passkey 的网站身份与当前验证窗口不一致。",
    possibleCause: "验证被错误地放在了本地页面或其他网站中。",
    nextStep: "关闭验证窗口并重试；客户端会改用受信任的验证窗口。"
  },
  passkey_security_error: {
    title: "此处不能使用 Passkey",
    message: "系统拒绝了当前验证页面。",
    possibleCause: "验证页面地址与 Passkey 所属网站不一致。",
    nextStep: "关闭其他页面，只在客户端弹出的安全窗口中重试。"
  },
  passkey_user_cancelled: {
    title: "验证已取消",
    message: "Passkey 验证没有完成。",
    possibleCause: "你关闭了系统验证窗口或按下了取消。",
    nextStep: "准备好后重新尝试。"
  },
  passkey_not_allowed: {
    title: "系统未允许 Passkey",
    message: "Windows 没有完成这次验证。",
    possibleCause: "Windows Hello 未设置、被策略禁用，或没有可用凭据。",
    nextStep: "确认 Windows Hello 可用后重试，也可以选择其他验证方式。"
  },
  passkey_not_allowed_or_timeout: {
    title: "Passkey 未完成",
    message: "系统验证被拒绝或等待超时。",
    possibleCause: "Windows Hello 不可用、验证窗口超时，或操作被取消。",
    nextStep: "确认 Windows Hello 可用后重试，也可以选择其他验证方式。"
  },
  passkey_timed_out: {
    title: "Passkey 验证超时",
    message: "系统验证窗口等待时间已结束。",
    possibleCause: "没有及时完成 PIN、指纹或人脸验证。",
    nextStep: "重新尝试并及时完成系统验证。"
  },
  passkey_aborted: {
    title: "Passkey 验证被中断",
    message: "系统在完成前终止了验证。",
    possibleCause: "验证窗口被关闭，或另一个验证请求取代了它。",
    nextStep: "关闭其他验证窗口后重试。"
  },
  passkey_options_timeout: {
    title: "设备没有返回验证请求",
    message: "已发起配对，但授权设备没有及时响应。",
    possibleCause: "Runner 离线、忙碌，或与服务端断开连接。",
    nextStep: "确认授权设备在线后重新发起。"
  },
  runner_offline: {
    title: "授权设备离线",
    message: "服务端没有检测到可完成此操作的设备。",
    possibleCause: "Runner 未启动或网络已断开。",
    nextStep: "启动 Runner，等待它恢复在线后重试。"
  },
  passkey_expired: {
    title: "验证已过期",
    message: "这次 Passkey 请求已失效。",
    possibleCause: "验证等待时间过长。",
    nextStep: "重新发起 Passkey 验证。"
  },
  desktop_installer_unavailable: {
    title: "安装包尚未就绪",
    message: "发现新版本，但服务端还没有可下载的安装包。",
    possibleCause: "发布流程尚未完成或安装包部署失败。",
    nextStep: "客户端会稍后自动检查；无需反复点击。"
  },
  desktop_update_hash_mismatch: {
    title: "安装包校验失败",
    message: "下载的安装包与发布记录不一致，客户端没有运行它。",
    possibleCause: "下载不完整、缓存异常，或文件在传输中被替换。",
    nextStep: "稍后重新下载；连续失败时不要手动运行该文件。"
  },
  desktop_download_too_small: {
    title: "安装包下载不完整",
    message: "下载内容不是有效的安装包。",
    possibleCause: "下载被中断，或服务端返回了错误页面。",
    nextStep: "重新登录后再次下载。"
  },
  desktop_download_invalid_executable: {
    title: "安装包格式不正确",
    message: "下载内容不是可运行的 Windows 安装包。",
    possibleCause: "服务端返回了错误文件，或下载内容已损坏。",
    nextStep: "不要运行该文件；稍后重新下载。"
  },
  desktop_download_write: {
    title: "无法保存安装包",
    message: "客户端没有把安装包写入临时目录。",
    possibleCause: "临时目录空间不足，或安全软件阻止了写入。",
    nextStep: "释放磁盘空间并允许客户端写入临时目录，然后重试。"
  },
  desktop_installer_spawn: {
    title: "无法启动安装程序",
    message: "安装包已校验，但 Windows 没有启动它。",
    possibleCause: "安全软件或系统策略阻止了安装程序。",
    nextStep: "保留诊断编号，检查系统拦截记录后重试。"
  },
  desktop_update_check_failed: {
    title: "暂时无法检查更新",
    message: "客户端没有取得有效的版本信息。",
    possibleCause: "网络暂时不可用，或版本信息尚未发布。",
    nextStep: "客户端会自动重试，也可以在窗口恢复后再次检查。"
  },
  desktop_update_html_fallback: {
    title: "版本地址返回了网页",
    message: "更新地址返回的是 HTML 页面，不是版本清单。",
    possibleCause: "静态文件缺失，被站点的 SPA fallback 接管。",
    nextStep: "等待发布端修复清单地址；客户端不会显示升级按钮。"
  },
  desktop_update_content_type_invalid: {
    title: "版本清单类型不正确",
    message: "更新地址返回了不受支持的内容类型。",
    possibleCause: "CDN 或静态站点配置错误。",
    nextStep: "客户端会停止使用该响应并稍后重试。"
  },
  desktop_update_json_invalid: {
    title: "版本清单不是有效 JSON",
    message: "客户端无法解析更新清单。",
    possibleCause: "清单发布不完整或内容已损坏。",
    nextStep: "等待发布端重新生成清单。"
  },
  desktop_update_hash_missing: {
    title: "版本清单缺少校验值",
    message: "清单没有提供安装包 SHA256。",
    possibleCause: "发布流程未完成。",
    nextStep: "客户端不会显示或安装这个版本。"
  },
  desktop_update_schema_unsupported: {
    title: "版本清单格式不受支持",
    message: "清单版本与当前客户端不兼容。",
    possibleCause: "发布端使用了未知格式。",
    nextStep: "等待兼容清单或新版客户端。"
  },
  desktop_update_installer_url_invalid: {
    title: "安装包地址不可信",
    message: "清单中的安装包地址不在允许范围内。",
    possibleCause: "清单配置错误或被替换。",
    nextStep: "不要下载安装；等待发布端修复。"
  },
  recovery_code_missing: {
    title: "恢复信息不完整",
    message: "恢复编号或恢复码尚未填写。",
    possibleCause: "输入被遗漏，或恢复链接不完整。",
    nextStep: "重新输入完整的恢复编号和恢复码。"
  },
  runner_code_locked: {
    title: "本次设备代码已锁定",
    message: "错误次数已达到上限。",
    possibleCause: "输入的设备代码与授权设备显示的不一致。",
    nextStep: "在授权设备上重新生成代码，再发起一次验证。"
  },
  runner_code_missing: {
    title: "请输入设备代码",
    message: "设备代码尚未填写。",
    possibleCause: "还没有从授权设备读取代码。",
    nextStep: "输入授权设备当前显示的完整代码。"
  },
  device_approval_rejected: {
    title: "设备批准被拒绝",
    message: "已授权设备没有批准本次请求。",
    possibleCause: "批准人选择了拒绝，或请求内容不符合预期。",
    nextStep: "确认设备无误后重新发起，或选择其他验证方式。"
  },
  service_client_error: {
    title: "请求未被接受",
    message: "服务端拒绝了当前操作。",
    possibleCause: "请求已过期、状态不一致，或输入不完整。",
    nextStep: "返回当前步骤，检查后重新尝试。"
  },
  service_server_error: {
    title: "服务暂时不可用",
    message: "服务端处理当前操作时发生错误。",
    possibleCause: "服务正在重启或出现临时故障。",
    nextStep: "稍后重试；客户端会保留诊断编号。"
  },
  internal_client_error: {
    title: "客户端未能完成操作",
    message: "客户端遇到了未预期的问题。",
    possibleCause: "本地状态损坏或当前版本存在兼容问题。",
    nextStep: "重试一次；若仍失败，请保留诊断编号。"
  }
};

const CODE_ALIASES: Record<string, string> = {
  "Failed to fetch": "network_or_cors",
  failed_to_fetch: "network_or_cors",
  network_error: "network_or_cors",
  e2ee_runner_offline: "runner_offline",
  access_expired: "cloudflare_login_required",
  passkey_ceremony_failed: "passkey_not_allowed",
  passkey_unsupported_browser: "passkey_not_allowed",
  passkey_bridge_unsupported: "passkey_not_allowed",
  passkey_options_timeout: "runner_offline",
  passkey_ack_timeout: "runner_offline",
  desktop_download_http_404: "desktop_installer_unavailable"
};

function stableCode(value: unknown): string {
  if (value instanceof GatewayApiError) return value.code;
  if (value instanceof DOMException) {
    if (value.name === "SecurityError") return "passkey_security_error";
    if (value.name === "AbortError") return "passkey_aborted";
    if (value.name === "NotAllowedError") return "passkey_not_allowed_or_timeout";
  }
  if (value instanceof Error) {
    if (value.name === "AbortError") return "request_timeout";
    if (value instanceof TypeError && /fetch|network/i.test(value.message)) {
      return "network_or_cors";
    }
    return value.message.trim() || "internal_client_error";
  }
  if (typeof value === "string" && value.trim()) return value.trim();
  return "internal_client_error";
}

export function errorCode(error: unknown): string {
  const raw = stableCode(error);
  const withoutDetails = raw.split(":")[0] ?? raw;
  return CODE_ALIASES[withoutDetails] ?? withoutDetails;
}

function diagnosticId(requestId: string | null): string {
  if (requestId && /^[A-Za-z0-9._:-]{1,96}$/.test(requestId)) return requestId;
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replaceAll("-", "").slice(0, 12)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return `CG-${random.toUpperCase()}`;
}

function safeEndpoint(endpoint: string | undefined): string | null {
  if (!endpoint) return null;
  try {
    const parsed = new URL(endpoint, "https://diagnostic.invalid");
    return `${parsed.origin === "https://diagnostic.invalid" ? "" : parsed.origin}${parsed.pathname}`;
  } catch {
    return endpoint.split("?")[0]?.slice(0, 180) ?? null;
  }
}

function copyFor(code: string, error: unknown): ErrorCopy {
  if (COPY[code]) return COPY[code];
  if (code.startsWith("passkey_runner_cert_")) {
    return {
      title: "授权设备身份校验失败",
      message: "客户端无法确认响应来自受信任设备。",
      possibleCause: "设备证书已过期、地址不一致或信任配置发生变化。",
      nextStep: "不要继续配对；确认 Runner 配置后重新尝试。"
    };
  }
  if (code.startsWith("runner_code_code_mismatch_")) {
    const remaining = code.match(/(\d+)$/)?.[1] ?? "0";
    return {
      title: "设备代码不匹配",
      message: `输入的代码不正确，剩余尝试次数：${remaining}。`,
      possibleCause: "代码输入有误，或授权设备已经生成了新代码。",
      nextStep: "重新核对授权设备当前显示的代码和确认词。"
    };
  }
  if (code.startsWith("desktop_update_metadata_") || code === "desktop_update_check_timeout") {
    return COPY.desktop_update_check_failed!;
  }
  if (code.startsWith("desktop_download_write:")) {
    return COPY.desktop_download_write!;
  }
  if (code.startsWith("desktop_installer_spawn:")) {
    return COPY.desktop_installer_spawn!;
  }
  if (code.startsWith("passkey_")) {
    return {
      title: "Passkey 配对未完成",
      message: "Passkey 流程在完成前失败。",
      possibleCause: "验证请求失效、凭据不匹配，或授权设备拒绝了请求。",
      nextStep: "重新发起；连续失败时选择其他验证方式。"
    };
  }
  if (error instanceof GatewayApiError) {
    return error.status >= 500 ? COPY.service_server_error! : COPY.service_client_error!;
  }
  if (/^http_5\d\d$/.test(code)) return COPY.service_server_error!;
  if (/^http_4\d\d$/.test(code)) return COPY.service_client_error!;
  return COPY.internal_client_error!;
}

export function normalizeFailure(error: unknown, context: FailureContext): UserDiagnostic {
  const code = errorCode(error);
  const copy = copyFor(code, error);
  const requestId = error instanceof GatewayApiError ? error.requestId : null;
  return {
    code,
    ...copy,
    stage: context.stage,
    operation: context.operation,
    endpoint: safeEndpoint(context.endpoint),
    diagnosticId: diagnosticId(requestId),
    requestId,
    httpStatus: error instanceof GatewayApiError ? error.status : null
  };
}

export function persistDiagnostic(
  value: UserDiagnostic,
  retryAttempt?: number
): void {
  void desktopLogDiagnostic({
    stage: value.stage,
    operation: value.operation,
    ...(value.endpoint ? { endpoint: value.endpoint } : {}),
    errorCode: value.code,
    clientRequestId: value.diagnosticId,
    ...(value.requestId ? { requestId: value.requestId } : {}),
    ...(value.httpStatus !== null ? { httpStatus: value.httpStatus } : {}),
    ...(retryAttempt !== undefined ? { retryAttempt } : {})
  }).catch(() => {
    // Diagnostics must never break the user flow.
  });
}

export function persistOperationalDiagnostic(entry: {
  stage: FailureStage | "gateway-request";
  operation: string;
  endpoint?: string;
  errorCode: string;
  clientRequestId?: string;
  requestId?: string;
  httpStatus?: number;
  retryAttempt?: number;
}): void {
  void desktopLogDiagnostic({
    ...entry
  }).catch(() => {
    // Best-effort and always redacted by the Rust boundary.
  });
}

export function diagnosticClipboardText(value: UserDiagnostic): string {
  return [
    `诊断编号: ${value.diagnosticId}`,
    `错误码: ${value.code}`,
    `失败环节: ${value.operation}`,
    `目标: ${value.endpoint ?? "本地操作"}`,
    `可能原因: ${value.possibleCause}`,
    `下一步: ${value.nextStep}`
  ].join("\n");
}
