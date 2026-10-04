import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BgTask } from '../../src/core/common.js';
import {
  STATUS_SNAPSHOT_WIDGET_PREFIX,
  buildStatusSnapshot,
  encodeStatusSnapshotWidget,
} from '../../src/core/status-snapshot.js';

function task(overrides: Partial<BgTask>): BgTask {
  return {
    id: 't',
    name: 'task',
    command: 'echo hi',
    status: 'running',
    outputPath: '.pi/tasks/t.log',
    cwd: '/tmp',
    startTime: 1000,
    bytesWritten: 0,
    isAgent: false,
    surviveReload: false,
    notified: false,
    notifyOnCompletion: true,
    triggerOnCompletion: true,
    outputAbsPath: '/tmp/.pi/tasks/t.log',
    metadataAbsPath: '/tmp/.pi/tasks/t.json',
    terminalPublished: false,
    terminalPublicationState: 'pending',
    terminalPublishAttempts: 0,
    ...overrides,
  } as BgTask;
}

describe('status snapshot', () => {
  it('is absent when nothing is running or unseen', () => {
    const done = task({ id: 'a', status: 'completed', endTime: 2000 });
    assert.equal(buildStatusSnapshot([done], new Set(['a'])), undefined);
  });

  it('lists running oldest-first, then unseen finished newest-first, with agent facts', () => {
    const snapshot = buildStatusSnapshot(
      [
        task({ id: 'late', startTime: 3000 }),
        task({ id: 'early', startTime: 1000, isAgent: true, model: 'openai/gpt',
          tokenUsage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 1234, costTotal: 0.5 },
          toolUsage: { total: 7, failed: 1, byName: {} },
          contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } }),
        task({ id: 'old-fail', status: 'failed', endTime: 2000, exitCode: 2 }),
        task({ id: 'new-done', status: 'completed', endTime: 5000, exitCode: 0 }),
        task({ id: 'seen', status: 'completed', endTime: 6000 }),
      ],
      new Set(['seen']),
    );
    assert.ok(snapshot);
    assert.deepEqual(snapshot.tasks.map((t) => t.id), ['early', 'late', 'new-done', 'old-fail']);
    const agent = snapshot.tasks[0];
    assert.equal(agent?.kind, 'agent');
    assert.equal(agent?.tokens, 1234);
    assert.equal(agent?.cost, 0.5);
    assert.equal(agent?.tools, 7);
    assert.equal(agent?.toolsFailed, 1);
    assert.equal(agent?.contextPercent, 10);
    assert.equal(snapshot.tasks[3]?.exitCode, 2);
  });

  it('caps the list and encodes one prefixed line', () => {
    const tasks = Array.from({ length: 15 }, (_, i) => task({ id: `t${String(i)}`, startTime: i,
      command: `x${'y'.repeat(400)}\nnext` }));
    const snapshot = buildStatusSnapshot(tasks, new Set());
    assert.ok(snapshot);
    assert.equal(snapshot.tasks.length, 12);
    assert.equal(snapshot.omitted, 3);
    assert.ok((snapshot.tasks[0]?.command.length ?? 0) <= 240);
    const [line, ...rest] = encodeStatusSnapshotWidget(snapshot);
    assert.equal(rest.length, 0);
    assert.ok(line?.startsWith(STATUS_SNAPSHOT_WIDGET_PREFIX));
    if (line === undefined) return;
    assert.equal(JSON.parse(line.slice(STATUS_SNAPSHOT_WIDGET_PREFIX.length)).version, 1);
  });
});
