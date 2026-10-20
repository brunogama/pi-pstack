import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createPotetoJobs } from "./poteto-jobs.ts";

class FakeRpcClient {
  listener: ((event: unknown) => void) | undefined;
  prompts: string[] = [];
  steers: string[] = [];
  stopped = false;

  async start() {}
  onEvent(listener: (event: unknown) => void) {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  async prompt(message: string) {
    this.prompts.push(message);
    return "started" as const;
  }
  async steer(message: string) {
    this.steers.push(message);
    return "queued" as const;
  }
  async stop() { this.stopped = true; }
  getStderr() { return ""; }
  emit(event: unknown) { this.listener?.(event); }
}

function watchArtifact(artifactPath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("skills/poteto-mode/scripts/watch-poteto-job.mjs"), artifactPath, "1000"]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => { resolve({ code, stdout, stderr }); });
  });
}

test("a poteto job returns immediately, accepts steering, and reports its final answer", async () => {
  const client = new FakeRpcClient();
  const jobs = createPotetoJobs(() => client);
  const launched = await jobs.start({ task: "Investigate the bug", cwd: "/tmp", promptFile: "/tmp/agent.md" });
  assert.equal(launched.state, "running");
  assert.deepEqual(client.prompts, ["Delegated task:\nInvestigate the bug"]);
  assert.equal(await jobs.steer(launched.id, "Check the logs first"), "queued");
  assert.deepEqual(client.steers, ["Check the logs first"]);
  client.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Found the cause" }], stopReason: "stop" } });
  client.emit({ type: "agent_settled" });
  assert.deepEqual(jobs.status(launched.id), { id: launched.id, state: "completed", task: "Investigate the bug", result: "Found the cause" });
  await jobs.shutdown();
  assert.equal(client.stopped, true);
});


test("a poteto job persists an owner-only status artifact through completion", async () => {
  const statusDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "poteto-jobs-test-"));
  try {
    const client = new FakeRpcClient();
    const jobs = createPotetoJobs(() => client);
    const launched = await jobs.start({ task: "Persist lifecycle", cwd: "/tmp", promptFile: "/tmp/agent.md", statusDirectory });

    assert.equal(launched.state, "running");
    const artifactPath = launched.statusArtifactPath;
    assert.deepEqual(JSON.parse(await fsp.readFile(artifactPath, "utf8")), {
      schemaVersion: 1,
      jobId: launched.id,
      state: "running",
    });
    assert.equal((await fsp.stat(path.dirname(artifactPath))).mode & 0o077, 0);
    assert.equal((await fsp.stat(artifactPath)).mode & 0o077, 0);
    const observer = watchArtifact(artifactPath);

    client.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Persisted result" }], stopReason: "stop" } });
    client.emit({ type: "agent_settled" });
    await jobs.stop(launched.id);
    const observerResult = await observer;
    assert.equal(observerResult.code, 0);
    assert.match(observerResult.stdout, /completed/);

    assert.deepEqual(JSON.parse(await fsp.readFile(artifactPath, "utf8")), {
      schemaVersion: 1,
      jobId: launched.id,
      state: "completed",
      result: "Persisted result",
    });
  } finally {
    await fsp.rm(statusDirectory, { recursive: true, force: true });
  }
});

test("the watcher distinguishes completed, failed, stopped, timed-out, and malformed artifacts", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "poteto-watcher-test-"));
  const artifactPath = path.join(directory, "status.json");
  const watcherPath = path.resolve("skills/poteto-mode/scripts/watch-poteto-job.mjs");
  const watch = () => spawnSync(process.execPath, [watcherPath, artifactPath, "50"], { encoding: "utf8" });
  try {
    await fsp.writeFile(artifactPath, '{"schemaVersion":1,"jobId":"poteto-test","state":"completed","result":"done"}\n', { mode: 0o600 });
    const completed = watch();
    assert.equal(completed.status, 0);
    assert.match(completed.stdout, /completed/);

    await fsp.writeFile(artifactPath, '{"schemaVersion":1,"jobId":"poteto-test","state":"failed","error":"boom"}\n', { mode: 0o600 });
    assert.equal(watch().status, 1);

    await fsp.writeFile(artifactPath, '{"schemaVersion":1,"jobId":"poteto-test","state":"stopped","error":"operator"}\n', { mode: 0o600 });
    assert.equal(watch().status, 2);

    await fsp.writeFile(artifactPath, '{"schemaVersion":1,"jobId":"poteto-test","state":"running"}\n', { mode: 0o600 });
    assert.equal(watch().status, 4);

    await fsp.writeFile(artifactPath, "{invalid\n", { mode: 0o600 });
    assert.equal(watch().status, 3);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("shutdown waits until the child process has actually stopped", async () => {
  const client = new FakeRpcClient();
  let releaseStop: (() => void) | undefined;
  client.stop = async () => { await new Promise<void>((resolve) => { releaseStop = resolve; }); client.stopped = true; };
  const jobs = createPotetoJobs(() => client);
  const { id } = await jobs.start({ task: "Investigate", cwd: "/tmp", promptFile: "/tmp/agent.md" });
  let returned = false;
  const shutdown = jobs.shutdown().then(() => { returned = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  releaseStop?.();
  await shutdown;
  assert.equal(client.stopped, true);
  assert.equal(jobs.status(id).state, "stopped");
  await assert.rejects(jobs.steer(id, "Too late"), /not running/);
});
