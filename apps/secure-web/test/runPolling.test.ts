import assert from "node:assert/strict";
import test from "node:test";
import {
  createRunPollingLoop,
  type RunStatus
} from "@cursor-gateway/shared";

type ScheduledTask = {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
};

function fakeScheduler() {
  const tasks: ScheduledTask[] = [];
  return {
    tasks,
    schedule(callback: () => void, delayMs: number) {
      const task = { callback, delayMs, cancelled: false };
      tasks.push(task);
      return task;
    },
    cancel(handle: unknown) {
      (handle as ScheduledTask).cancelled = true;
    },
    runNext() {
      const task = tasks.shift();
      assert.ok(task, "expected a scheduled poll");
      if (!task.cancelled) task.callback();
    },
    pending() {
      return tasks.filter((task) => !task.cancelled);
    }
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("an existing running run refreshes to finished without another user input", async () => {
  const scheduler = fakeScheduler();
  const snapshots: Array<{ status: RunStatus; answer: string | null }> = [
    { status: "running", answer: null },
    { status: "finished", answer: "completed response" }
  ];
  const rendered: Array<{ status: RunStatus; answer: string | null }> = [];
  let loads = 0;
  const poller = createRunPollingLoop({
    load: async () => snapshots[loads++]!,
    apply: (snapshot) => rendered.push(snapshot),
    statuses: (snapshot) => [snapshot.status],
    schedule: scheduler.schedule,
    cancel: scheduler.cancel
  });

  poller.start();
  await flushMicrotasks();
  assert.equal(loads, 1);
  assert.deepEqual(rendered, [{ status: "running", answer: null }]);
  assert.equal(scheduler.pending()[0]?.delayMs, 2_000);

  // Time advances, but there is deliberately no second submit/user event.
  scheduler.runNext();
  await flushMicrotasks();

  assert.equal(loads, 2);
  assert.deepEqual(rendered.at(-1), {
    status: "finished",
    answer: "completed response"
  });
  assert.equal(poller.isActive(), false);
  assert.equal(scheduler.pending().length, 0);
});

test("wake never overlaps an in-flight request", async () => {
  const scheduler = fakeScheduler();
  let resolveFirst!: (value: { status: RunStatus }) => void;
  let loads = 0;
  const first = new Promise<{ status: RunStatus }>((resolve) => {
    resolveFirst = resolve;
  });
  const poller = createRunPollingLoop({
    load: async () => {
      loads += 1;
      return loads === 1 ? first : { status: "finished" };
    },
    apply: () => undefined,
    statuses: (snapshot) => [snapshot.status],
    schedule: scheduler.schedule,
    cancel: scheduler.cancel
  });

  poller.start();
  poller.wake();
  poller.wake();
  assert.equal(loads, 1);

  resolveFirst({ status: "running" });
  await flushMicrotasks();
  assert.equal(loads, 1);
  assert.equal(scheduler.pending().length, 1);

  scheduler.runNext();
  await flushMicrotasks();
  assert.equal(loads, 2);
  assert.equal(poller.isActive(), false);
  assert.equal(scheduler.pending().length, 0);
});

test("stop suppresses a late result after unmount", async () => {
  const scheduler = fakeScheduler();
  let resolveLoad!: (value: { status: RunStatus }) => void;
  const load = new Promise<{ status: RunStatus }>((resolve) => {
    resolveLoad = resolve;
  });
  const rendered: RunStatus[] = [];
  const poller = createRunPollingLoop({
    load: () => load,
    apply: (snapshot) => rendered.push(snapshot.status),
    statuses: (snapshot) => [snapshot.status],
    schedule: scheduler.schedule,
    cancel: scheduler.cancel
  });

  poller.start();
  poller.stop();
  resolveLoad({ status: "finished" });
  await flushMicrotasks();

  assert.deepEqual(rendered, []);
  assert.equal(scheduler.pending().length, 0);
});

test("an active run backs off polling while the client is hidden", async () => {
  const scheduler = fakeScheduler();
  const poller = createRunPollingLoop({
    load: async () => ({ status: "waiting_approval" as RunStatus }),
    apply: () => undefined,
    statuses: (snapshot) => [snapshot.status],
    isBackground: () => true,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel
  });

  poller.start();
  await flushMicrotasks();

  assert.equal(scheduler.pending()[0]?.delayMs, 15_000);
  poller.stop();
  assert.equal(scheduler.pending().length, 0);
});
