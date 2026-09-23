import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { inflateRawSync } from 'zlib';
import { exportWeb, exportToolDefinitions, ExportWebResult } from '../src/tools/exportTools.js';
import { crc32 } from '../src/utils/zip.js';

async function put(root: string, rel: string, content: string | Buffer = ''): Promise<void> {
  const p = join(root, ...rel.split('/'));
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content);
}

/** Minimal project with used + unused assets in every prunable kind. */
async function scaffoldProject(root: string): Promise<string> {
  const dir = join(root, 'Game');
  await put(dir, 'game.rmmzproject', 'RPGMZ 1.0.0');
  await put(dir, 'index.html', '<!DOCTYPE html><title>Game</title>');
  await put(dir, 'css/game.css', 'body{}');
  await put(dir, 'fonts/mplus-1m-regular.woff', 'font');
  await put(dir, 'icon/icon.png', 'icon');
  await put(dir, 'js/main.js', 'const x = "main";');
  // Engine core hard-codes a default battleback name.
  await put(dir, 'js/rmmz_sprites.js', 'return "Grassland";');
  await put(
    dir,
    'js/plugins.js',
    'var $plugins = [{"name":"Portraits","status":true,"description":"","parameters":{"Frame":"UiFrame","List":"[\\"{\\\\\\"img\\\\\\":\\\\\\"NestedPic\\\\\\"}\\"]"}}];',
  );
  await put(
    dir,
    'js/plugins/Portraits.js',
    "/*:\n * @param Cursor\n * @default CursorPic\n */\nImageManager.loadPicture('HardCodedPic');",
  );
  await put(
    dir,
    'data/System.json',
    JSON.stringify({
      title1Name: 'Castle',
      titleBgm: { name: 'Theme1', volume: 90, pitch: 100, pan: 0 },
      advanced: { screenWidth: 1280, screenHeight: 720 },
    }),
  );
  await put(
    dir,
    'data/Actors.json',
    JSON.stringify([
      null,
      { id: 1, characterName: '!$Hero', faceName: 'Hero', note: '<Portrait: BustHero>' },
    ]),
  );
  await put(dir, 'data/Enemies.json', JSON.stringify([null, { id: 1, battlerName: 'Slime' }]));
  await put(dir, 'data/tilecatalog/World_A2.json', '{}'); // non-runtime subfolder → not copied
  await put(dir, 'effects/Heal.efkefc', 'efk');
  await put(dir, 'effects/Texture/Unused_Tex.png', 'tex'); // kept: effects/ is wholesale
  await put(dir, 'save/file1.rmmzsave', 'save'); // never copied

  await put(dir, 'img/system/Window.png', 'win');
  await put(dir, 'img/system/Unreferenced.png', 'sys'); // system always kept
  await put(dir, 'img/characters/!$Hero.png', 'c');
  await put(dir, 'img/characters/Villager.png', 'c'); // unused
  await put(dir, 'img/faces/Hero.png', 'f');
  await put(dir, 'img/enemies/Slime.png', 'e');
  await put(dir, 'img/sv_enemies/Slime.png', 'e');
  await put(dir, 'img/enemies/Bat.png', 'e'); // unused
  await put(dir, 'img/titles1/Castle.png', 't');
  await put(dir, 'img/battlebacks1/Grassland.png', 'b');
  await put(dir, 'img/pictures/UiFrame.png', 'p');
  await put(dir, 'img/pictures/NestedPic.png', 'p');
  await put(dir, 'img/pictures/HardCodedPic.png', 'p');
  await put(dir, 'img/pictures/CursorPic.png', 'p');
  await put(dir, 'img/pictures/BustHero.png', 'p');
  await put(dir, 'img/pictures/Unused.png', 'p');
  await put(dir, 'audio/bgm/Theme1.ogg', 'a'.repeat(4000)); // compressible → deflated
  await put(dir, 'audio/bgm/Theme1.m4a', 'a');
  await put(dir, 'audio/bgm/Theme2.ogg', 'a'); // unused
  await put(dir, 'img/.DS_Store', 'junk');
  return dir;
}

/** Read a ZIP's central directory + inflate each entry — enough to check what we wrote. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtra;
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(crc32(data), `${name} crc`).toBe(crc);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('export_web (integration)', () => {
  let root: string;
  let dir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rpgmz-export-'));
    dir = await scaffoldProject(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('prunes unreferenced assets and zips with index.html at the archive root', async () => {
    const out = join(root, 'web');
    const result = await exportWeb(dir, { outDir: out });

    expect(result.screen).toEqual({ width: 1280, height: 720 });
    expect(result.zipPath).toBe(`${out}.zip`);
    expect([...(result.droppedList ?? [])].sort()).toEqual([
      'audio/bgm/Theme2.ogg',
      'img/characters/Villager.png',
      'img/enemies/Bat.png',
      'img/pictures/Unused.png',
    ]);
    expect(result.dropped).toBe(4);
    expect(result.warnings).toBeUndefined();

    const zip = readZip(await readFile(result.zipPath!));
    const names = [...zip.keys()].sort();
    expect(names).toContain('index.html'); // at the root, not under a folder
    expect(zip.get('index.html')!.toString()).toContain('<title>Game</title>');
    expect(zip.get('audio/bgm/Theme1.ogg')!.toString()).toBe('a'.repeat(4000));
    expect(names.length).toBe(result.files);

    for (const kept of [
      'data/System.json',
      'data/Actors.json',
      'js/plugins.js',
      'js/plugins/Portraits.js',
      'css/game.css',
      'fonts/mplus-1m-regular.woff',
      'icon/icon.png',
      'effects/Heal.efkefc',
      'effects/Texture/Unused_Tex.png',
      'img/system/Window.png',
      'img/system/Unreferenced.png',
      'img/characters/!$Hero.png',
      'img/faces/Hero.png',
      'img/enemies/Slime.png',
      'img/sv_enemies/Slime.png',
      'img/titles1/Castle.png',
      'img/battlebacks1/Grassland.png', // core-js literal
      'img/pictures/UiFrame.png', // plugin parameter
      'img/pictures/NestedPic.png', // JSON nested in a plugin parameter
      'img/pictures/HardCodedPic.png', // plugin source literal
      'img/pictures/CursorPic.png', // plugin @default
      'img/pictures/BustHero.png', // notetag token
      'audio/bgm/Theme1.ogg',
      'audio/bgm/Theme1.m4a', // every extension variant of a kept track
    ]) {
      expect(names, kept).toContain(kept);
    }
    for (const absent of [
      'game.rmmzproject',
      'save/file1.rmmzsave',
      'data/tilecatalog/World_A2.json',
      'img/.DS_Store',
      '.rpgmaker-mcp-export',
    ]) {
      expect(names, absent).not.toContain(absent);
    }

    // The folder mirrors the zip (plus the re-export marker).
    expect(await readdir(out)).toContain('index.html');
  });

  it('prune: false copies every asset; zip: false writes no archive', async () => {
    const out = join(root, 'web-full');
    const result = await exportWeb(dir, { outDir: out, prune: false, zip: false });
    expect(result.dropped).toBe(0);
    expect(result.droppedList).toBeUndefined();
    expect(result.zipPath).toBeUndefined();
    expect(result.kept).toBe(19); // every img + audio file
    await expect(readFile(`${out}.zip`)).rejects.toThrow();
  });

  it('re-exports over a previous export but refuses a foreign non-empty folder', async () => {
    const out = join(root, 'web');
    await exportWeb(dir, { outDir: out, zip: false });
    await writeFile(join(out, 'stale.txt'), 'old');
    await exportWeb(dir, { outDir: out, zip: false });
    expect(await readdir(out)).not.toContain('stale.txt');

    const foreign = join(root, 'mine');
    await put(foreign, 'keep.txt', 'x');
    await expect(exportWeb(dir, { outDir: foreign })).rejects.toThrow(/not empty/);
    expect(await readFile(join(foreign, 'keep.txt'), 'utf8')).toBe('x');
  });

  it('refuses an outDir that is the project, contains it, or sits in a copied folder', async () => {
    await expect(exportWeb(dir, { outDir: dir })).rejects.toThrow(/contains it/);
    await expect(exportWeb(dir, { outDir: root })).rejects.toThrow(/contains it/);
    await expect(exportWeb(dir, { outDir: 'img/web' })).rejects.toThrow(/img\//);
    await expect(exportWeb(dir, { outDir: join(dir, 'audio', 'x') })).rejects.toThrow(/audio\//);
    // A non-source subfolder of the project is allowed (relative to the project root).
    const result = await exportWeb(dir, { outDir: 'dist/web', zip: false });
    expect(result.outDir).toBe(join(dir, 'dist', 'web'));
  });

  it('warns past itch.io’s 1000-file cap', async () => {
    for (let i = 0; i < 1000; i++) await put(dir, `js/libs/f${i}.js`, '');
    const result = await exportWeb(dir, { outDir: join(root, 'big'), zip: false });
    expect(result.warnings?.some((w) => w.includes('1000 files'))).toBe(true);
  });

  it('the export_web handler dispatches to exportWeb and is not a project mutation', async () => {
    const def = exportToolDefinitions.find((t) => t.name === 'export_web')!;
    expect(def.mutates).toBeUndefined();
    const result = (await def.handler(
      { projectPath: dir },
      { outDir: join(root, 'h'), zip: false },
    )) as ExportWebResult;
    expect(result.files).toBeGreaterThan(0);
  });
});
