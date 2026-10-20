import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const MAX_TEXT = 50 * 1024;

async function runChild(cli, task) {
  const args = [...cli.args, '--mode', 'json', '--print', '--no-session', '--append-system-prompt', task.promptFile];
  if (task.model) args.push('--model', task.model);
  if (task.tools?.length) args.push('--tools', task.tools.join(','));
  args.push(`Delegated task:\n${task.task}`);
  const child = spawn(cli.command, args, { cwd: task.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let error = '';
  let stderr = '';
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const parse = line => {
    try {
      const event = JSON.parse(line);
      if (event.type !== 'message_end' || event.message?.role !== 'assistant') return;
      output = event.message.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') || output;
      if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') error = event.message.errorMessage || event.message.stopReason;
    } catch { /* Other extensions may print non-JSON diagnostics. */ }
  };
  child.stdout.on('data', chunk => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    lines.forEach(parse);
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-MAX_TEXT); });
  const code = await new Promise(resolve => {
    child.on('error', cause => { error = cause.message; });
    child.on('close', value => resolve(value ?? 1));
  });
  if (pending.trim()) parse(pending);
  return { agent: task.agent, text: output.slice(0, MAX_TEXT), failed: code !== 0 || Boolean(error), error: (error || (code !== 0 ? stderr : '')).slice(-MAX_TEXT) };
}

async function run(spec) {
  const tasks = spec.tasks;
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 8 || !['single', 'chain', 'parallel'].includes(spec.mode)) throw new Error('Invalid stack specification');
  if (spec.mode === 'single' && tasks.length !== 1) throw new Error('Single mode requires one task');
  const results = [];
  let failure;
  if (spec.mode === 'parallel') {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, async () => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await runChild(spec.cli, tasks[index]);
      }
      return undefined;
    }));
  } else {
    let previous = '';
    for (const [index, task] of tasks.entries()) {
      results[index] = await runChild(spec.cli, { ...task, task: task.task.replaceAll('{previous}', previous) });
      if (results[index].failed) {
        failure = `${spec.mode === 'chain' ? `Chain step ${index + 1}` : 'Task'} (${task.agent}) failed: ${results[index].error || results[index].text || 'no output'}`;
        break;
      }
      previous = results[index].text;
    }
  }
  process.stdout.write(`${JSON.stringify({ mode: spec.mode, results })}\n`);
  if (failure) throw new Error(failure);
  if (results.some(result => result.failed)) process.exitCode = 1;
}

const specPath = process.argv[2];
try {
  if (!specPath || !path.isAbsolute(specPath)) throw new Error('Expected an absolute stack specification path');
  const spec = JSON.parse(await readFile(specPath, 'utf8'));
  let terminating = false;
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    process.exitCode = 143;
    void (async () => {
      if (spec.cleanupDirectory) await rm(spec.cleanupDirectory, { recursive: true, force: true });
    })().catch(error => console.error(error)).finally(() => process.exit(143));
  };
  process.on('SIGTERM', terminate);
  try { await run(spec); }
  finally {
    if (!terminating) process.off('SIGTERM', terminate);
    if (spec.cleanupDirectory) await rm(spec.cleanupDirectory, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
