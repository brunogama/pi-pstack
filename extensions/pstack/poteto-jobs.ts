import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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
type StatusArtifact =
  | { schemaVersion: 1; jobId: string; state: "running" }
  | { schemaVersion: 1; jobId: string; state: "completed"; result: string }
  | { schemaVersion: 1; jobId: string; state: "failed" | "stopped"; error: string };
type StartedJob = JobStatus & { statusArtifactPath: string };
type Job = {
  status: JobStatus;
  statusArtifactPath: string;
  client: RpcConnection;
  unsubscribe: () => void;
  cleanup: () => Promise<void>;
  closing?: Promise<void>;
};
type StartOptions = {
  task: string;
  cwd: string;
  promptFile: string;
  model?: string;
  cliPath?: string;
  cleanup?: () => Promise<void>;
  statusDirectory?: string;
};

function artifactStatus(status: JobStatus): StatusArtifact {
  switch (status.state) {
    case "running": return { schemaVersion: 1, jobId: status.id, state: "running" };
    case "completed": return { schemaVersion: 1, jobId: status.id, state: "completed", result: status.result };
    case "failed": return { schemaVersion: 1, jobId: status.id, state: "failed", error: status.error };
    case "stopped": return { schemaVersion: 1, jobId: status.id, state: "stopped", error: status.error };
    default: throw new Error("Unexpected poteto job state.");
  }
}

async function createStatusArtifact(statusDirectory?: string): Promise<string> {
  const directory = await fsp.mkdtemp(path.join(statusDirectory ?? os.tmpdir(), "pi-pstack-poteto-"));
  await fsp.chmod(directory, 0o700);
  return path.join(directory, "status.json");
}

async function writeStatusArtifact(artifactPath: string, status: JobStatus): Promise<void> {
  const temporaryPath = path.join(path.dirname(artifactPath), `.status-${randomUUID()}.json`);
  const handle = await fsp.open(temporaryPath, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(artifactStatus(status))}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporaryPath, artifactPath);
  await fsp.chmod(artifactPath, 0o600);
}

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
      let finalStatus = status;
      try { await job.client.stop(); }
      catch (cause) { finalStatus = { id: status.id, task: status.task, state: "failed", error: String(cause) }; }
      try { await job.cleanup(); }
      catch (cause) { finalStatus = { id: status.id, task: status.task, state: "failed", error: String(cause) }; }
      job.status = finalStatus;
      try { await writeStatusArtifact(job.statusArtifactPath, finalStatus); }
      catch (cause) {
        job.status = { id: finalStatus.id, task: finalStatus.task, state: "failed", error: `Could not persist poteto job status: ${String(cause)}` };
        console.error("Poteto status artifact update failed:", cause);
      }
      try { onFinish?.(job.status); }
      catch (cause) { console.error("Poteto completion notice failed:", cause); }
    })();
    return job.closing;
  };

  return {
    async start(options: StartOptions): Promise<StartedJob> {
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
      const statusArtifactPath = await createStatusArtifact(options.statusDirectory);
      const job: Job = {
        status: { id, task: options.task, state: "running" },
        statusArtifactPath,
        client,
        unsubscribe: () => {},
        cleanup,
      };
      await writeStatusArtifact(statusArtifactPath, job.status);
      let answer = "";
      let error = "";
      job.unsubscribe = client.onEvent((event) => {
        if (typeof event !== "object" || event === null || !("type" in event)) return;
        if (event.type === "message_end" && "message" in event) {
          const message = event.message;
          if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "assistant") return;
          if ("content" in message && Array.isArray(message.content)) {
            const text = message.content.flatMap((part): string[] =>
              typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string"
                ? [part.text] : []
            ).join("\n");
            if (text) answer = text;
          }
          if ("stopReason" in message && (message.stopReason === "error" || message.stopReason === "aborted")) {
            error = "errorMessage" in message && typeof message.errorMessage === "string" ? message.errorMessage : String(message.stopReason);
          }
        }
        if (event.type === "agent_settled") {
          void finish(job, error
            ? { id, task: options.task, state: "failed", error }
            : { id, task: options.task, state: "completed", result: answer || "(no output)" });
        }
      });
      jobs.set(id, job);
      try {
        await client.start();
        const disposition = await client.prompt(`Delegated task:\n${options.task}`);
        if (disposition === "handled") void finish(job, { id, task: options.task, state: "completed", result: answer || "(handled by extension)" });
        return { ...job.status, statusArtifactPath };
      } catch (cause) {
        jobs.delete(id);
        job.unsubscribe();
        let error = String(cause);
        try { await client.stop(); }
        catch (stopCause) { error = String(stopCause); }
        try { await cleanup(); }
        catch (cleanupCause) { error = String(cleanupCause); }
        job.status = { id, task: options.task, state: "failed", error };
        try { await writeStatusArtifact(statusArtifactPath, job.status); }
        catch (writeCause) { console.error("Poteto status artifact update failed:", writeCause); }
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
        void finish(job, { id, task: job.status.task, state: "failed", error: String(cause) });
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
