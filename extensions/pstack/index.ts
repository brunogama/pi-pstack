import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { RpcClient, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { bundledAgentsDirectory, discoverAgents, projectAgentsDirectory, type AgentConfig, type AgentScope } from "./agents.ts";
import { ROLE_NAMES, configPath, defaultConfig, modelsForRole, readConfig, writeConfig } from "./config.ts";

import { createPotetoJobs } from "./poteto-jobs.ts";
const MAX_PARALLEL_TASKS = 8;
const MAX_MODEL_OUTPUT_BYTES = 50 * 1024;
const MODE_ENTRY = "pstack-mode";

const Task = Type.Object({
  agent: Type.String({ description: "Agent name. Use poteto-agent for pstack implementation delegates." }),
  task: Type.String({ description: "Self-contained delegated task. Point to files instead of inlining large payloads." }),
  model: Type.Optional(Type.String({ description: "Pi model selector (provider/model). Overrides the role configuration." })),
  role: Type.Optional(Type.String({ description: "pstack model role configured by /setup-pstack." })),
  cwd: Type.Optional(Type.String({ description: "Working directory for this child Pi process." })),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  role: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  tasks: Type.Optional(Type.Array(Task)),
  chain: Type.Optional(Type.Array(Task)),
  agentScope: Type.Optional(
    StringEnum(["bundled", "user", "project", "both"] as const, {
      description: "Agent locations. bundled is the safe default. Project agents require explicit opt-in.",
      default: "bundled",
    }),
  ),
  confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
});

type TaskInput = {
  agent: string;
  task: string;
  model?: string;
  role?: string;
  cwd?: string;
};


function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}


function truncate(text: string): string {
  if (Buffer.byteLength(text) <= MAX_MODEL_OUTPUT_BYTES) return text;
  let output = text.slice(0, MAX_MODEL_OUTPUT_BYTES);
  while (Buffer.byteLength(output) > MAX_MODEL_OUTPUT_BYTES) output = output.slice(0, -1);
  return `${output}\n\n[Output truncated. Full transcript is retained in the tool details.]`;
}

function piInvocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && fs.existsSync(script) && !script.startsWith("/$bunfs/root/")) {
    return { command: process.execPath, args: [script, ...args] };
  }
  const executable = path.basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable)
    ? { command: "pi", args }
    : { command: process.execPath, args };
}

async function temporaryPrompt(agent: AgentConfig): Promise<{ directory: string; file: string }> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-pstack-agent-"));
  const file = path.join(directory, `${agent.name.replace(/[^a-z0-9_.-]/gi, "_")}.md`);
  let prompt = agent.systemPrompt.trim();
  if (agent.name === "poteto-agent") {
    prompt += `\n\nBefore any work, use the read tool to load ${path.join(packageRoot(), "skills/poteto-mode/SKILL.md")} in full. It is the canonical Pi pstack mode.`;
  }
  await fsp.writeFile(file, prompt, { encoding: "utf8", mode: 0o600 });
  return { directory, file };
}


function knownExternalWrite(command: string): string | undefined {
  const patterns: Array<[RegExp, string]> = [
    [/\bgit\s+push\b/, "git push"],
    [/\bgh\s+pr\s+(create|edit|merge|close)\b/, "GitHub pull-request mutation"],
    [/\bgt\s+(submit|merge|create)\b/, "Graphite mutation"],
    [/\b(terraform|tofu)\s+(apply|destroy)\b/, "infrastructure mutation"],
    [/\bkubectl\s+(apply|delete|rollout)\b/, "Kubernetes mutation"],
    [/\b(vercel|flyctl|railway)\s+(deploy|promote)\b/, "deployment"],
    [/\brm\s+(-[A-Za-z]*r|--recursive)/, "recursive deletion"],
  ];
  return patterns.find(([pattern]) => pattern.test(command))?.[1];
}

export default function (pi: ExtensionAPI) {
  let potetoMode = false;
  let todos: string[] = [];
  const potetoJobs = createPotetoJobs(
    (options) => new RpcClient(options),
    (status) => pi.sendMessage({
      customType: "pstack-poteto-job",
      content: `Poteto job ${status.id} ${status.state}. Use poteto_job status for the result.`,
      display: true,
    }, { deliverAs: "followUp", triggerTurn: false }),
  );

  pi.on("session_shutdown", async () => { await potetoJobs.shutdown(); });

  pi.on("session_start", (_event, ctx) => {
    potetoMode = false;
    todos = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === MODE_ENTRY) potetoMode = Boolean((entry.data as { enabled?: boolean }).enabled);
      if (entry.type === "custom" && entry.customType === "pstack-todo") {
        const items = (entry.data as { items?: unknown }).items;
        if (Array.isArray(items) && items.every((item) => typeof item === "string")) todos = items;
      }
    }
    if (ctx.mode === "tui") ctx.ui.setStatus("pstack-mode", potetoMode ? "pstack: poteto mode" : undefined);
  });

  pi.on("input", (event) => {
    if (/^\/skill:poteto-mode(?:\s|$)/.test(event.text)) {
      potetoMode = true;
      pi.appendEntry(MODE_ENTRY, { enabled: true });
    }
    return { action: "continue" } as const;
  });

  pi.on("before_agent_start", (event) => {
    if (!potetoMode) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nPstack Poteto Mode is enabled for this session. Follow its persisted workflow: use pstack_todo for non-trivial work, select and read the matching playbook, delegate through the subagent tool when delegation helps, verify real behavior, and name only principles that changed a decision. The full skill is at ${path.join(packageRoot(), "skills/poteto-mode/SKILL.md")}.`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" && event.toolName !== "bash_bg") return;
    const input = event.input as { command?: string };
    const operation = input.command ? knownExternalWrite(input.command) : undefined;
    if (!operation) return;
    if (!ctx.hasUI) return { block: true, reason: `${operation} requires explicit user confirmation; non-interactive Pi cannot request it.` };
    const approved = await ctx.ui.confirm("Confirm external or irreversible action", `Allow ${operation}?\n\n${input.command}`);
    if (!approved) return { block: true, reason: `User declined ${operation}.` };
  });

  pi.registerCommand("poteto-mode", {
    description: "Enable or disable sticky pstack Poteto Mode for this Pi session. Usage: /poteto-mode [task] | /poteto-mode off",
    handler: async (args, ctx) => {
      if (/^(off|disable|stop)$/i.test(args.trim())) {
        potetoMode = false;
        pi.appendEntry(MODE_ENTRY, { enabled: false });
        ctx.ui.setStatus("pstack-mode", undefined);
        ctx.ui.notify("Poteto Mode disabled for this session.", "info");
        return;
      }
      potetoMode = true;
      pi.appendEntry(MODE_ENTRY, { enabled: true });
      ctx.ui.setStatus("pstack-mode", "pstack: poteto mode");
      pi.sendUserMessage(`/skill:poteto-mode${args.trim() ? ` ${args.trim()}` : ""}`, { expandPromptTemplates: true });
    },
  });

  pi.registerCommand("setup-pstack", {
    description: "Interactively map pstack delegation roles to models available in Pi.",
    handler: async (_args, ctx) => {
      const config = await readConfig();
      const available = (ctx.scopedModels.length ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable())
        .map((model) => `${model.provider}/${model.id}`);
      const choices = ["inherit-parent", ...new Set(available)];
      if (!ctx.hasUI) {
        await writeConfig(defaultConfig());
        return;
      }
      for (const role of ROLE_NAMES) {
        const current = config.roles[role];
        const selected = await ctx.ui.select(`Model for ${role}`, choices.map((model) => model === current ? `${model} (current)` : model));
        if (!selected) break;
        config.roles[role] = selected.replace(/ \(current\)$/, "");
      }
      await writeConfig(config);
      ctx.ui.notify(`Saved pstack model settings to ${configPath()}.`, "info");
    },
  });

  pi.registerTool({
    name: "pstack_todo",
    label: "Pstack Todo",
    description: "Maintain pstack's current task checklist. Use at the start of non-trivial multi-step work, then update it as work advances.",
    parameters: Type.Object({
      action: StringEnum(["get", "set", "add", "complete"] as const),
      items: Type.Optional(Type.Array(Type.String())),
      item: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      if (params.action === "set") todos = params.items ?? [];
      if (params.action === "add" && params.item) todos = [...todos, params.item];
      if (params.action === "complete" && params.item) todos = todos.map((item) => item === params.item ? `[done] ${item}` : item);
      pi.appendEntry("pstack-todo", { items: todos });
      return { content: [{ type: "text", text: todos.length ? todos.map((item, index) => `${index + 1}. ${item}`).join("\n") : "No pstack todo items." }], details: { items: todos } };
    },
  });

  pi.registerTool({
    name: "pstack_sessions",
    label: "Pstack Sessions",
    description: "List Pi session files for the current working directory. Use before reading prior Pi transcripts; never glob other project session directories.",
    parameters: Type.Object({ action: StringEnum(["list"] as const) }),
    async execute(_id, _params, _signal, _update, ctx) {
      const sessions = await SessionManager.list(ctx.cwd);
      const files = sessions.map((session) => session.path);
      return { content: [{ type: "text", text: files.join("\n") || "No saved sessions for this working directory." }], details: { files } };
    },
  });

  pi.registerTool({
    name: "pstack_config",
    label: "Pstack Config",
    description: "Read or update pstack's role-to-model configuration. Use list-models before setting a model. inherit-parent makes a subagent use the parent session model.",
    parameters: Type.Object({
      action: StringEnum(["get", "list-models", "set"] as const),
      role: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      models: Type.Optional(Type.Array(Type.String(), { description: "Optional ordered model pool for a parallel review role." })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (params.action === "list-models") {
        const models = (ctx.scopedModels.length ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable())
          .map((model) => `${model.provider}/${model.id}`);
        return { content: [{ type: "text", text: ["inherit-parent", ...models].join("\n") }], details: { models } };
      }
      const config = await readConfig();
      if (params.action === "set") {
        if (!params.role || (!params.model && !params.models?.length)) throw new Error("pstack_config set requires role plus model or models.");
        config.roles[params.role] = params.models?.length ? params.models : params.model ?? "inherit-parent";
        await writeConfig(config);
      }
      return { content: [{ type: "text", text: JSON.stringify(config, null, 2) }], details: config };
    },
  });

  pi.registerTool({
    name: "poteto_job",
    label: "Poteto Job",
    description: "Inspect, steer, or stop a background poteto-agent. A steer reaches the running child through Pi RPC after its current tool calls finish.",
    parameters: Type.Object({
      action: StringEnum(["list", "status", "steer", "stop"] as const),
      id: Type.Optional(Type.String({ description: "Job ID returned by subagent." })),
      message: Type.Optional(Type.String({ description: "Instruction to steer into a running child." })),
    }),
    async execute(_id, params) {
      const reply = (text: string, details: Record<string, unknown>) => ({ content: [{ type: "text" as const, text }], details });
      if (params.action === "list") {
        const jobs = potetoJobs.list().map(({ id, task, state }) => ({ id, task, state }));
        return reply(JSON.stringify(jobs), { jobs });
      }
      if (!params.id) throw new Error(`${params.action} requires a job ID.`);
      if (params.action === "steer") {
        if (!params.message) throw new Error("steer requires a message.");
        const disposition = await potetoJobs.steer(params.id, params.message);
        return reply(`Steer ${disposition} for ${params.id}.`, { disposition });
      }
      const status = params.action === "stop" ? await potetoJobs.stop(params.id) : potetoJobs.status(params.id);
      const visible = status.state === "completed" ? { ...status, result: truncate(status.result) } : status;
      return reply(JSON.stringify(visible), { status });
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: `Delegate isolated work to Pi subagents. A single poteto-agent starts asynchronously and returns a job ID; use poteto_job to steer or retrieve its result. Other agents start background single, parallel (maximum ${MAX_PARALLEL_TASKS}), or chain modes. Bundled agents live in ${bundledAgentsDirectory()}.`,
    reachesTools: () => ["bash_bg"],
    parameters: SubagentParams,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const scope = (params.agentScope ?? "bundled") as AgentScope;
      const agents = discoverAgents(ctx.cwd, scope);
      const requested = params.agent ? [{ agent: params.agent, task: params.task ?? "", model: params.model, role: params.role, cwd: params.cwd }] : undefined;
      const modes = Number(Boolean(requested && params.task)) + Number(Boolean(params.tasks?.length)) + Number(Boolean(params.chain?.length));
      if (modes !== 1) throw new Error("Provide exactly one mode: agent + task, tasks, or chain.");
      if ([...(params.tasks ?? []), ...(params.chain ?? [])].some((task) => task.agent === "poteto-agent")) {
        throw new Error("poteto-agent must be launched as a single asynchronous job; tasks and chain cannot await it.");
      }
      if ((scope === "project" || scope === "both") && params.confirmProjectAgents !== false && ctx.hasUI) {
        const names = [...(requested ?? []), ...(params.tasks ?? []), ...(params.chain ?? [])].map((task) => task.agent);
        const project = agents.filter((agent) => agent.source === "project" && names.includes(agent.name));
        if (project.length) {
          const approved = await ctx.ui.confirm("Run project-local Pi agents?", `Agents: ${project.map((agent) => agent.name).join(", ")}\nSource: ${projectAgentsDirectory(ctx.cwd)}`);
          if (!approved) throw new Error("Project-local agents were not approved.");
        }
      }
      const config = await readConfig();
      const childModel = (task: TaskInput, index = 0) => task.model ?? modelsForRole(config, task.role)[index % Math.max(modelsForRole(config, task.role).length, 1)] ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
      if (requested?.[0].agent === "poteto-agent") {
        const agent = agents.find((candidate) => candidate.name === "poteto-agent");
        if (!agent) throw new Error("poteto-agent is not available in the selected agent scope.");
        const task = requested[0];
        const temp = await temporaryPrompt(agent);
        const cleanup = () => fsp.rm(temp.directory, { recursive: true, force: true });
        let status;
        try {
          status = await potetoJobs.start({
            task: task.task,
            cwd: task.cwd ?? ctx.cwd,
            promptFile: temp.file,
            model: childModel(task),
            cleanup,
          });
        } catch (cause) {
          await cleanup();
          throw cause;
        }
        return {
          content: [{ type: "text", text: `Poteto agent ${status.state}. Job ID: ${status.id}. Status artifact: ${status.statusArtifactPath}. To wait, run node skills/poteto-mode/scripts/watch-poteto-job.mjs ${status.statusArtifactPath} [timeout-ms]. Use poteto_job to steer, inspect, or stop it.` }],
          details: { mode: "background", status, statusArtifactPath: status.statusArtifactPath },
        };
      }
      let mode: "single" | "parallel" | "chain" = "single";
      if (params.chain?.length) mode = "chain";
      else if (params.tasks?.length) mode = "parallel";
      const tasks = params.chain ?? params.tasks ?? requested ?? [];
      if (tasks.length > MAX_PARALLEL_TASKS) throw new Error(`At most ${MAX_PARALLEL_TASKS} tasks are allowed.`);
      if (signal?.aborted) throw new Error("Subagent launch aborted.");
      const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-pstack-stack-"));
      try {
        const prepared = [];
        for (const [index, task] of tasks.entries()) {
          const agent = agents.find((candidate) => candidate.name === task.agent);
          if (!agent) throw new Error(`Unknown agent ${JSON.stringify(task.agent)}.`);
          const promptFile = path.join(directory, `agent-${index}.md`);
          await fsp.writeFile(promptFile, agent.systemPrompt.trim(), { mode: 0o600 });
          prepared.push({ agent: task.agent, task: task.task, cwd: task.cwd ?? ctx.cwd, model: childModel(task, index), tools: agent.tools, promptFile });
        }
        const specPath = path.join(directory, "stack.json");
        await fsp.writeFile(specPath, JSON.stringify({ mode, tasks: prepared, cli: piInvocation([]), cleanupDirectory: directory }), { mode: 0o600 });
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        const runner = fileURLToPath(new URL("./stack-runner.mjs", import.meta.url));
        const launch = await ctx.executeTool("bash_bg", {
          command: `${quote(process.execPath)} ${quote(runner)} ${quote(specPath)}`,
          name: `Pystack ${mode} stack`,
        });
        const response = launch.result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
        const jobId = /\bID: ([a-zA-Z0-9_-]+)/.exec(response)?.[1];
        if (launch.isError || !jobId) throw new Error(response || "Background extension could not launch the stack.");
        return {
          content: [{ type: "text", text: `Subagent ${mode} stack started in the background. Job ID: ${jobId}. Use jobs output to read the result, jobs attach to wait, or jobs kill to stop it.` }],
          details: { mode, jobId },
        };
      } catch (cause) {
        await fsp.rm(directory, { recursive: true, force: true });
        throw cause;
      }
    },
  });
}
