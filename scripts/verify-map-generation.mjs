#!/usr/bin/env node
// Synthetic fixture only. Run after npm run build; no engine installation needed.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { blankMapData } from '../dist/tools/mapTools.js';

const project = await mkdtemp(join(tmpdir(), 'mz-generation-protocol-'));
const client = new Client({ name: 'generation-verification', version: '1.0.0' });
let transport;
const save = (name, value) => writeFile(join(project, 'data', name), JSON.stringify(value));
const read = async (name) => JSON.parse(await readFile(join(project, 'data', name), 'utf8'));
const snapshot = async () =>
  Promise.all(
    (await readdir(join(project, 'data')))
      .sort()
      .map(async (name) => [name, await readFile(join(project, 'data', name), 'utf8')]),
  );
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return JSON.parse(result.content.find((block) => block.type === 'text').text);
};

try {
  await mkdir(join(project, 'data'));
  await mkdir(join(project, 'img', 'tilesets'), { recursive: true });
  await writeFile(join(project, 'game.rmmzproject'), 'RPGMZ 1.0.0');
  await save('System.json', {});
  await save('MapInfos.json', [null, { id: 1, name: 'Source', parentId: 0, order: 1 }]);
  const source = blankMapData(5, 4, 1);
  source.data.fill(1536, 0, 20);
  await save('Map001.json', source);
  const flags = new Array(8192).fill(0);
  flags[0] = 16;
  flags[1537] = 15;
  await save('Tilesets.json', [
    null,
    {
      id: 1,
      name: 'Synthetic',
      flags,
      tilesetNames: ['', '', '', '', 'Synthetic', '', '', '', ''],
    },
  ]);
  await writeFile(
    join(project, 'img', 'tilesets', 'Synthetic.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, RPGMAKER_PROJECT_PATH: project },
    stderr: 'pipe',
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const name of ['generate_dungeon_map', 'generate_map_from_template']) {
    const tool = tools.find((tool) => tool.name === name);
    assert.ok(tool, `Missing ${name}`);
    assert.ok(tool.inputSchema.properties.dryRun, `Missing dryRun schema on ${name}`);
  }
  const dungeon = {
    name: 'Cave',
    tilesetId: 1,
    seed: 'protocol',
    width: 21,
    height: 17,
    roomCount: 3,
    tileProfile: { floorTileId: 1536, wallTileId: 1537 },
  };
  const template = { name: 'Copy', sourceMapId: 1, tileRemap: [{ from: 1536, to: 1538 }] };
  const before = await snapshot();
  for (const [name, args] of [
    ['generate_dungeon_map', dungeon],
    ['generate_map_from_template', template],
  ]) {
    const preview = await call(name, { ...args, dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.deepEqual(
      preview.wouldChange.map((change) => change.file),
      ['Map002.json', 'MapInfos.json'],
    );
    assert.deepEqual(await snapshot(), before);
  }
  const results = await Promise.all([
    call('create_map', { name: 'Blank' }),
    call('generate_dungeon_map', dungeon),
    call('generate_map_from_template', template),
  ]);
  assert.deepEqual(results.map((result) => result.mapId).sort(), [2, 3, 4]);
  assert.equal((await read('MapInfos.json')).filter(Boolean).length, 4);
  const copied = await read(`Map${String(results[2].mapId).padStart(3, '0')}.json`);
  assert.deepEqual(copied.data.slice(0, 20), new Array(20).fill(1538));
  assert.deepEqual(copied.events, [null]);
  assert.equal(results[1].layout.unreachablePassableCells, 0);
  assert.deepEqual(await read('Map001.json'), source);
  console.log(
    JSON.stringify({
      ok: true,
      tools: tools.length,
      checks: [
        'tool discovery',
        'both dry-run previews unchanged',
        'concurrent blank/dungeon/template IDs',
        'template remap persisted',
        'dungeon connectivity',
        'source preserved',
      ],
    }),
  );
} finally {
  await client.close();
  if (transport) await transport.close();
  const target = resolve(project);
  assert.ok(
    target.startsWith(resolve(tmpdir()) + sep) &&
      basename(target).startsWith('mz-generation-protocol-'),
  );
  await rm(target, { recursive: true, force: true });
}
