import { Agent, AgentNotFoundError, Cursor, CursorAgentError, configureCursorSdk } from "@cursor/sdk";
import type { SDKMessage } from "@cursor/sdk";

// This WSL host is region-blocked and reaches Cursor only via the local HTTP
// proxy. The SDK's agent RPC uses @connectrpc/connect-node; its HTTP/2 path
// cannot be routed through an HTTP CONNECT proxy, so force HTTP/1.1. The
// proxy-preload then tunnels node:https through the proxy (see run-e2ee-runner.sh
// / proxy-preload.mjs). Without this the agent egresses DIRECT and fails with
// "Model not available ... not supported in your region".
configureCursorSdk({ local: { useHttp1ForAgent: true } });
import type {
  ModelInfo,
  RunProgressKind,
  RunnerJob,
  RunnerJobResult
} from "@cursor-gateway/shared";
import { config } from "./config.js";
import { toLocalPath } from "./pathTranslation.js";

export type ProgressReporter = (progress: {
  kind: RunProgressKind;
  message: string;
}) => Promise<void>;

function buildPrompt(job: RunnerJob, includeHistory: boolean) {
  const identityBlock = job.userIdentity
    ? `User identity: ${job.userIdentity}\nUse this identity when the user asks who they are.`
    : "";
  const memoryBlock =
    job.memory.length > 0
      ? `Durable user and workspace memory:\n${job.memory.map((fact) => `- ${fact}`).join("\n")}`
      : "";

  const writePolicy = job.allowWrites
    ? "You may read and write files only inside the configured workspace."
    : "Do not modify files. You may inspect and explain only.";
  const historyBlock =
    includeHistory && job.history.length > 0
      ? `Previous conversation turns:\n${job.history
          .map(
            (turn, index) =>
              `Turn ${index + 1} user:\n${turn.prompt}\n\nTurn ${index + 1} assistant:\n${turn.response}`
          )
          .join("\n\n")}`
      : "";

  return [
    `Workspace: ${job.workspace.path}`,
    `Policy: ${writePolicy}`,
    identityBlock,
    memoryBlock,
    historyBlock,
    "User request:",
    job.prompt
  ].filter(Boolean).join("\n\n");
}

function extractResultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const maybe = result as Record<string, unknown>;
  if (typeof maybe.result === "string") return maybe.result;
  if (typeof maybe.text === "string") return maybe.text;
  if (typeof maybe.output === "string") return maybe.output;
  return undefined;
}

function extractErrorMessage(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const err = (result as { error?: unknown }).error;
  if (typeof err === "string" && err.trim()) return err;
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return undefined;
}

function assistantTextFromMessage(
  message: Extract<SDKMessage, { type: "assistant" }>
): string {
  return message.message.content
    .filter((block): block is Extract<(typeof message.message.content)[number], { type: "text" }> =>
      block.type === "text"
    )
    .map((block) => block.text)
    .join("");
}

async function lastAssistantFromConversation(run: {
  supports(operation: "conversation"): boolean;
  conversation(): Promise<unknown[]>;
}): Promise<string> {
  try {
    if (!run.supports("conversation")) return "";
    const turns = await run.conversation();
    let text = "";
    for (const turn of turns) {
      if (
        turn &&
        typeof turn === "object" &&
        (turn as { type?: unknown }).type === "agentConversationTurn"
      ) {
        const steps = (turn as { turn?: { steps?: unknown } }).turn?.steps;
        if (Array.isArray(steps)) {
          for (const step of steps) {
            if (
              step &&
              typeof step === "object" &&
              (step as { type?: unknown }).type === "assistantMessage"
            ) {
              const stepText = (step as { message?: { text?: unknown } }).message?.text;
              if (typeof stepText === "string" && stepText.trim()) text = stepText;
            }
          }
        }
      }
    }
    return text;
  } catch {
    return "";
  }
}

function isAgentNotFoundError(error: unknown) {
  return (
    error instanceof AgentNotFoundError ||
    (error instanceof CursorAgentError && error.code === "agent_not_found")
  );
}

function progressFromMessage(message: SDKMessage): {
  kind: RunProgressKind;
  message: string;
} | undefined {
  if (message.type === "thinking" && message.text.trim()) {
    return { kind: "thinking", message: "The model is thinking." };
  }
  if (message.type === "assistant") {
    const text = assistantTextFromMessage(message);
    return text.trim() ? { kind: "responding", message: text } : undefined;
  }
  if (message.type === "tool_call") {
    return {
      kind: "tool",
      message: `${message.status === "running" ? "Using" : "Used"} ${message.name}`
    };
  }
  if (message.type === "task" && message.text?.trim()) {
    return { kind: "working", message: message.text };
  }
  if (message.type === "status" && message.message?.trim()) {
    return { kind: "working", message: message.message };
  }
  return undefined;
}

export async function listCursorModels(): Promise<ModelInfo[]> {
  try {
    const response = await Cursor.models.list({ apiKey: config.cursorApiKey });
    const items = Array.isArray(response) ? response : Object.values(response as Record<string, unknown>);
    const models: ModelInfo[] = [];
    for (const item of items) {
      const record = item as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : undefined;
      if (!id) continue;
      const displayName =
        typeof record.displayName === "string"
          ? record.displayName
          : typeof record.name === "string"
            ? record.name
            : undefined;
      models.push(displayName ? { id, displayName } : { id });
    }
    return models;
  } catch {
    console.warn("Failed to list Cursor models; falling back to configured default");
    return config.defaultModel === "auto" ? [] : [{ id: config.defaultModel }];
  }
}

export async function runCursorJob(
  job: RunnerJob,
  reportProgress?: ProgressReporter
): Promise<RunnerJobResult> {
  let agent: Awaited<ReturnType<typeof Agent.create>> | Awaited<ReturnType<typeof Agent.resume>> | undefined;

  try {
    let includeHistory = !job.agentId;
    const agentOptions = {
      apiKey: config.cursorApiKey,
      model: { id: job.model },
      local: { cwd: toLocalPath(job.workspace.path) }
    };

    if (job.agentId) {
      try {
        agent = await Agent.resume(job.agentId, agentOptions);
      } catch (error) {
        if (!isAgentNotFoundError(error)) throw error;
        console.warn("Stored Cursor agent was not found; creating a replacement");
        agent = await Agent.create(agentOptions);
        includeHistory = true;
      }
    } else {
      agent = await Agent.create(agentOptions);
    }

    const run = await agent.send(buildPrompt(job, includeHistory));
    let lastAssistantText = "";
    if (reportProgress && run.supports("stream")) {
      for await (const message of run.stream()) {
        if (message.type === "assistant") {
          const text = assistantTextFromMessage(message);
          if (text.trim()) lastAssistantText = text;
        }
        const progress = progressFromMessage(message);
        if (progress) await reportProgress(progress);
      }
    }
    const result = await run.wait();
    const status = (result as { status?: string }).status;
    const usage = result.usage ?? run.usage;
    const inputTokens = usage?.inputTokens ?? null;
    const outputTokens = usage?.outputTokens ?? null;

    if (status && status !== "finished") {
      const errorMessage =
        extractErrorMessage(result) ??
        extractResultText(result) ??
        (lastAssistantText.trim() || `模型运行结束，状态为「${status}」。`);
      return {
        runId: job.runId,
        status: "error",
        response: null,
        error: errorMessage,
        agentId: "agentId" in agent ? String(agent.agentId) : null,
        inputTokens,
        outputTokens
      };
    }

    let responseText = extractResultText(result) ?? "";
    if (!responseText.trim() && lastAssistantText.trim()) {
      responseText = lastAssistantText;
    }
    if (!responseText.trim()) {
      responseText = await lastAssistantFromConversation(run);
    }

    return {
      runId: job.runId,
      status: "finished",
      response: responseText,
      error: null,
      agentId: "agentId" in agent ? String(agent.agentId) : null,
      inputTokens,
      outputTokens
    };
  } catch (error) {
    const message =
      error instanceof CursorAgentError
        ? `${error.message} retryable=${error.isRetryable}`
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      runId: job.runId,
      status: "error",
      response: null,
      error: message,
      agentId: agent && "agentId" in agent ? String(agent.agentId) : null,
      inputTokens: null,
      outputTokens: null
    };
  } finally {
    const disposable = agent as { [Symbol.asyncDispose]?: () => Promise<void>; close?: () => Promise<void> } | undefined;
    const dispose = disposable?.[Symbol.asyncDispose];
    if (dispose) await dispose.call(disposable);
    else if (disposable?.close) await disposable.close();
  }
}
