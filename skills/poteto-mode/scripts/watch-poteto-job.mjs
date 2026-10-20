#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 3_600_000;
const POLL_INTERVAL_MS = 200;

function usage() {
  console.error("Usage: watch-poteto-job.mjs <status-artifact-path> [timeout-ms]");
  process.exitCode = 64;
}

function parseTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw new Error(`Timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} milliseconds.`);
  }
  return timeout;
}

function parseStatus(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Malformed status JSON: ${String(cause)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || value.schemaVersion !== 1 || typeof value.jobId !== "string" || !value.jobId) {
    throw new Error("Malformed status JSON: expected schemaVersion 1 and a jobId.");
  }
  if (value.state === "running") return value;
  if (value.state === "completed" && typeof value.result === "string") return value;
  if ((value.state === "failed" || value.state === "stopped") && typeof value.error === "string") return value;
  throw new Error("Malformed status JSON: invalid state payload.");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const [artifactPath, timeoutArgument, extraArgument] = process.argv.slice(2);
  if (!artifactPath || extraArgument !== undefined) {
    usage();
    return;
  }

  let timeout;
  try {
    timeout = parseTimeout(timeoutArgument);
  } catch (cause) {
    console.error(String(cause));
    process.exitCode = 64;
    return;
  }

  const deadline = Date.now() + timeout;
  while (true) {
    let status;
    try {
      status = parseStatus(await readFile(artifactPath, "utf8"));
    } catch (cause) {
      console.error(String(cause));
      process.exitCode = 3;
      return;
    }

    if (status.state === "completed") {
      console.log(`Poteto job ${status.jobId} completed.`);
      return;
    }
    if (status.state === "failed") {
      console.error(`Poteto job ${status.jobId} failed: ${status.error}`);
      process.exitCode = 1;
      return;
    }
    if (status.state === "stopped") {
      console.error(`Poteto job ${status.jobId} stopped: ${status.error}`);
      process.exitCode = 2;
      return;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.error(`Timed out waiting for poteto job ${status.jobId}.`);
      process.exitCode = 4;
      return;
    }
    await delay(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

await main();
