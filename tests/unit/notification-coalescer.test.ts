import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CompletionNotificationCoalescer,
  mergeNotifications,
  taskBlockInner,
  type QueuedCompletionNotification,
} from "../../src/core/notification-coalescer.js";
import type {
  CompletionNotificationMessage,
  CompletionNotificationOptions,
} from "../../src/core/registry.js";

interface Harness {
  sent: Array<{ message: unknown; options: CompletionNotificationOptions }>;
  scheduled: Array<() => void>;
  busy: boolean;
  coalescer: CompletionNotificationCoalescer;
  errors: unknown[];
}

function createHarness(busy = false): Harness {
  const harness: Harness = {
    sent: [],
    scheduled: [],
    busy,
    errors: [],
    coalescer: undefined as unknown as CompletionNotificationCoalescer,
  };
  harness.coalescer = new CompletionNotificationCoalescer(
    (message, options) => {
      harness.sent.push({ message, options });
    },
    () => harness.busy,
    (flush) => {
      harness.scheduled.push(flush);
    },
    { error: (...args: unknown[]) => harness.errors.push(args) },
  );
  return harness;
}

let counter = 0;
function taskNotification(
  overrides: Partial<CompletionNotificationMessage["details"]> & { status?: string; exitCode?: number } = {},
): CompletionNotificationMessage {
  const id = `t${++counter}`;
  const status = overrides.status ?? "completed";
  const exitCode = overrides.exitCode ?? 0;
  return {
    customType: "background-task-notification",
    content: [
      "<background-task-notification>",
      `  <task-id>${id}</task-id>`,
      `  <task-name>task ${id}</task-name>`,
      `  <status>${status}</status>`,
      `  <exit-code>${exitCode}</exit-code>`,
      `  <output-file>.pi/tasks/${id}.output</output-file>`,
      `  <summary>Background task "task ${id}" ${status}</summary>`,
      "  <guidance>do not poll</guidance>",
      "</background-task-notification>",
    ].join("\n"),
    display: true,
    details: {
      id,
      name: `task ${id}`,
      status,
      exitCode,
      outputPath: `.pi/tasks/${id}.output`,
      ...overrides,
    } as CompletionNotificationMessage["details"],
  };
}

const steerOptions: CompletionNotificationOptions = {
  deliverAs: "steer",
  triggerTurn: true,
};

function drain(harness: Harness): void {
  const pending = harness.scheduled.splice(0);
  for (const flush of pending) flush();
}

test("single idle notification passes through unchanged on the next tick", () => {
  const harness = createHarness(/* busy */ false);
  const message = taskNotification();

  harness.coalescer.push(message, steerOptions);
  assert.equal(harness.sent.length, 0, "must wait for the scheduled tick");
  drain(harness);

  assert.equal(harness.sent.length, 1);
  const passthrough = harness.sent[0];
  assert.ok(passthrough);
  assert.deepEqual(passthrough.message, message);
  assert.deepEqual(passthrough.options, steerOptions);
  assert.equal(harness.coalescer.pendingCount, 0);
});

test("idle completions in the same tick merge into one message", () => {
  const harness = createHarness(/* busy */ false);
  const first = taskNotification();
  const second = taskNotification({ status: "failed", exitCode: 1 });

  harness.coalescer.push(first, steerOptions);
  harness.coalescer.push(second, steerOptions);
  assert.equal(harness.scheduled.length, 1, "one idle flush is scheduled once");
  drain(harness);

  assert.equal(harness.sent.length, 1);
  const merged = harness.sent[0];
  assert.ok(merged);
  const batch = merged.message as ReturnType<typeof mergeNotifications>;
  assert.equal(batch.details.length, 2);
  assert.deepEqual(batch.details, [first.details, second.details]);
  assert.match(batch.content, /<background-task-notification count="2">/);
  assert.match(batch.content, /<task-id>t\d+<\/task-id>/);
  assert.match(batch.content, /<status>failed<\/status>/);
  assert.deepEqual(merged.options, steerOptions);
});

test("busy completions park without delay and flush together at the boundary", () => {
  const harness = createHarness(/* busy */ true);
  harness.coalescer.push(taskNotification(), steerOptions);
  harness.coalescer.push(taskNotification(), steerOptions);

  assert.equal(harness.scheduled.length, 0, "no idle timer while busy");
  assert.equal(harness.sent.length, 0, "parked, not delivered");
  assert.equal(harness.coalescer.pendingCount, 2);

  harness.coalescer.flush(); // turn_end

  assert.equal(harness.sent.length, 1);
  const boundary = harness.sent[0];
  assert.ok(boundary);
  const batch = boundary.message as ReturnType<typeof mergeNotifications>;
  assert.equal(batch.details.length, 2);
  assert.equal(harness.coalescer.pendingCount, 0);
});

test("busy then idle transition delivers on the next tick", () => {
  const harness = createHarness(/* busy */ true);
  harness.coalescer.push(taskNotification(), steerOptions);
  harness.coalescer.flush();
  assert.equal(harness.sent.length, 1, "boundary flush delivered the batch");

  harness.busy = false;
  harness.coalescer.push(taskNotification(), steerOptions);
  assert.equal(harness.scheduled.length, 1, "idle push schedules a tick flush");
  drain(harness);
  assert.equal(harness.sent.length, 2);
});

test("failed send requeues the batch for the next delivery point", () => {
  const harness = createHarness(/* busy */ true);
  let shouldThrow = true;
  const failing = new CompletionNotificationCoalescer(
    () => {
      if (shouldThrow) throw new Error("send failed");
      harness.sent.push({ message: null, options: steerOptions });
    },
    () => harness.busy,
    (flush) => harness.scheduled.push(flush),
  );

  failing.push(taskNotification(), steerOptions);
  failing.push(taskNotification(), steerOptions);
  failing.flush();
  assert.equal(harness.sent.length, 0, "send threw");
  assert.equal(failing.pendingCount, 2, "batch requeued");

  shouldThrow = false;
  failing.flush();
  assert.equal(harness.sent.length, 1, "retried as one merged message");
});

test("dispose flushes parked notifications", () => {
  const harness = createHarness(/* busy */ true);
  harness.coalescer.push(taskNotification(), steerOptions);
  harness.coalescer.dispose();
  assert.equal(harness.sent.length, 1);
});

test("mergeNotifications indents per-task fields and preserves them", () => {
  const entries: QueuedCompletionNotification[] = [
    { message: taskNotification(), options: steerOptions },
    { message: taskNotification(), options: steerOptions },
  ];
  const merged = mergeNotifications(entries);
  assert.match(merged.content, /^<background-task-notification count="2">\n/);
  assert.match(merged.content, /\n<\/background-task-notification>$/);
  const taskBlocks = merged.content.match(/  <task>\n[\s\S]*?\n  <\/task>/g);
  assert.ok(taskBlocks);
  assert.equal(taskBlocks.length, 2);
  for (const block of taskBlocks) {
    assert.match(block, /    <task-id>t\d+<\/task-id>/);
    assert.match(block, /    <guidance>do not poll<\/guidance>/);
  }
});

test("taskBlockInner accepts plain content without the wrapper", () => {
  assert.equal(taskBlockInner("  <task-id>x</task-id>  "), "<task-id>x</task-id>");
});
