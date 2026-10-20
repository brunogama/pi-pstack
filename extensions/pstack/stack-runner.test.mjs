import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./stack-runner.mjs', import.meta.url));

function execute(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('stack runner resolves chain placeholders in order and returns final answer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-runner-test-'));
  try {
    const cli = path.join(root, 'fake-pi.mjs');
    const spec = path.join(root, 'stack.json');
    const prompt = path.join(root, 'agent.md');
    await writeFile(prompt, 'Agent prompt');
    await writeFile(cli, `const task = process.argv.at(-1).replace('Delegated task:\\n', '');
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:task}]}}));\n`);
    await writeFile(spec, JSON.stringify({ mode: 'chain', cli: { command: process.execPath, args: [cli] }, tasks: [
      { agent: 'one', task: 'first', cwd: root, promptFile: prompt },
      { agent: 'two', task: 'after {previous}', cwd: root, promptFile: prompt },
    ] }));
    const result = await execute(process.execPath, [runner, spec]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.results[1].text, 'after first');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stack runner stops a chain on a failed child', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-runner-failure-'));
  try {
    const cli = path.join(root, 'fake-pi.mjs');
    const spec = path.join(root, 'stack.json');
    const prompt = path.join(root, 'agent.md');
    await writeFile(prompt, 'Agent prompt');
    await writeFile(cli, `process.exit(1);\n`);
    await writeFile(spec, JSON.stringify({ mode: 'chain', cli: { command: process.execPath, args: [cli] }, tasks: [
      { agent: 'one', task: 'fail', cwd: root, promptFile: prompt },
      { agent: 'two', task: 'never', cwd: root, promptFile: prompt },
    ] }));
    const result = await execute(process.execPath, [runner, spec]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Chain step 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed chains retain successful step answers in the job log', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-chain-report-'));
  try {
    const cli = path.join(root, 'fake-pi.mjs');
    const spec = path.join(root, 'stack.json');
    const prompt = path.join(root, 'agent.md');
    await writeFile(prompt, 'Agent prompt');
    await writeFile(cli, `const task = process.argv.at(-1); if (task.includes('second')) process.exit(42);
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'first answer'}]}}));\n`);
    await writeFile(spec, JSON.stringify({ mode: 'chain', cli: { command: process.execPath, args: [cli] }, tasks: [
      { agent: 'one', task: 'first', cwd: root, promptFile: prompt },
      { agent: 'two', task: 'second', cwd: root, promptFile: prompt },
    ] }));
    const result = await execute(process.execPath, [runner, spec]);
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.results[0].text, 'first answer');
    assert.equal(report.results[1].failed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a child with a successful answer may write diagnostics to stderr', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-runner-stderr-'));
  try {
    const cli = path.join(root, 'fake-pi.mjs');
    const spec = path.join(root, 'stack.json');
    const prompt = path.join(root, 'agent.md');
    await writeFile(prompt, 'Agent prompt');
    await writeFile(cli, `console.error('startup warning'); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'ok'}]}}));\n`);
    await writeFile(spec, JSON.stringify({ mode: 'single', cli: { command: process.execPath, args: [cli] }, tasks: [
      { agent: 'one', task: 'work', cwd: root, promptFile: prompt },
    ] }));
    const result = await execute(process.execPath, [runner, spec]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).results[0].text, 'ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('termination removes private stack prompts and specification', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-runner-terminate-'));
  const cli = path.join(root, 'fake-pi.mjs');
  const spec = path.join(root, 'stack.json');
  const marker = path.join(root, 'child-started');
  let child;
  try {
    await writeFile(cli, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => {}, 1000);\n`);
    await writeFile(spec, JSON.stringify({ mode: 'single', cli: { command: process.execPath, args: [cli] }, cleanupDirectory: root, tasks: [
      { agent: 'one', task: 'long task', cwd: root, promptFile: cli },
    ] }));
    child = spawn(process.execPath, [runner, spec], { detached: true, stdio: 'ignore' });
    const deadline = Date.now() + 3000;
    const started = () => access(marker).catch(error => {
      if (Date.now() > deadline) throw error;
      return new Promise(resolve => setTimeout(resolve, 10)).then(started);
    });
    await started();
    const exited = new Promise(resolve => child.once('exit', resolve));
    process.kill(-child.pid, 'SIGTERM');
    await exited;
    await assert.rejects(access(root), { code: 'ENOENT' });
  } finally {
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
});
