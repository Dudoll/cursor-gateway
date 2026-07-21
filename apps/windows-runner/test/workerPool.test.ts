import assert from "node:assert/strict";
import test from "node:test";
import { SinglePermit, workerQueueOrder } from "../src/workerPool.js";

test("all six shared slots can borrow the legacy queue", () => {
  const orders = Array.from({ length: 6 }, (_, index) =>
    workerQueueOrder({
      workerId: index + 1,
      iteration: 0,
      e2eeEnabled: true,
      legacyEnabled: true
    })
  );
  assert.equal(orders.length, 6);
  assert.ok(orders.every((order) => order.includes("legacy")));
  assert.ok(orders.every((order) => order.includes("e2ee")));
});

test("queue preference alternates to avoid starvation", () => {
  const first = workerQueueOrder({
    workerId: 1,
    iteration: 0,
    e2eeEnabled: true,
    legacyEnabled: true
  });
  const second = workerQueueOrder({
    workerId: 1,
    iteration: 1,
    e2eeEnabled: true,
    legacyEnabled: true
  });
  assert.notEqual(first[0], second[0]);
  assert.deepEqual(new Set(first), new Set(["e2ee", "legacy"]));
  assert.deepEqual(new Set(second), new Set(["e2ee", "legacy"]));
});

test("single enabled queue does not make a redundant claim", () => {
  assert.deepEqual(
    workerQueueOrder({
      workerId: 1,
      iteration: 0,
      e2eeEnabled: false,
      legacyEnabled: true
    }),
    ["legacy"]
  );
  assert.deepEqual(
    workerQueueOrder({
      workerId: 1,
      iteration: 0,
      e2eeEnabled: true,
      legacyEnabled: false
    }),
    ["e2ee"]
  );
});

test("encrypted queue keeps its original single-job safety bound", () => {
  const permit = new SinglePermit();
  const release = permit.tryAcquire();
  assert.ok(release);
  assert.equal(permit.tryAcquire(), undefined);
  release();
  const releaseAgain = permit.tryAcquire();
  assert.ok(releaseAgain);
  releaseAgain();
});
