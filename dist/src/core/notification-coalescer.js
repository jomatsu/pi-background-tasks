const NOTIFICATION_BLOCK = /^<background-task-notification>\n?([\s\S]*?)\n?<\/background-task-notification>$/;
/** Extract the per-task field lines from one single-task notification block. */
export function taskBlockInner(content) {
    const match = NOTIFICATION_BLOCK.exec(content.trim());
    return match?.[1] ?? content.trim();
}
/** Merge several single-task notification blocks into one batched message. */
export function mergeNotifications(entries) {
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
        content: `<background-task-notification count="${entries.length}">\n` +
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
    send;
    isAgentBusy;
    scheduleIdleFlush;
    logger;
    queue = [];
    idleFlushScheduled = false;
    constructor(send, isAgentBusy, scheduleIdleFlush, logger = console) {
        this.send = send;
        this.isAgentBusy = isAgentBusy;
        this.scheduleIdleFlush = scheduleIdleFlush;
        this.logger = logger;
    }
    /** Registry-facing sender replacement. Never throws; failures requeue. */
    push(message, options) {
        this.queue.push({ message, options });
        if (!this.isAgentBusy())
            this.scheduleIdleFlushOnce();
    }
    /** Number of terminal tasks waiting for the next delivery point. */
    get pendingCount() {
        return this.queue.length;
    }
    /**
     * Deliver everything queued so far: one message per flush. A single entry
     * keeps the exact legacy per-task message; multiple entries are merged.
     * A failed send requeues the batch for the next flush.
     */
    flush() {
        if (this.queue.length === 0)
            return;
        const entries = this.queue;
        this.queue = [];
        try {
            const single = entries.length === 1 ? entries[0] : undefined;
            if (single) {
                this.send(single.message, single.options);
                return;
            }
            this.send(mergeNotifications(entries), mergeOptions(entries));
        }
        catch (error) {
            this.queue = entries.concat(this.queue);
            this.logger.error("[background-tasks] batched completion notification send failed; requeued for next delivery point:", error);
        }
    }
    /** Final synchronous delivery attempt (session shutdown / reload). */
    dispose() {
        this.flush();
    }
    scheduleIdleFlushOnce() {
        if (this.idleFlushScheduled)
            return;
        this.idleFlushScheduled = true;
        this.scheduleIdleFlush(() => {
            this.idleFlushScheduled = false;
            this.flush();
        });
    }
}
function mergeOptions(entries) {
    return {
        deliverAs: "steer",
        triggerTurn: entries.some((entry) => entry.options.triggerTurn),
    };
}
//# sourceMappingURL=notification-coalescer.js.map