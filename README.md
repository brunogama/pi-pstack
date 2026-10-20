# pi-pstack

A Pi-native port of [pstack](https://github.com/cursor/plugins/tree/main/pstack). It includes all 44 upstream skills and their references, playbooks, and scripts, plus Pi implementations of `poteto-agent` and `comment-sicko`.

---

## Install

Install the published package:

```bash
pi install git:github.com/brunogama/pi-pstack
```

Then restart Pi. Use `pi config` to enable or disable package resources.

---

## Start

```text
/setup-pstack
/poteto-mode investigate and fix the retry regression, then verify it
/poteto-mode off
```

`/setup-pstack` is an extension command. It interactively maps pstack roles to models that Pi has configured and saves the result in `~/.pi/agent/pstack/models.json`.

`/poteto-mode` enables sticky Poteto Mode for the current Pi session and expands the bundled `poteto-mode` skill. `/poteto-mode off` disables it. Individual skills use Pi's standard form, for example `/skill:how` and `/skill:no-comments`.

---

## Pi subagents

The extension registers a `subagent` tool for isolated child processes. A single `poteto-agent` starts asynchronously through Pi RPC and returns a job ID. Other single, parallel, and chain requests launch through the installed `bash_bg` extension, return a background job ID immediately, and send a completion notification. Install and enable a background extension that provides `bash_bg` and `jobs` before using these modes.

Bundled agents:

- `poteto-agent` for pstack implementation and investigation delegates. It must read the full `poteto-mode` skill before working.
- `comment-sicko` for comment-only review.

The tool supports a single task, `tasks` for parallel work, and `chain` for sequential work with `{previous}` interpolation. It accepts `role` for the model configuration and `model` for a one-off `provider/model` override. It permits at most eight tasks and runs at most four concurrently.

It also honors Pi's subagent definition locations:

- `~/.pi/agent/agents/*.md` for user agents.
- `.pi/agents/*.md` for project agents, only with `agentScope: "project"` or `"both"`.

Bundled agents are the default. Project agents require interactive approval unless `confirmProjectAgents: false` is explicit.

Use `poteto_job` with `action: "status"` to read a result, `action: "steer"` and `message` to guide a running job, `action: "list"` to see jobs, or `action: "stop"` to cancel one. Steering is acknowledged by Pi RPC and takes effect after the child's current tool calls. Running jobs stop when the parent Pi session shuts down; they do not survive a restart. Launch `poteto-agent` singly: parallel `tasks` and sequential `chain` cannot contain one, because its steerable RPC lifecycle differs from ordinary background stacks.
To wait from a shell, pass the status artifact path from the `subagent` result to `node skills/poteto-mode/scripts/watch-poteto-job.mjs <status-artifact-path> [timeout-ms]`. The watcher waits for the job's terminal artifact state. It exits with code 0 when the job completes. It exits nonzero when the job fails, stops, times out, or the status artifact has invalid JSON.

For other agents, inspect the returned ID using the `jobs` tool with `action: "output"`, wait using `action: "attach"`, or cancel using `action: "kill"`. The job log contains a JSON report with each agent's final answer; a failed child makes the background job fail. The job runner removes its temporary prompts and specification when it exits normally.

Restart Pi after updating an already-loaded extension. Future `subagent` calls then return the changed response.

---

## Safety and compatibility

This port deliberately removes Cursor-only setup and behavior:

| Cursor pstack behavior | Pi equivalent |
|---|---|
| `Task` and `subagent_type` | `subagent` tool and Markdown agent definitions |
| Cursor model slugs and rules | `/setup-pstack`, `pstack_config`, and Pi `provider/model` selectors |
| sticky `mode: true` | session-persisted `/poteto-mode` extension command |
| Cursor todo list | `pstack_todo` tool |
| Cursor transcript directories | `$PI_SESSION_FILE` and `pstack_sessions` |
| `/loop`, cloud-agent resume | explicit project watchers; child Pi processes are local and fresh |
| Cursor Team Kit skills | capability detection and project-native verification tooling |

The extension requests confirmation for recognizable shell commands that push, alter pull requests, merge, deploy, mutate infrastructure, or recursively delete files. In non-interactive mode it blocks these commands. This is a guardrail, not a complete shell-security sandbox. Prompts also require explicit approval for all external or irreversible actions.

The upstream `watch-pr` and orchestration helper scripts are retained. Their runtime requirements remain project-specific. In particular, the script package uses Bun and GitHub workflows require `gh` authentication.

---

## License and provenance

Derived from Cursor's pstack, licensed under MIT. See [LICENSE](LICENSE).
