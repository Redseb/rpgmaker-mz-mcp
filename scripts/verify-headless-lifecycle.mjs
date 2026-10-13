/* global AbortController, AbortSignal, fetch, URL */
/** Optional real-engine protocol check. Build first; point the env var at a licensed test project. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = process.env.RPGMAKER_MCP_TEST_PROJECT;
assert(project, 'Set RPGMAKER_MCP_TEST_PROJECT to an isolated, licensed RPG Maker MZ project.');
const system = JSON.parse(await readFile(join(project, 'data', 'System.json'), 'utf8'));
const out = await mkdtemp(join(tmpdir(), 'rmmz-lifecycle-'));
const serverFile = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const child = spawn(process.execPath, [serverFile], {
  env: { ...process.env, RPGMAKER_PROJECT_PATH: project },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
let nextId = 0;
let stderr = '';
let buffer = '';
const pending = new Map();
const progress = [];
const exited = new Promise((resolve) =>
  child.once('exit', (code, signal) => resolve({ code, signal })),
);
child.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk).slice(-10000);
});
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf('\n');
    if (end < 0) break;
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.method === 'notifications/progress') progress.push(message.params);
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  }
});
function send(message) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}
function request(method, params) {
  const id = ++nextId;
  const promise = new Promise((resolve) => pending.set(id, resolve));
  send({ id, method, params });
  return { id, promise };
}
async function bounded(promise, label, ms = 60000) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(ms, undefined, { signal: controller.signal }).then(() => {
        throw new Error(`${label} timed out. ${stderr}`);
      }),
    ]);
  } finally {
    controller.abort();
  }
}
async function call(name, args) {
  const response = await bounded(request('tools/call', { name, arguments: args }).promise, name);
  assert(!response.error && !response.result?.isError, JSON.stringify(response));
  return response.result;
}
let receiveOrigin;
const observer = createServer((req, res) => {
  const origin = new URL(req.url, 'http://localhost').searchParams.get('origin');
  res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
  res.end('ok');
  if (origin) receiveOrigin?.(origin);
});
await new Promise((resolve) => observer.listen(0, '127.0.0.1', resolve));
const observerUrl = `http://127.0.0.1:${observer.address().port}/?origin=`;
async function hangingRun(token) {
  const observed = new Promise((resolve) => {
    receiveOrigin = resolve;
  });
  const run = request('tools/call', {
    name: 'run_playtest',
    arguments: {
      out,
      steps: [
        {
          action: 'eval',
          script: `fetch(${JSON.stringify(observerUrl)} + encodeURIComponent(location.origin)).then(() => new Promise(() => {}))`,
        },
      ],
    },
    _meta: { progressToken: token },
  });
  return { ...run, origin: await bounded(observed, 'pending eval startup') };
}
async function assertServerClosed(origin) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(origin, { signal: AbortSignal.timeout(300) });
    } catch {
      return;
    }
    await delay(100);
  }
  assert.fail(`Owned static server still reachable: ${origin}`);
}
try {
  const initialized = await bounded(
    request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'headless-lifecycle-check', version: '1.0.0' },
    }).promise,
    'initialize',
  );
  assert(!initialized.error, JSON.stringify(initialized));
  send({ method: 'notifications/initialized' });
  const rendered = await call('render_map', { mapId: system.startMapId, out, inline: true });
  assert.equal(rendered.content[0].type, 'text');
  assert.equal(rendered.content.filter((item) => item.type === 'image').length, 1);
  const renderResult = JSON.parse(rendered.content[0].text);
  assert.equal(renderResult.problems.length, 0, JSON.stringify(renderResult.problems));
  const played = await call('run_playtest', {
    out,
    inline: true,
    steps: [
      { action: 'load', mapId: system.startMapId, x: system.startX, y: system.startY },
      { action: 'eval', script: '$gameMap.mapId()' },
      ...Array.from({ length: 9 }, (_, index) => ({ action: 'screenshot', name: `shot${index}` })),
    ],
  });
  const playResult = JSON.parse(played.content[0].text);
  assert.equal(playResult.ok, true, JSON.stringify(playResult));
  assert.equal(playResult.steps[1].value, system.startMapId);
  assert.equal(playResult.problems.length, 0, JSON.stringify(playResult.problems));
  assert.equal(playResult.screenshots.length, 9);
  assert.equal(played.content.filter((item) => item.type === 'image').length, 8);
  assert.equal(
    JSON.parse(played.content.at(-1).text).inlineImages.omitted[0].reason,
    'image_count_limit',
  );
  const cancelled = await hangingRun('cancel');
  await delay(5200);
  assert(
    progress.some(
      (item) => item.progressToken === 'cancel' && item.progress > 1 && item.progress < 2,
    ),
    'Missing heartbeat during pending eval',
  );
  send({
    method: 'notifications/cancelled',
    params: { requestId: cancelled.id, reason: 'verify cancellation' },
  });
  await assertServerClosed(cancelled.origin);
  await call('get_project', {});
  const eof = await hangingRun('eof');
  child.stdin.end();
  const exit = await bounded(exited, 'EOF shutdown', 10000);
  assert.equal(exit.code, 0, stderr);
  await assertServerClosed(eof.origin);
  console.log(
    JSON.stringify(
      {
        ok: true,
        render: renderResult.path,
        screenshots: playResult.screenshots.length,
        inlineImages: 8,
        requestCancellation: true,
        progressHeartbeat: true,
        serverUsableAfterCancellation: true,
        eofShutdown: true,
        exit,
        artifacts: out,
      },
      null,
      2,
    ),
  );
} finally {
  observer.closeAllConnections();
  await new Promise((resolve) => observer.close(resolve));
  if (child.exitCode === null) {
    child.stdin.end();
    try {
      await bounded(exited, 'cleanup', 10000);
    } catch {
      child.kill();
    }
  }
}
