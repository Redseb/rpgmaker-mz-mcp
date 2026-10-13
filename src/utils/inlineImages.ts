import { open } from 'fs/promises';

/** Raw PNG bytes; base64 encoding adds up to one third (32 MiB on the wire). */
export const MAX_INLINE_IMAGE_BYTES = 24 * 1024 * 1024;
export const MAX_INLINE_IMAGES = 8;

/** Bound the optional image payload without removing the original file artifacts. */
export async function collectInlineImages(
  files: string[],
  limits = { maxBytes: MAX_INLINE_IMAGE_BYTES, maxImages: MAX_INLINE_IMAGES },
) {
  const images: Array<{ type: 'image'; mimeType: 'image/png'; data: string }> = [];
  const omitted: Array<{ path: string; reason: string }> = [];
  let bytes = 0;
  for (const file of files) {
    if (images.length >= limits.maxImages) {
      omitted.push({ path: file, reason: 'image_count_limit' });
      continue;
    }
    try {
      const handle = await open(file, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('Not a file');
        if (info.size > limits.maxBytes - bytes) {
          omitted.push({ path: file, reason: 'aggregate_byte_limit' });
          continue;
        }
        // Read at most the accepted size plus a sentinel byte, even if another
        // process grows the file after stat. Never allocate an unbounded file.
        const buffer = Buffer.alloc(info.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = await handle.read(buffer, length, buffer.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length > info.size) {
          omitted.push({ path: file, reason: 'file_changed_during_read' });
          continue;
        }
        bytes += length;
        images.push({
          type: 'image',
          mimeType: 'image/png',
          data: buffer.subarray(0, length).toString('base64'),
        });
      } finally {
        await handle.close();
      }
    } catch (error) {
      omitted.push({ path: file, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    images,
    metadata: { attached: images.length, bytes, omitted, ...limits },
  };
}
