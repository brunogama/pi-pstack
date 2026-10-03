import assert from "node:assert/strict";
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
