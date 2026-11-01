import type {
  CompletionNotificationMessage,
  CompletionNotificationOptions,
} from "./registry.js";

/**
 * A queued per-task completion notification plus the delivery options the
 * registry chose for it.
 */
export interface QueuedCompletionNotification {
  message: CompletionNotificationMessage;
  options: CompletionNotificationOptions;
}

/** Batched notification payload: one message covering several terminal tasks. */
export interface BatchedCompletionNotificationMessage {
  customType: "background-task-notification";
  content: string;
  display: true;
  details: unknown[];
}

export type CompletionNotificationSink = (
  message: CompletionNotificationMessage | BatchedCompletionNotificationMessage,
  options: CompletionNotificationOptions,
) => void;

const NOTIFICATION_BLOCK =
  /^<background-task-notification>\n?([\s\S]*?)\n?<\/background-task-notification>$/;

/** Extract the per-task field lines from one single-task notification block. */
export function taskBlockInner(content: string): string {
  const match = NOTIFICATION_BLOCK.exec(content.trim());
  return match?.[1] ?? content.trim();
}

/** Merge several single-task notification blocks into one batched message. */
export function mergeNotifications(
  entries: QueuedCompletionNotification[],
): BatchedCompletionNotificationMessage {
  const tasks = entries.map((entry) => entry.message.details);
  const blocks = entries.map((entry) => {
    const inner = taskBlockInner(entry.message.content)
      .split("\n")
      .map((line) => (line.length === 0 ? line : `  ${line}`))
      .join("\n");
    return `  <task>\n${inner}\n  </task>`;
  });
  return {
    customType: "background-task-notification",
    content:
      `<background-task-notification count="${entries.length}">\n` +
      `${blocks.join("\n")}\n` +
      `</background-task-notification>`,
    display: true,
    details: tasks,
  };
}

/**
 * Coalesces completion notifications.
 *
 * While the agent is idle, pushes flush on the next event-loop tick so
 * same-tick terminal tasks still share one message. While the agent is busy,
 * pushes stay parked — without any artificial delay — and flush at the next
 * turn boundary (turn_end / agent_end / agent_settled), so everything that
 * finished during one assistant turn arrives as a single message.
 */
export class CompletionNotificationCoalescer {
  private queue: QueuedCompletionNotification[] = [];
  private idleFlushScheduled = false;

  constructor(
    private readonly send: CompletionNotificationSink,
    private readonly isAgentBusy: () => boolean,
    private readonly scheduleIdleFlush: (flush: () => void) => void,
    private readonly logger: Pick<Console, "error"> = console,
  ) {}

  /** Registry-facing sender replacement. Never throws; failures requeue. */
  push(message: CompletionNotificationMessage, options: CompletionNotificationOptions): void {
    this.queue.push({ message, options });
    if (!this.isAgentBusy()) this.scheduleIdleFlushOnce();
  }

  /** Number of terminal tasks waiting for the next delivery point. */
  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Deliver everything queued so far: one message per flush. A single entry
   * keeps the exact legacy per-task message; multiple entries are merged.
   * A failed send requeues the batch for the next flush.
   */
  flush(): void {
    if (this.queue.length === 0) return;
    const entries = this.queue;
    this.queue = [];
    try {
      const single = entries.length === 1 ? entries[0] : undefined;
      if (single) {
        this.send(single.message, single.options);
        return;
      }
      this.send(
        mergeNotifications(entries),
        mergeOptions(entries),
      );
    } catch (error) {
      this.queue = entries.concat(this.queue);
      this.logger.error(
        "[background-tasks] batched completion notification send failed; requeued for next delivery point:",
        error,
      );
    }
  }

  /** Final synchronous delivery attempt (session shutdown / reload). */
  dispose(): void {
    this.flush();
  }

  private scheduleIdleFlushOnce(): void {
    if (this.idleFlushScheduled) return;
    this.idleFlushScheduled = true;
    this.scheduleIdleFlush(() => {
      this.idleFlushScheduled = false;
      this.flush();
    });
  }
}

function mergeOptions(entries: QueuedCompletionNotification[]): CompletionNotificationOptions {
  return {
    deliverAs: "steer",
    triggerTurn: entries.some((entry) => entry.options.triggerTurn),
  };
}
