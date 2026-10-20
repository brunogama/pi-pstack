import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
