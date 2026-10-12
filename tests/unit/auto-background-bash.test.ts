import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createBashToolDefinition,
  createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";
import {
  createAutoBackgroundBashTool,
  ForegroundCommands,
  parseBashAutoBackgroundMs,
  summarizeBashFailure,
  type AdoptRequest,
} from "../../src/core/auto-background-bash.js";

interface Harness {
  tool: ReturnType<typeof createAutoBackgroundBashTool>;
  foreground: ForegroundCommands;
  adopted: { request: AdoptRequest; output: Buffer[] }[];
  tempDir: string;
}

function harness(
  options: { windowMs?: number; eligible?: boolean; adoptFails?: boolean } = {},
): Harness {
  const foreground = new ForegroundCommands();
  const adopted: Harness["adopted"] = [];
  const tempDir = mkdtempSync(join(tmpdir(), "pi-bg-bash-test-"));
  const tool = createAutoBackgroundBashTool({
    createDefinition: (cwd, operations) =>
      createBashToolDefinition(cwd, { operations }),
    createLocalOperations: () => createLocalBashOperations(),
    windowMs: options.windowMs ?? 300,
    isEligible: () => options.eligible ?? true,
    foreground,
    tempDir,
    adopt: async (_ctx, request) => {
      if (options.adoptFails) throw new Error("registry closed");
      const entry = { request, output: [] as Buffer[] };
      adopted.push(entry);
      return {
        id: "b0000test",
        displayName: "test task",
        outputPath: ".pi/tasks/test/b0000test.output",
        write: (data) => entry.output.push(Buffer.from(data)),
      };
    },
  });
  return { tool, foreground, adopted, tempDir };
}

const ctx = {
  cwd: process.cwd(),
  hasUI: true,
  sessionManager: {
    getSessionId: () => "test-session",
    getSessionFile: () => undefined,
  },
} as never;

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.text ?? "").join("");
}

async function run(
  h: Harness,
  command: string,
  signal?: AbortSignal,
): Promise<{ content: { type: string; text?: string }[] }> {
  return (await h.tool.execute(
    "call-1",
    { command },
    signal,
    undefined,
    ctx,
  )) as never;
}

void describe("auto-background bash", () => {
  void it("returns a quick command exactly like the built-in tool and adopts nothing", async () => {
    const h = harness();
    const result = await run(h, "echo hello");
    assert.equal(text(result).trim(), "hello");
    assert.equal(h.adopted.length, 0);
    assert.equal(h.foreground.size, 0);
    assert.deepEqual(readdirSync(h.tempDir), [], "spool file is removed");
  });

  void it("keeps the built-in failure for a quick non-zero exit", async () => {
    const h = harness();
    await assert.rejects(
      run(h, "echo oops; exit 4"),
      /Command exited with code 4/u,
    );
    assert.equal(h.adopted.length, 0);
  });

  void it("hands a still-running command to the background without restarting it", async () => {
    const h = harness({ windowMs: 200 });
    const started = Date.now();
    const result = await run(h, "echo first; sleep 0.8; echo second");
    assert.ok(
      Date.now() - started < 700,
      "returns at the window, not at command end",
    );
    assert.match(
      text(result),
      /moved to background task test task \(b0000test\)/u,
    );
    assert.match(
      text(result),
      /Full output: \.pi\/tasks\/test\/b0000test\.output/u,
    );
    assert.match(text(result), /first/u);
    assert.equal(h.adopted.length, 1);
    const entry = h.adopted[0]!;
    await entry.request.completion;
    const output = Buffer.concat(entry.output).toString("utf8");
    assert.equal(
      output,
      "first\nsecond\n",
      "spooled and later output reach the task once each",
    );
    assert.deepEqual(
      readdirSync(h.tempDir),
      [],
      "spool file is removed after hand-off",
    );
  });

  void it("reports a background failure with a short reason", async () => {
    const h = harness({ windowMs: 150 });
    await run(h, "echo a; sleep 0.5; exit 3");
    await assert.rejects(h.adopted[0]!.request.completion, (error: Error) => {
      assert.equal(error.message, "Command exited with code 3");
      return true;
    });
  });

  void it("kills on a turn abort before hand-off", async () => {
    const h = harness({ windowMs: 5_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150).unref();
    await assert.rejects(run(h, "sleep 3", controller.signal), /aborted/u);
    assert.equal(h.adopted.length, 0);
  });

  void it("ignores a turn abort after hand-off; cancel stops the task", async () => {
    const h = harness({ windowMs: 150 });
    const controller = new AbortController();
    await run(h, "sleep 0.6; echo survived", controller.signal);
    controller.abort();
    const entry = h.adopted[0]!;
    await entry.request.completion;
    assert.match(Buffer.concat(entry.output).toString("utf8"), /survived/u);

    const h2 = harness({ windowMs: 150 });
    await run(h2, "sleep 5");
    h2.adopted[0]!.request.cancel();
    await assert.rejects(h2.adopted[0]!.request.completion, /Command aborted/u);
  });

  void it("moves a running command to the background when the user steers", async () => {
    const h = harness({ windowMs: 5_000 });
    setTimeout(() => h.foreground.backgroundAll("steer"), 150).unref();
    const result = await run(h, "sleep 0.5; echo late");
    assert.match(text(result), /user sent a message/u);
    await h.adopted[0]!.request.completion;
  });

  void it("passes ineligible contexts straight through", async () => {
    const h = harness({ windowMs: 100, eligible: false });
    const result = await run(h, "sleep 0.3; echo through");
    assert.equal(text(result).trim(), "through");
    assert.equal(h.adopted.length, 0);
  });

  void it("acts as plain built-in bash when the window is 0 (off)", async () => {
    const h = harness({ windowMs: 0 });
    const result = await run(h, "sleep 0.3; echo plain");
    assert.equal(text(result).trim(), "plain");
    assert.equal(h.adopted.length, 0);
    assert.doesNotMatch(h.tool.description, /background task/u);
  });

  void it("falls back to waiting when the registry cannot adopt", async () => {
    const h = harness({ windowMs: 100, adoptFails: true });
    const result = await run(h, "sleep 0.3; echo waited");
    assert.equal(text(result).trim(), "waited");
  });

  void it("advertises auto-background in the description and guidelines", () => {
    const h = harness({ windowMs: 60_000 });
    assert.equal(h.tool.name, "bash");
    assert.match(h.tool.description, /PI_BG_BASH_AUTO_BACKGROUND_SECONDS, default 60/u);
    assert.ok(
      (h.tool.promptGuidelines ?? []).some((line) =>
        /never sleep, poll/u.test(line),
      ),
    );
  });
});

void describe("summarizeBashFailure", () => {
  void it("keeps only the terminal reason line", () => {
    assert.equal(
      summarizeBashFailure(
        new Error("lots\nof output\n\nCommand exited with code 2"),
      ),
      "Command exited with code 2",
    );
    assert.equal(
      summarizeBashFailure(new Error("x\nCommand timed out after 5 seconds")),
      "Command timed out after 5 seconds",
    );
    assert.equal(summarizeBashFailure("plain"), "plain");
  });
});

void describe("bash auto-background configuration", () => {
  void it("defaults to 60 seconds and accepts seconds or off", () => {
    assert.equal(parseBashAutoBackgroundMs({}), 60_000);
    assert.equal(
      parseBashAutoBackgroundMs({ PI_BG_BASH_AUTO_BACKGROUND_SECONDS: "15" }),
      15_000,
    );
    assert.equal(
      parseBashAutoBackgroundMs({ PI_BG_BASH_AUTO_BACKGROUND_SECONDS: "off" }),
      0,
    );
    assert.equal(
      parseBashAutoBackgroundMs({ PI_BG_BASH_AUTO_BACKGROUND_SECONDS: "0" }),
      0,
    );
    assert.throws(
      () =>
        parseBashAutoBackgroundMs({ PI_BG_BASH_AUTO_BACKGROUND_SECONDS: "1m" }),
      /PI_BG_BASH_AUTO_BACKGROUND_SECONDS/u,
    );
  });
});
