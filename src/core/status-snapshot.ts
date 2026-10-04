import type { BgTask } from './common.js';

/**
 * RPC hosts (pi-app) cannot draw the TUI dock, so in `rpc` mode the extension publishes a
 * structured replacement snapshot as the only line of the `background-tasks` widget. Hosts that
 * recognise the prefix render it natively and must never show the line as text.
 */
export const STATUS_SNAPSHOT_WIDGET_PREFIX = 'PI_BG_TASKS_JSON:';
export const STATUS_SNAPSHOT_KIND = 'pi-background-tasks.status-snapshot';
export const STATUS_SNAPSHOT_VERSION = 1;
const MAX_TASKS = 12;
const MAX_TEXT = 240;

export type StatusSnapshotTaskKind = 'shell' | 'agent' | 'attested' | 'delegate' | 'fusion';

export interface StatusSnapshotTask {
  id: string;
  name: string;
  kind: StatusSnapshotTaskKind;
  status: BgTask['status'];
  command: string;
  description?: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  bytes: number;
  model?: string;
  tokens?: number;
  cost?: number;
  tools?: number;
  toolsFailed?: number;
  contextPercent?: number;
  phase?: string;
  timeoutSeconds?: number;
}

export interface StatusSnapshot {
  kind: typeof STATUS_SNAPSHOT_KIND;
  version: typeof STATUS_SNAPSHOT_VERSION;
  omitted: number;
  tasks: StatusSnapshotTask[];
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT - 1)}…` : line;
}

function taskKind(task: BgTask): StatusSnapshotTaskKind {
  if (task.fusion) return 'fusion';
  if (task.delegate) return 'delegate';
  if (task.attestedPi ?? task.attestationPath) return 'attested';
  return task.isAgent ? 'agent' : 'shell';
}

function projectTask(task: BgTask): StatusSnapshotTask {
  const projected: StatusSnapshotTask = {
    id: task.id,
    name: clip(task.name),
    kind: taskKind(task),
    status: task.status,
    command: clip(task.command),
    startedAt: task.startTime,
    bytes: task.bytesWritten,
  };
  if (task.description) projected.description = clip(task.description);
  if (task.endTime !== undefined) projected.endedAt = task.endTime;
  if (task.exitCode !== undefined) projected.exitCode = task.exitCode;
  if (task.signal !== undefined) projected.signal = task.signal;
  if (task.error) projected.error = clip(task.error);
  const model = task.model ?? task.delegate?.route.qualifiedId;
  if (model) projected.model = model;
  if (task.tokenUsage) {
    projected.tokens = task.tokenUsage.totalTokens;
    if (task.tokenUsage.costTotal !== undefined) projected.cost = task.tokenUsage.costTotal;
  }
  if (task.toolUsage) {
    projected.tools = task.toolUsage.total;
    if (task.toolUsage.failed > 0) projected.toolsFailed = task.toolUsage.failed;
  }
  if (task.contextUsage?.percent != null) projected.contextPercent = task.contextUsage.percent;
  if (task.fusion) projected.phase = `${task.fusion.workflow} · ${task.fusion.state}`;
  if (task.timeoutSeconds !== undefined) projected.timeoutSeconds = task.timeoutSeconds;
  return projected;
}

/** Running tasks first (oldest first), then unseen finished tasks (newest first). */
export function buildStatusSnapshot(tasks: readonly BgTask[], seen: ReadonlySet<string>): StatusSnapshot | undefined {
  const running = tasks.filter((task) => task.status === 'running').sort((a, b) => a.startTime - b.startTime);
  const finished = tasks
    .filter((task) => task.status !== 'running' && !seen.has(task.id))
    .sort((a, b) => (b.endTime ?? b.startTime) - (a.endTime ?? a.startTime));
  const visible = [...running, ...finished];
  if (visible.length === 0) return undefined;
  return {
    kind: STATUS_SNAPSHOT_KIND,
    version: STATUS_SNAPSHOT_VERSION,
    omitted: Math.max(0, visible.length - MAX_TASKS),
    tasks: visible.slice(0, MAX_TASKS).map(projectTask),
  };
}

export function encodeStatusSnapshotWidget(snapshot: StatusSnapshot): string[] {
  return [`${STATUS_SNAPSHOT_WIDGET_PREFIX}${JSON.stringify(snapshot)}`];
}
