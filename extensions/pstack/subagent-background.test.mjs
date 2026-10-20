import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { test } from 'node:test';
import pstack from './index.ts';

function captureSubagent(executeTool) {
  const tools = new Map();
  pstack({
    on() {},
    registerCommand() {},
    registerTool(tool) { tools.set(tool.name, tool); },
    sendMessage() {},
  });
  const context = {
    cwd: process.cwd(),
    hasUI: false,
    model: undefined,
    executeTool,
  };
  return { tool: tools.get('subagent'), context };
}

const task = { agent: 'comment-sicko', task: 'Review these comments.' };

test('subagent returns a background job ID instead of waiting for a single child', async () => {
  let command;
  const { tool, context } = captureSubagent(async (name, input) => {
    assert.equal(name, 'bash_bg');
    command = input.command;
    return { result: { content: [{ type: 'text', text: 'Command running in background with ID: shell-test. Output is being written to: /tmp/pi-bg/shell-test.log' }] }, isError: false };
  });
  const result = await tool.execute('call', task, undefined, undefined, context);
  try {
    assert.equal(result.details.jobId, 'shell-test');
    assert.match(result.content[0].text, /jobs output/);
    const specPath = /'([^']+\/stack\.json)'$/.exec(command)?.[1];
    assert.ok(specPath);
    const spec = JSON.parse(await readFile(specPath, 'utf8'));
    assert.equal(spec.mode, 'single');
    assert.equal(spec.tasks[0].agent, 'comment-sicko');
  } finally {
    const specPath = /'([^']+\/stack\.json)'$/.exec(command)?.[1];
    if (specPath) await rm(specPath.replace(/\/stack\.json$/, ''), { recursive: true, force: true });
  }
});

test('chain specs preserve ordered tasks for the background runner', async () => {
  let command;
  const { tool, context } = captureSubagent(async (_name, input) => {
    command = input.command;
    return { result: { content: [{ type: 'text', text: 'Command running in background with ID: shell-chain. Output is being written to: /tmp/pi-bg/shell-chain.log' }] }, isError: false };
  });
  await tool.execute('call', { chain: [task, { ...task, task: 'Then {previous}' }] }, undefined, undefined, context);
  const specPath = /'([^']+\/stack\.json)'$/.exec(command)?.[1];
  assert.ok(specPath);
  try {
    const spec = JSON.parse(await readFile(specPath, 'utf8'));
    assert.equal(spec.mode, 'chain');
    assert.deepEqual(spec.tasks.map(item => item.task), ['Review these comments.', 'Then {previous}']);
  } finally {
    await rm(specPath.replace(/\/stack\.json$/, ''), { recursive: true, force: true });
  }
});

test('missing background extension fails rather than falling back to a foreground child', async () => {
  const { tool, context } = captureSubagent(async () => { return { result: { content: [{ type: 'text', text: 'Unknown tool bash_bg' }] }, isError: true }; });
  await assert.rejects(tool.execute('call', task, undefined, undefined, context), /Unknown tool bash_bg/);
});
