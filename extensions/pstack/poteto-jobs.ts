import { randomUUID } from "node:crypto";

type RpcConnection = {
  start(): Promise<void>;
  prompt(message: string): Promise<"started" | "queued" | "handled">;
  steer(message: string): Promise<"queued" | "handled">;
  stop(): Promise<void>;
  onEvent(listener: (event: unknown) => void): () => void;
  getStderr(): string;
};

type ConnectionOptions = { cwd: string; cliPath: string; model?: string; args: string[] };
type JobStatus =
  | { id: string; task: string; state: "running" }
  | { id: string; task: string; state: "completed"; result: string }
  | { id: string; task: string; state: "failed" | "stopped"; error: string };
type Job = { status: JobStatus; client: RpcConnection; unsubscribe: () => void; cleanup: () => Promise<void>; closing?: Promise<void> };

type StartOptions = { task: string; cwd: string; promptFile: string; model?: string; cliPath?: string; cleanup?: () => Promise<void> };

export function createPotetoJobs(
  createConnection: (options: ConnectionOptions) => RpcConnection,
  onFinish?: (status: JobStatus) => void,
) {
  const jobs = new Map<string, Job>();

  const finish = (job: Job, status: JobStatus): Promise<void> => {
    if (job.status.state !== "running") return job.closing ?? Promise.resolve();
    job.status = status;
    job.unsubscribe();
    job.closing = (async () => {
      try { await job.client.stop(); }
      catch (cause) { job.status = { id: status.id, task: status.task, state: "failed", error: String(cause) }; }
      try { await job.cleanup(); }
      catch (cause) { job.status = { id: status.id, task: status.task, state: "failed", error: String(cause) }; }
    })();
    try { onFinish?.(status); }
    catch (cause) { console.error("Poteto completion notice failed:", cause); }
    return job.closing;
  };

  return {
    async start(options: StartOptions): Promise<JobStatus> {
      if ([...jobs.values()].filter((job) => job.status.state === "running").length >= 4) {
        throw new Error("At most four poteto agents can run in the background at once.");
      }
      const cliPath = options.cliPath ?? process.argv[1];
      if (!cliPath) throw new Error("Cannot locate the running Pi CLI for poteto RPC dispatch.");
      const client = createConnection({
        cliPath,
        cwd: options.cwd,
        model: options.model,
        args: ["--no-session", "--append-system-prompt", options.promptFile],
      });
      const id = `poteto-${randomUUID()}`;
      const cleanup = options.cleanup ?? (async () => {});
      let answer = "";
      let error = "";
      const job: Job = { status: { id, task: options.task, state: "running" }, client, unsubscribe: () => {}, cleanup };
      job.unsubscribe = client.onEvent((event) => {
        if (typeof event !== "object" || event === null || !("type" in event)) return;
        if (event.type === "message_end" && "message" in event) {
          const message = event.message;
          if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "assistant") return;
          if ("content" in message && Array.isArray(message.content)) {
            const text = message.content.filter((part): part is { type: "text"; text: string } =>
              typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string"
            ).map((part) => part.text).join("\n");
            if (text) answer = text;
          }
          if ("stopReason" in message && (message.stopReason === "error" || message.stopReason === "aborted")) {
            error = "errorMessage" in message && typeof message.errorMessage === "string" ? message.errorMessage : String(message.stopReason);
          }
        }
        if (event.type === "agent_settled") {
          finish(job, error
            ? { id, task: options.task, state: "failed", error }
            : { id, task: options.task, state: "completed", result: answer || "(no output)" });
        }
      });
      jobs.set(id, job);
      try {
        await client.start();
        const disposition = await client.prompt(`Delegated task:\n${options.task}`);
        if (disposition === "handled") finish(job, { id, task: options.task, state: "completed", result: answer || "(handled by extension)" });
        return job.status;
      } catch (cause) {
        jobs.delete(id);
        job.unsubscribe();
        try { await client.stop(); }
        finally { await cleanup(); }
        throw cause;
      }
    },
    status(id: string): JobStatus {
      const job = jobs.get(id);
      if (!job) throw new Error(`Unknown poteto job ${id}.`);
      return job.status;
    },
    list(): JobStatus[] { return [...jobs.values()].map((job) => job.status); },
    async steer(id: string, message: string): Promise<"queued" | "handled"> {
      const job = jobs.get(id);
      if (!job || job.status.state !== "running") throw new Error(`Poteto job ${id} is not running.`);
      if (!message.trim()) throw new Error("Steering message cannot be empty.");
      try {
        return await job.client.steer(message);
      } catch (cause) {
        finish(job, { id, task: job.status.task, state: "failed", error: String(cause) });
        throw cause;
      }
    },
    async stop(id: string): Promise<JobStatus> {
      const job = jobs.get(id);
      if (!job) throw new Error(`Unknown poteto job ${id}.`);
      if (job.status.state === "running") {
        await finish(job, { id, task: job.status.task, state: "stopped", error: "Stopped by operator." });
      } else await job.closing;
      return job.status;
    },
    async shutdown(): Promise<void> {
      await Promise.all([...jobs.values()].map((job) => job.status.state === "running"
        ? finish(job, { id: job.status.id, task: job.status.task, state: "stopped", error: "Parent session closed." })
        : job.closing));
    },
  };
}
