import { useState } from "react";
import {
  diagnosticClipboardText,
  type UserDiagnostic
} from "./diagnostics.js";

export type UiStatus = {
  tone: "info" | "ok" | "warn" | "error";
  text: string;
  diagnostic?: UserDiagnostic;
};

export function StatusNotice({ status }: { status: UiStatus }) {
  const [copied, setCopied] = useState(false);
  const diagnostic = status.diagnostic;

  async function copyDiagnostic() {
    if (!diagnostic) return;
    try {
      await navigator.clipboard.writeText(diagnosticClipboardText(diagnostic));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div
      className={`status ${status.tone === "info" ? "" : status.tone}`}
      role={status.tone === "error" ? "alert" : "status"}
      aria-live={status.tone === "error" ? "assertive" : "polite"}
    >
      <strong>{diagnostic?.title ?? status.text}</strong>
      {diagnostic ? <p className="status-message">{diagnostic.message}</p> : null}
      {diagnostic ? (
        <details className="diagnostic">
          <summary>查看诊断信息</summary>
          <dl>
            <div>
              <dt>失败环节</dt>
              <dd>{diagnostic.operation}</dd>
            </div>
            <div>
              <dt>目标</dt>
              <dd>{diagnostic.endpoint ?? "本地操作"}</dd>
            </div>
            <div>
              <dt>可能原因</dt>
              <dd>{diagnostic.possibleCause}</dd>
            </div>
            <div>
              <dt>下一步</dt>
              <dd>{diagnostic.nextStep}</dd>
            </div>
            <div>
              <dt>诊断编号</dt>
              <dd>
                <code>{diagnostic.diagnosticId}</code>
              </dd>
            </div>
          </dl>
          <button type="button" className="secondary diagnostic-copy" onClick={copyDiagnostic}>
            {copied ? "已复制" : "复制诊断信息"}
          </button>
        </details>
      ) : null}
    </div>
  );
}
