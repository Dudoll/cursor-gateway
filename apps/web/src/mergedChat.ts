/** Merge plaintext + E2EE conversations / message turns for a single CS chat UI. */

export const HISTORICAL_PLAINTEXT_LABEL = "历史明文";

export type MergedConversationKind = "e2ee" | "plaintext";

export type MergedConversationItem = {
  id: string;
  workspaceId: string;
  title: string;
  kind: MergedConversationKind;
  /** ISO timestamp used for sidebar ordering (newest first). */
  sortAt: string;
  runCount?: number;
};

export type PlaintextConversationLike = {
  id: string;
  workspaceId: string;
  title: string | null;
  runCount: number;
  lastRunAt: string | null;
  updatedAt: string;
  createdAt: string;
};

export type E2eeConversationLike = {
  id: string;
  workspaceId: string;
  updatedAt: string;
};

export type TimelineTurn =
  | {
      kind: "e2ee";
      id: string;
      createdAt: string;
      run: unknown;
    }
  | {
      kind: "plaintext";
      id: string;
      createdAt: string;
      run: unknown;
    };

/**
 * Unified sidebar list: E2EE + historical plaintext, newest first.
 * Same id appearing in both (should not happen) prefers E2EE.
 */
export function mergeConversationLists(input: {
  plaintext: PlaintextConversationLike[];
  e2ee: E2eeConversationLike[];
  e2eeTitles?: Record<string, string>;
}): MergedConversationItem[] {
  const byId = new Map<string, MergedConversationItem>();

  for (const conversation of input.plaintext) {
    byId.set(conversation.id, {
      id: conversation.id,
      workspaceId: conversation.workspaceId,
      title: conversation.title?.trim() || "未命名会话",
      kind: "plaintext",
      sortAt:
        conversation.lastRunAt || conversation.updatedAt || conversation.createdAt,
      runCount: conversation.runCount
    });
  }

  for (const conversation of input.e2ee) {
    byId.set(conversation.id, {
      id: conversation.id,
      workspaceId: conversation.workspaceId,
      title: input.e2eeTitles?.[conversation.id] ?? "加密会话",
      kind: "e2ee",
      sortAt: conversation.updatedAt
    });
  }

  return [...byId.values()].sort((a, b) => {
    const delta = Date.parse(b.sortAt) - Date.parse(a.sortAt);
    if (delta !== 0) return delta;
    return a.id.localeCompare(b.id);
  });
}

/** Sort message turns ascending for a single conversation timeline. */
export function sortTimelineTurns<T extends { createdAt: string; id: string }>(
  turns: T[]
): T[] {
  return [...turns].sort((a, b) => {
    const delta = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (delta !== 0) return delta;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Build a mixed timeline from plaintext runs + decrypted E2EE runs.
 * Used when presenting one conversation pane; typically only one side is non-empty
 * (DB keeps content_mode separate), but both are accepted and sorted by time.
 */
export function buildMergedTimeline(input: {
  plaintextRuns: Array<{ id: string; createdAt: string }>;
  e2eeRuns: Array<{ record: { id: string; createdAt: string } }>;
}): TimelineTurn[] {
  const turns: TimelineTurn[] = [
    ...input.plaintextRuns.map((run) => ({
      kind: "plaintext" as const,
      id: run.id,
      createdAt: run.createdAt,
      run
    })),
    ...input.e2eeRuns.map((run) => ({
      kind: "e2ee" as const,
      id: run.record.id,
      createdAt: run.record.createdAt,
      run
    }))
  ];
  return sortTimelineTurns(turns);
}
