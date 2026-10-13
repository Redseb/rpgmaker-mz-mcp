import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { blankMapData } from '../dist/tools/mapTools.js';

// Creates its own JSON-only fixture; never opens a configured game or engine.
const root = await mkdtemp(path.join(tmpdir(), 'mz-analysis-protocol-'));
const client = new Client({ name: 'analysis-protocol-check', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  env: { ...getDefaultEnvironment(), RPGMAKER_PROJECT_PATH: root },
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', (chunk) => {
  stderr += chunk;
});
const command = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
const commands = [
  command(101, ['', 0, 0, 2, 'Keeper']),
  command(401, ['The forest gate opens.']),
  command(121, [1, 1, 0]),
  command(230, [10]),
  command(0),
];
async function save(name, data) {
  await writeFile(path.join(root, 'data', name), JSON.stringify(data));
}
async function snapshot() {
  const files = {};
  async function visit(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await visit(file);
      else
        files[path.relative(root, file)] = createHash('sha256')
          .update(await readFile(file))
          .digest('hex');
    }
  }
  await visit(root);
  return files;
}
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(result)}`);
  return JSON.parse(result.content.find((part) => part.type === 'text').text);
}

try {
  await mkdir(path.join(root, 'data'));
  await writeFile(path.join(root, 'game.rmmzproject'), 'RPGMZ 1.0.0');
  await save('System.json', {
    gameTitle: 'Analysis protocol fixture',
    startMapId: 1,
    switches: ['', 'Gate'],
    variables: ['', 'Count'],
    partyMembers: [],
  });
  for (const name of [
    'Actors',
    'Classes',
    'Items',
    'Weapons',
    'Armors',
    'Enemies',
    'Troops',
    'States',
    'Animations',
  ])
    await save(`${name}.json`, [null]);
  await save('Skills.json', [
    null,
    ...[10, 10, 10, 1000].map((value, index) => ({
      id: index + 1,
      name: `Hit ${index + 1}`,
      mpCost: 2,
      damage: { type: 1, formula: String(value) },
    })),
  ]);
  await save('CommonEvents.json', [
    null,
    { id: 1, name: 'Greeting', trigger: 0, switchId: 0, list: commands },
  ]);
  await save('Tilesets.json', [
    null,
    { id: 1, name: 'Fixture', flags: [16, 0, 15], tilesetNames: [] },
  ]);
  await save('MapInfos.json', [null, { id: 1, name: 'Village' }, { id: 2, name: 'Forest' }]);
  for (let id = 1; id <= 2; id++) {
    const map = blankMapData(3, 2, 1);
    map.data.fill(1, 0, 6);
    if (id === 1)
      map.events = [
        null,
        {
          id: 1,
          name: 'Keeper',
          x: 0,
          y: 0,
          note: '',
          pages: [
            {
              conditions: { switch1Valid: true, switch1Id: 1 },
              list: [...commands.slice(0, -1), command(201, [0, 2, 0, 0, 2, 0]), command(0)],
            },
          ],
        },
      ];
    await save(`Map00${id}.json`, map);
  }
  const before = await snapshot();
  await client.connect(transport);
  const listed = (await client.listTools()).tools;
  const expected = {
    get_project_overview: [],
    analyze_transfer_graph: ['removeMapId'],
    explain_state_id: ['type', 'id'],
    outline_event: ['target'],
    analyze_database_balance: ['category', 'thresholdSd'],
    search_project: ['query', 'limit'],
    find_duplicate_event_blocks: ['minLength', 'limit'],
    analyze_map_layout: ['mapId', 'start', 'maxComponents'],
  };
  assert.equal(listed.length, 136);
  assert.ok(!listed.some((tool) => tool.name === 'analyze_project'));
  for (const [name, keys] of Object.entries(expected)) {
    const tool = listed.find((tool) => tool.name === name);
    assert.ok(tool, name);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), keys.sort(), name);
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  }
  assert.equal((await call('get_project_overview')).counts.maps, 2);
  assert.deepEqual((await call('analyze_transfer_graph')).reachable, [1, 2]);
  const state = await call('explain_state_id', { type: 'switch', id: 1 });
  assert.equal(state.writers.length, 2);
  assert.equal(state.readers.length, 1);
  assert.match(
    (await call('outline_event', { target: { type: 'map_event', mapId: 1, eventId: 1 } })).outline,
    /Keeper/,
  );
  assert.equal(
    (await call('analyze_database_balance', { category: 'skills' })).categories[0].outliers[0].id,
    4,
  );
  assert.ok((await call('search_project', { query: 'forest' })).total > 0);
  assert.ok((await call('find_duplicate_event_blocks')).total > 0);
  assert.equal(
    (await call('analyze_map_layout', { mapId: 1, start: { x: 0, y: 0 } })).reachableCells,
    6,
  );
  // Keep the existing ID-usage tool rather than expose a redundant usage alias.
  assert.ok((await call('list_allocated_ids', { type: 'switch', id: 1 })).referenceCount > 0);
  for (const [name, args] of [
    ['explain_state_id', { type: 'common_event', id: 1 }],
    ['outline_event', { target: { type: 'map_event', mapId: 1 } }],
    ['search_project', {}],
    ['analyze_database_balance', { thresholdSd: 0 }],
    ['analyze_map_layout', { mapId: 1, start: { x: 3, y: 0 } }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name} must reject ${JSON.stringify(args)}`);
  }
  assert.deepEqual(await snapshot(), before, 'Analysis changed fixture files or created caches');
  console.log(
    `Analysis stdio protocol: 8 focused tools, schema rejection, existing ID usage, and ${Object.keys(before).length} unchanged files verified.`,
  );
} catch (error) {
  console.error(stderr);
  throw error;
} finally {
  await client.close();
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.ok(path.basename(resolved).startsWith('mz-analysis-protocol-'));
  await rm(resolved, { recursive: true, force: true });
}
