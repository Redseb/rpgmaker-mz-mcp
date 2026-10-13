import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectInlineImages } from '../src/utils/inlineImages.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rmmz-inline-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function image(name: string, size: number) {
  const path = join(dir, name);
  await writeFile(path, Buffer.alloc(size, 1));
  return path;
}

describe('bounded inline screenshots', () => {
  it('keeps images within the aggregate budget and leaves omitted files intact', async () => {
    const files = [await image('a.png', 5), await image('b.png', 6), await image('c.png', 3)];
    const result = await collectInlineImages(files, { maxBytes: 8, maxImages: 8 });
    expect(result.images.map((item) => Buffer.from(item.data, 'base64').length)).toEqual([5, 3]);
    expect(result.metadata).toMatchObject({
      attached: 2,
      bytes: 8,
      omitted: [{ path: files[1], reason: 'aggregate_byte_limit' }],
    });
    expect((await readFile(files[1])).length).toBe(6);
  });

  it('caps the number of images independently of their byte size', async () => {
    const files = [await image('a.png', 1), await image('b.png', 1), await image('c.png', 1)];
    const result = await collectInlineImages(files, { maxBytes: 100, maxImages: 2 });
    expect(result.images).toHaveLength(2);
    expect(result.metadata.omitted).toEqual([{ path: files[2], reason: 'image_count_limit' }]);
  });

  it('reports unreadable files while still attaching later readable files', async () => {
    const good = await image('good.png', 3);
    const result = await collectInlineImages([join(dir, 'missing.png'), dir, good]);
    expect(result.images).toHaveLength(1);
    expect(result.metadata.omitted).toHaveLength(2);
    expect(result.metadata.bytes).toBe(3);
  });

  it('preserves an empty image result', async () => {
    const result = await collectInlineImages([]);
    expect(result.images).toEqual([]);
    expect(result.metadata.omitted).toEqual([]);
  });
});
