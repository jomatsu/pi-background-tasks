---
doc_id: tools/bash
audience: agent
mode: mixed
review_policy: behavioral
stability: evolving
covers_surfaces: [tool:bash]
covers_sources: [src/core/auto-background-bash.ts]
---
# `bash`

<!-- pi-docs:begin name="tool-contract-bash" generator="scripts/docs/generate.mjs" -->
- Label: **bash**
- Source: `src/extension.ts:1209`
- Availability: `always`
- Available by default: **yes**
- Description: Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. In interactive sessions a command still running after the auto-background window (PI_BG_BASH_AUTO_BACKGROUND_SECONDS, default 60; 0 or off disables) keeps running as a background task and the call returns; a <background-task-notification> wakes you when it finishes.
- Root schema: `object`

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `command` | yes | `string` | Bash command to execute |  |
| `timeout` | no | `number` | Timeout in seconds (optional, no default timeout) |  |

<details>
<summary>Normalized TypeBox contract</summary>


```json
{
  "properties": {
    "command": {
      "description": "Bash command to execute",
      "type": "string"
    },
    "timeout": {
      "description": "Timeout in seconds (optional, no default timeout)",
      "type": "number"
    }
  },
  "required": [
    "command"
  ],
  "type": "object"
}
```

</details>
<!-- pi-docs:end name="tool-contract-bash" -->

Replaces Pi's built-in `bash` tool with the same shell execution, output truncation, full-output temp file, timeout and rendering, plus one change: in an interactive session a command that is still running when the auto-background window elapses, or when the user steers while it runs, is handed to the background task registry and the call returns at once.

## Schema

Identical to Pi's built-in `bash`:

- `command: string` — bash command to execute.
- `timeout?: number` — timeout in seconds; no default timeout.

## When to use

Use it like the built-in `bash`. Prefer [`bg_run`](bg_run.md) when a command is known in advance to run long (servers, watchers, full test suites); auto-background is the safety net for commands that turn out to be slow.

## Defaults

- Window: `PI_BG_BASH_AUTO_BACKGROUND_SECONDS`, default `60`. `0` or `off` disables auto-background and the tool behaves exactly like the built-in `bash`.
- Only interactive parents (`ctx.hasUI === true`) auto-background. Print/JSON children run every command in the foreground, because nobody is there to be woken.

## Lifecycle

1. The command starts in the foreground and streams output as usual.
2. If it finishes inside the window, the result is returned exactly like the built-in tool (success text or the built-in failure).
3. If it is still running when the window elapses, or a steering message arrives, the same process (never restarted) is registered as a background task. Output seen so far and all later output go to the task output file.
4. The call returns a hand-off text. When the process ends, the registry delivers the normal `<background-task-notification>` and wakes the agent.
5. A turn abort (Esc) kills the command only before hand-off. After hand-off, stop it with [`bg_kill`](bg_kill.md).

If the registry cannot adopt the command, the tool keeps waiting in the foreground instead of orphaning the process.

## Examples

```json
{"command":"npm test"}
```

```json
{"command":"cargo build --release","timeout":1800}
```

## Output/result

Foreground completion: the built-in `bash` result. Hand-off:

```text
Command still running after 60s; moved to background task <name> (<id>) instead of blocking the turn.
The same process keeps running (not restarted). A <background-task-notification> wakes you when it ends; do not sleep, poll, or rerun it.
Full output: .pi/tasks/.../<id>.output
Output so far (tail):
...
```

## Errors

- Quick failures keep the built-in messages (`Command exited with code N`, `Command timed out after N seconds`, `Command aborted`).
- After hand-off, a failure is reported in the task notification with only the terminal reason line.
- An invalid `PI_BG_BASH_AUTO_BACKGROUND_SECONDS` fails extension load with `pi_bg_config_invalid`.

## Runtime artifacts

While in the foreground, output is spooled to a private temp file that is removed when the command ends or is handed off. After hand-off, output and metadata live under `.pi/tasks/...` like any `bg_run` task.

## Safety boundaries

Same as the built-in `bash`: commands are not sandboxed. Hand-off never restarts a command, so partial side effects are not repeated.

## Related docs

- [`bg_run`](bg_run.md)
- [`bg_kill`](bg_kill.md)
- [`bg_logs`](bg_logs.md)
- [Background task runtime](../subsystems/background-task-runtime.md)

## Source ownership/reference

Registration lives in `src/extension.ts`; the foreground/hand-off logic is in `src/core/auto-background-bash.ts`.
