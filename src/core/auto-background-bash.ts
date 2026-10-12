import { randomBytes } from "node:crypto";
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  fstatSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

// Public surface of the replacement bash tool. Kept as literals (the docs gate reads them); the
// built-in wording is preserved and the auto-background behavior is appended.
export const BASH_TOOL_LABEL = "bash";
export const BASH_TOOL_PROMPT_SNIPPET =
  "Execute bash commands (ls, grep, find, etc.)";
export const BASH_TOOL_DESCRIPTION =
  "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. In interactive sessions a command still running after the auto-background window (PI_BG_BASH_AUTO_BACKGROUND_SECONDS, default 60; 0 or off disables) keeps running as a background task and the call returns; a <background-task-notification> wakes you when it finishes.";
export const BASH_TOOL_PROMPT_GUIDELINES = [
  "Inspect PI_* environment variables for current model and session details.",
  "bash moves a command that is still running after the auto-background window to a background task and returns; the same process keeps running and its completion arrives as <background-task-notification>. Continue only with independent work or end the turn; never sleep, poll, or rerun it.",
];
export const BashToolParams = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, no default timeout)",
    }),
  ),
});
import type {
  BashOperations,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * Foreground bash that never holds the turn for long.
 *
 * Every command still runs through Pi's own bash tool definition (same shell, output truncation,
 * full-output temp file, timeout and rendering). The only change: if the command is still
 * running when the foreground window elapses, or the user steers while it runs, the same live
 * process is handed to the background task registry and the tool returns at once. The process
 * is not killed or restarted, so partial side effects are never repeated. Completion is
 * delivered later through the registry's normal <background-task-notification>.
 */

export type BackgroundReason = "timeout" | "steer";

/** A running foreground command that can be asked to move to the background. */
export interface ForegroundSlot {
  requestBackground(reason: BackgroundReason): void;
}

/** The set of foreground commands currently holding a turn. */
export class ForegroundCommands {
  private readonly slots = new Set<ForegroundSlot>();

  add(slot: ForegroundSlot): void {
    this.slots.add(slot);
  }

  delete(slot: ForegroundSlot): void {
    this.slots.delete(slot);
  }

  get size(): number {
    return this.slots.size;
  }

  /** Move every running foreground command to the background. */
  backgroundAll(reason: BackgroundReason): void {
    for (const slot of [...this.slots]) slot.requestBackground(reason);
  }
}

/** Where an adopted command's output goes and how it is presented. */
export interface AdoptedCommand {
  id: string;
  displayName: string;
  outputPath: string;
  write(data: Buffer): void;
}

export interface AdoptRequest {
  command: string;
  /** Settles when the command ends; rejects with a short reason on failure, abort or timeout. */
  completion: Promise<void>;
  /** Abort the live command (used by bg_kill and shutdown). */
  cancel: () => void;
}

// Loose structural types: the tool context and update payloads are passed through untouched.
type BashParams = { command: string; timeout?: number | undefined };
type BashDefinition = ToolDefinition<any, any, any>;
/** The replacement bash tool: Pi's definition with its renderers always present. */
export type AutoBackgroundBashDefinition = ToolDefinition<
  typeof BashToolParams,
  any,
  any
> &
  Required<
    Pick<
      ToolDefinition<typeof BashToolParams, any, any>,
      "renderCall" | "renderResult"
    >
  >;
type ToolContext = Parameters<BashDefinition["execute"]>[4];

export interface AutoBackgroundBashOptions {
  /** Build Pi's bash tool definition for a cwd with the given operations. */
  createDefinition(cwd: string, operations: BashOperations): BashDefinition;
  /** Pi's local shell operations (the ones the built-in bash tool uses). */
  createLocalOperations(): BashOperations;
  /** Foreground window before a running command moves to the background. */
  windowMs: number;
  /** Whether this context gets auto-backgrounding (interactive parents only). */
  isEligible(ctx: ToolContext): boolean;
  /** Register the live command as a background task. */
  adopt(ctx: ToolContext, request: AdoptRequest): Promise<AdoptedCommand>;
  foreground: ForegroundCommands;
  /** Characters of output shown in the hand-off result. */
  previewChars?: number;
  tempDir?: string;
}

const DEFAULT_PREVIEW_CHARS = 4_000;

export const PI_BG_DEFAULT_BASH_AUTO_BACKGROUND_SECONDS = 60;

/**
 * Foreground window from `PI_BG_BASH_AUTO_BACKGROUND_SECONDS` (whole seconds; `0` or `off`
 * disables the bash override). Defaults to 60 seconds.
 */
export function parseBashAutoBackgroundMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env["PI_BG_BASH_AUTO_BACKGROUND_SECONDS"];
  if (raw === undefined)
    return PI_BG_DEFAULT_BASH_AUTO_BACKGROUND_SECONDS * 1000;
  if (raw === "off") return 0;
  if (!/^\d{1,5}$/u.test(raw)) {
    throw new Error(
      `pi_bg_config_invalid: PI_BG_BASH_AUTO_BACKGROUND_SECONDS must be a whole number of seconds (0 or off disables); received ${JSON.stringify(raw.slice(0, 96))}`,
    );
  }
  return Number(raw) * 1000;
}

/** Pull the terminal reason out of a bash tool error without echoing all of its output. */
export function summarizeBashFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message.trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim() ?? "";
    if (/^Command (exited with code|timed out|aborted)/u.test(line))
      return line;
  }
  const last = lines[lines.length - 1]?.trim() ?? "";
  return last.length > 0 ? last.slice(0, 300) : "Command failed";
}

/**
 * Spools output to a temp file while the command is in the foreground, then forwards
 * everything (spooled and later) to the adopted task once it moves to the background.
 */
export class OutputSpool {
  private fd: number | undefined;
  private path: string | undefined;
  private target: ((data: Buffer) => void) | undefined;
  private disposed = false;

  constructor(private readonly dir: string = tmpdir()) {}

  write(data: Buffer): void {
    if (this.disposed || data.length === 0) return;
    if (this.target !== undefined) {
      this.target(data);
      return;
    }
    if (this.fd === undefined) {
      this.path = join(
        this.dir,
        `pi-bg-bash-${randomBytes(6).toString("hex")}.out`,
      );
      this.fd = openSync(this.path, "a", 0o600);
    }
    writeSync(this.fd, data);
  }

  /** Last `maxChars` characters seen so far. */
  tail(maxChars: number): string {
    if (this.fd === undefined) return "";
    const size = fstatSync(this.fd).size;
    const bytes = Math.min(size, maxChars * 4);
    const buffer = Buffer.alloc(bytes);
    const fd = openSync(this.path as string, "r");
    try {
      readSync(fd, buffer, 0, bytes, size - bytes);
    } finally {
      closeSync(fd);
    }
    const text = buffer.toString("utf8");
    return text.length > maxChars ? text.slice(text.length - maxChars) : text;
  }

  /** Send spooled output to `target` and route all later output there. Synchronous by design. */
  redirect(target: (data: Buffer) => void): void {
    if (this.disposed) return;
    if (this.fd !== undefined && this.path !== undefined) {
      const spooled = readFileSync(this.path);
      if (spooled.length > 0) target(spooled);
    }
    this.target = target;
    this.releaseFile();
  }

  dispose(): void {
    this.disposed = true;
    this.releaseFile();
  }

  private releaseFile(): void {
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        // already closed
      }
      this.fd = undefined;
    }
    if (this.path !== undefined) {
      try {
        unlinkSync(this.path);
      } catch {
        // already removed
      }
      this.path = undefined;
    }
  }
}

function handoffText(
  reason: BackgroundReason,
  windowMs: number,
  adopted: AdoptedCommand,
  preview: string,
): string {
  const head =
    reason === "steer"
      ? `The user sent a message while this command was running, so it was moved to background task ${adopted.displayName} (${adopted.id}).`
      : `Command still running after ${String(Math.round(windowMs / 1000))}s; moved to background task ${adopted.displayName} (${adopted.id}) instead of blocking the turn.`;
  const lines = [
    head,
    "The same process keeps running (not restarted). A <background-task-notification> wakes you when it ends; do not sleep, poll, or rerun it.",
    `Full output: ${adopted.outputPath}`,
  ];
  if (preview.length > 0) lines.push("Output so far (tail):", preview);
  return lines.join("\n");
}

export function createAutoBackgroundBashTool(
  options: AutoBackgroundBashOptions,
): AutoBackgroundBashDefinition {
  const previewChars = options.previewChars ?? DEFAULT_PREVIEW_CHARS;
  const base = options.createDefinition(
    process.cwd(),
    options.createLocalOperations(),
  );
  if (options.windowMs <= 0) {
    // Disabled: behave exactly like Pi's built-in bash (same description, per-call cwd).
    return {
      ...base,
      async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
        const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
        return options
          .createDefinition(cwd, options.createLocalOperations())
          .execute(toolCallId, rawParams, signal, onUpdate, ctx);
      },
    } as AutoBackgroundBashDefinition;
  }
  return {
    ...base,
    description: BASH_TOOL_DESCRIPTION,
    promptGuidelines: BASH_TOOL_PROMPT_GUIDELINES,
    async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as BashParams;
      const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
      if (!options.isEligible(ctx)) {
        return options
          .createDefinition(cwd, options.createLocalOperations())
          .execute(toolCallId, rawParams, signal, onUpdate, ctx);
      }

      const spool = new OutputSpool(options.tempDir);
      const local = options.createLocalOperations();
      const operations: BashOperations = {
        exec: (command, execCwd, execOptions) =>
          local.exec(command, execCwd, {
            ...execOptions,
            onData: (data) => {
              spool.write(data);
              execOptions.onData(data);
            },
          }),
      };
      const definition = options.createDefinition(cwd, operations);
      const inner = new AbortController();
      let promoted = false;
      const onTurnAbort = (): void => {
        if (!promoted) inner.abort();
      };
      if (signal?.aborted) inner.abort();
      else signal?.addEventListener("abort", onTurnAbort, { once: true });

      const run = Promise.resolve(
        definition.execute(
          toolCallId,
          rawParams,
          inner.signal,
          onUpdate === undefined
            ? undefined
            : (update: Parameters<NonNullable<typeof onUpdate>>[0]) => {
                if (!promoted) onUpdate(update);
              },
          ctx,
        ),
      );
      type Outcome =
        | { kind: "done"; value: Awaited<typeof run> }
        | { kind: "error"; error: unknown }
        | { kind: "background"; reason: BackgroundReason };
      let requestBackground: (reason: BackgroundReason) => void = () =>
        undefined;
      const backgroundRequested = new Promise<BackgroundReason>((resolve) => {
        requestBackground = resolve;
      });
      const slot: ForegroundSlot = {
        requestBackground: (reason) => requestBackground(reason),
      };
      options.foreground.add(slot);
      const timer = setTimeout(
        () => requestBackground("timeout"),
        options.windowMs,
      );
      timer.unref?.();

      try {
        const outcome: Outcome = await Promise.race<Outcome>([
          run.then(
            (value) => ({ kind: "done", value }),
            (error: unknown) => ({ kind: "error", error }),
          ),
          backgroundRequested.then((reason) => ({
            kind: "background",
            reason,
          })),
        ]);
        if (outcome.kind === "done") return outcome.value;
        if (outcome.kind === "error") throw outcome.error;

        promoted = true;
        signal?.removeEventListener("abort", onTurnAbort);
        const completion = run.then(
          () => undefined,
          (error: unknown) => {
            throw new Error(summarizeBashFailure(error));
          },
        );
        // The task owns the outcome from here; keep an unobserved rejection from surfacing.
        completion.catch(() => undefined);
        let adopted: AdoptedCommand;
        try {
          adopted = await options.adopt(ctx, {
            command: params.command,
            completion,
            cancel: () => inner.abort(),
          });
        } catch {
          // Registration failed: keep the old foreground semantics rather than orphan the process.
          promoted = false;
          if (signal?.aborted) inner.abort();
          else signal?.addEventListener("abort", onTurnAbort, { once: true });
          return await run;
        }
        const preview = spool.tail(previewChars);
        spool.redirect((data) => adopted.write(data));
        return {
          content: [
            {
              type: "text",
              text: handoffText(
                outcome.reason,
                options.windowMs,
                adopted,
                preview,
              ),
            },
          ],
          details: undefined,
        };
      } finally {
        clearTimeout(timer);
        options.foreground.delete(slot);
        if (!promoted) {
          spool.dispose();
          signal?.removeEventListener("abort", onTurnAbort);
        }
      }
    },
  } as AutoBackgroundBashDefinition;
}
