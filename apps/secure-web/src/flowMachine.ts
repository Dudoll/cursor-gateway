export type PairingMethod = "approval" | "passkey" | "runnercode" | "recovery" | "mail";

export type FlowState =
  | { phase: "access"; resume: "pairing" | "chat" }
  | { phase: "pairing"; method: PairingMethod | null }
  | { phase: "verification"; method: PairingMethod }
  | { phase: "complete"; runnerId: string }
  | { phase: "chat"; runnerId: string };

export type FlowEvent =
  | { type: "BOOT"; accessReady: boolean; runnerId?: string | null }
  | { type: "ACCESS_READY"; runnerId?: string | null }
  | { type: "ACCESS_EXPIRED" }
  | { type: "SELECT_METHOD"; method: PairingMethod }
  | { type: "START_VERIFICATION" }
  | { type: "VERIFICATION_FAILED" }
  | { type: "CANCEL_VERIFICATION" }
  | { type: "PAIRED"; runnerId: string }
  | { type: "CONTINUE_TO_CHAT" }
  | { type: "LOGGED_OUT" };

export type FlowTransition = {
  state: FlowState;
  accepted: boolean;
};

export const initialFlowState: FlowState = { phase: "access", resume: "pairing" };

function pairedRunner(state: FlowState): string | null {
  if (state.phase === "chat" || state.phase === "complete") return state.runnerId;
  return null;
}

/**
 * Pure, explicit onboarding state machine.
 *
 * Invalid events are ignored and reported through `accepted=false`; the UI
 * therefore cannot reveal a later step by mutating unrelated booleans.
 */
export function transitionFlow(state: FlowState, event: FlowEvent): FlowTransition {
  switch (event.type) {
    case "BOOT": {
      if (!event.accessReady) {
        return {
          state: { phase: "access", resume: event.runnerId ? "chat" : "pairing" },
          accepted: true
        };
      }
      return event.runnerId
        ? { state: { phase: "chat", runnerId: event.runnerId }, accepted: true }
        : { state: { phase: "pairing", method: null }, accepted: true };
    }

    case "ACCESS_READY": {
      if (state.phase !== "access") return { state, accepted: false };
      const runnerId = event.runnerId ?? (state.resume === "chat" ? pairedRunner(state) : null);
      return runnerId
        ? { state: { phase: "chat", runnerId }, accepted: true }
        : { state: { phase: "pairing", method: null }, accepted: true };
    }

    case "ACCESS_EXPIRED": {
      return {
        state: {
          phase: "access",
          resume: state.phase === "chat" || state.phase === "complete" ? "chat" : "pairing"
        },
        accepted: state.phase !== "access"
      };
    }

    case "SELECT_METHOD":
      return state.phase === "pairing"
        ? { state: { phase: "pairing", method: event.method }, accepted: true }
        : { state, accepted: false };

    case "START_VERIFICATION":
      return state.phase === "pairing" && state.method
        ? { state: { phase: "verification", method: state.method }, accepted: true }
        : { state, accepted: false };

    case "VERIFICATION_FAILED":
    case "CANCEL_VERIFICATION":
      return state.phase === "verification"
        ? { state: { phase: "pairing", method: state.method }, accepted: true }
        : { state, accepted: false };

    case "PAIRED":
      return state.phase === "verification" || state.phase === "pairing"
        ? { state: { phase: "complete", runnerId: event.runnerId }, accepted: true }
        : { state, accepted: false };

    case "CONTINUE_TO_CHAT":
      return state.phase === "complete"
        ? { state: { phase: "chat", runnerId: state.runnerId }, accepted: true }
        : { state, accepted: false };

    case "LOGGED_OUT":
      return {
        state: { phase: "access", resume: "pairing" },
        accepted: true
      };
  }
}

export const FLOW_ORDER = ["access", "pairing", "verification", "complete", "chat"] as const;
export type FlowStep = (typeof FLOW_ORDER)[number];

export function visibleFlowSteps(state: FlowState): FlowStep[] {
  const activeIndex = FLOW_ORDER.indexOf(state.phase);
  return FLOW_ORDER.slice(0, activeIndex + 1);
}

export function isFlowStepUnlocked(state: FlowState, step: FlowStep): boolean {
  return visibleFlowSteps(state).includes(step);
}
