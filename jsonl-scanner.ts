// Ported from OpenUsage's JSONLStreamingReader and JSONLScanning (MIT).
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const READ_CHUNK_BYTES = 64 * 1024;
export const MAX_RECORD_BYTES = 1024 * 1024;
export interface DiscoveredFile {
  path: string;
  size: number;
  mtime: number;
}

export async function jsonlFiles(directory: string, cancelled: () => boolean) {
  const files: DiscoveredFile[] = [];
  let partial = false;
  const root = await fs.realpath(directory).catch(() => directory);
  const directories = [root];
  while (directories.length) {
    if (cancelled()) throw new Error("Scan cancelled");
    const dir = directories.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") partial = true;
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) directories.push(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = await fs.stat(file);
          files.push({ path: file, size: stat.size, mtime: stat.mtimeMs });
        } catch {
          partial = true;
        }
      }
    }
  }
  return { files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), partial };
}

/** Complete scan, bounded memory per record. Oversized records cannot swallow the next line. */
export async function readJSONL<T>(
  file: DiscoveredFile,
  parse: (line: string) => T[],
  cancelled: () => boolean,
) {
  const items: T[] = [];
  let fragments: Buffer[] = [],
    size = 0,
    discarding = false,
    oversized = 0;
  const finish = () => {
    if (!discarding && size) {
      const line = (fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, size)).toString("utf8");
      for (const item of parse(line)) items.push(item);
    }
    fragments = [];
    size = 0;
    discarding = false;
  };
  // Read the discovered snapshot; an append is detected by the next size/mtime check.
  const stream = createReadStream(file.path, {
    highWaterMark: READ_CHUNK_BYTES,
    ...(file.size ? { end: file.size - 1 } : {}),
  });
  try {
    for await (const raw of stream) {
      if (cancelled()) throw new Error("Scan cancelled");
      const chunk = raw as Buffer;
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset),
          end = newline < 0 ? chunk.length : newline;
        if (!discarding) {
          if (end - offset > MAX_RECORD_BYTES - size) {
            oversized++;
            discarding = true;
            fragments = [];
            size = 0;
          } else {
            fragments.push(chunk.subarray(offset, end));
            size += end - offset;
          }
        }
        if (newline >= 0) {
          finish();
          offset = newline + 1;
        } else offset = chunk.length;
      }
    }
    finish();
    return { items, partial: oversized > 0, oversizedRecords: oversized };
  } finally {
    stream.destroy();
  }
}
