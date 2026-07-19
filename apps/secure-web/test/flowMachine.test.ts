import assert from "node:assert/strict";
import test from "node:test";
import {
  FLOW_ORDER,
  initialFlowState,
  transitionFlow,
  visibleFlowSteps,
  type FlowEvent,
  type FlowState
} from "../src/flowMachine.js";

test("first-install flow advances in one direction", () => {
  let state: FlowState = initialFlowState;
  state = transitionFlow(state, {
    type: "BOOT",
    accessReady: false
  }).state;
  assert.equal(state.phase, "access");

  state = transitionFlow(state, { type: "ACCESS_READY" }).state;
  assert.equal(state.phase, "pairing");

  state = transitionFlow(state, {
    type: "SELECT_METHOD",
    method: "passkey"
  }).state;
  state = transitionFlow(state, { type: "START_VERIFICATION" }).state;
  assert.deepEqual(state, { phase: "verification", method: "passkey" });

  state = transitionFlow(state, {
    type: "PAIRED",
    runnerId: "runner-a"
  }).state;
  assert.deepEqual(state, { phase: "complete", runnerId: "runner-a" });

  state = transitionFlow(state, { type: "CONTINUE_TO_CHAT" }).state;
  assert.deepEqual(state, { phase: "chat", runnerId: "runner-a" });
});

test("later steps cannot be opened before prerequisites", () => {
  const illegal: FlowEvent[] = [
    { type: "SELECT_METHOD", method: "passkey" },
    { type: "START_VERIFICATION" },
    { type: "PAIRED", runnerId: "runner-a" },
    { type: "CONTINUE_TO_CHAT" }
  ];
  for (const event of illegal) {
    const result = transitionFlow(initialFlowState, event);
    assert.equal(result.accepted, false, event.type);
    assert.deepEqual(result.state, initialFlowState);
  }
});

test("failure, cancellation, Access expiry, and existing authorization preserve order", () => {
  const pairing: FlowState = { phase: "pairing", method: "approval" };
  const verifying = transitionFlow(pairing, { type: "START_VERIFICATION" }).state;

  assert.deepEqual(transitionFlow(verifying, { type: "VERIFICATION_FAILED" }).state, pairing);
  assert.deepEqual(transitionFlow(verifying, { type: "CANCEL_VERIFICATION" }).state, pairing);

  const expired = transitionFlow(
    { phase: "chat", runnerId: "runner-a" },
    { type: "ACCESS_EXPIRED" }
  ).state;
  assert.deepEqual(expired, { phase: "access", resume: "chat" });
  assert.deepEqual(
    transitionFlow(expired, {
      type: "ACCESS_READY",
      runnerId: "runner-a"
    }).state,
    { phase: "chat", runnerId: "runner-a" }
  );

  assert.deepEqual(
    transitionFlow(initialFlowState, {
      type: "BOOT",
      accessReady: true,
      runnerId: "runner-a"
    }).state,
    { phase: "chat", runnerId: "runner-a" }
  );
});

test("visible steps are always a DOM-order prefix", () => {
  const states: FlowState[] = [
    { phase: "access", resume: "pairing" },
    { phase: "pairing", method: null },
    { phase: "verification", method: "passkey" },
    { phase: "complete", runnerId: "runner-a" },
    { phase: "chat", runnerId: "runner-a" }
  ];
  for (const state of states) {
    const visible = visibleFlowSteps(state);
    assert.deepEqual(visible, FLOW_ORDER.slice(0, visible.length));
    assert.equal(visible.at(-1), state.phase);
  }
});

test("transition acceptance matrix rejects phase-incompatible events", () => {
  const states: FlowState[] = [
    { phase: "access", resume: "pairing" },
    { phase: "pairing", method: null },
    { phase: "pairing", method: "recovery" },
    { phase: "verification", method: "recovery" },
    { phase: "complete", runnerId: "r" },
    { phase: "chat", runnerId: "r" }
  ];
  const phaseOnlyEvents: FlowEvent[] = [
    { type: "ACCESS_READY" },
    { type: "SELECT_METHOD", method: "passkey" },
    { type: "START_VERIFICATION" },
    { type: "VERIFICATION_FAILED" },
    { type: "CANCEL_VERIFICATION" },
    { type: "PAIRED", runnerId: "r" },
    { type: "CONTINUE_TO_CHAT" }
  ];
  const allowed = new Set([
    "access:ACCESS_READY",
    "pairing:SELECT_METHOD",
    "pairing:START_VERIFICATION",
    "pairing:PAIRED",
    "verification:VERIFICATION_FAILED",
    "verification:CANCEL_VERIFICATION",
    "verification:PAIRED",
    "complete:CONTINUE_TO_CHAT"
  ]);
  for (const state of states) {
    for (const event of phaseOnlyEvents) {
      const expected = allowed.has(`${state.phase}:${event.type}`) &&
        !(event.type === "START_VERIFICATION" && state.phase === "pairing" && !state.method);
      assert.equal(
        transitionFlow(state, event).accepted,
        expected,
        `${state.phase}:${event.type}`
      );
    }
  }
});
