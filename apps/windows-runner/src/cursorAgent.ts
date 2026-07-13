import { Agent, AgentNotFoundError, Cursor, CursorAgentError } from "@cursor/sdk";
import type { SDKMessage } from "@cursor/sdk";
import type {
  ModelInfo,
  RunProgressKind,
  RunnerJob,
  RunnerJobResult
} from "@cursor-gateway/shared";
import { config } from "./config.js";

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

function extractText(result: unknown) {
  if (!result || typeof result !== "object") return "";
  const maybe = result as Record<string, unknown>;
  if (typeof maybe.result === "string") return maybe.result;
  if (typeof maybe.text === "string") return maybe.text;
  if (typeof maybe.output === "string") return maybe.output;
  return "Cursor returned an unsupported result shape.";
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
    const text = message.message.content
      .filter((block): block is Extract<(typeof message.message.content)[number], { type: "text" }> =>
        block.type === "text"
      )
      .map((block) => block.text)
      .join("");
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
      local: { cwd: job.workspace.path }
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
    if (reportProgress && run.supports("stream")) {
      for await (const message of run.stream()) {
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
      return {
        runId: job.runId,
        status: "error",
        response: null,
        error: extractText(result),
        agentId: "agentId" in agent ? String(agent.agentId) : null,
        inputTokens,
        outputTokens
      };
    }

    return {
      runId: job.runId,
      status: "finished",
      response: extractText(result),
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
