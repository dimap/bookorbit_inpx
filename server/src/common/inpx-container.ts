import { open, readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { createCbzZipEntryReadStream, extractCbzZipEntry, readCbzZipIndex, type CbzZipEntry } from './cbz-zip-reader';
import { createSevenZipTempId, getSevenZip } from './sevenzip';

export type InpxContainerKind = 'zip' | '7z';

export interface InpxContainerEntry {
  name: string;
  size: number;
}

export interface InpxContainer {
  readonly kind: InpxContainerKind;
  readonly entries: InpxContainerEntry[];
  readEntry(name: string): Promise<Buffer | null>;
  readEntryStream(name: string): Promise<{ stream: NodeJS.ReadableStream; size: number } | null>;
  close(): Promise<void>;
}

const SEVENZIP_MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);

/**
 * 7z is expanded through a WASM module that holds the archive and its output in memory, so it
 * carries a hard practical cap. Flibusta companion shards are routinely larger than the 512 MB
 * release-archive bound, so the INPX reader is more generous; very large archives still need a
 * machine with enough RAM.
 */
const MAX_SEVENZIP_ARCHIVE_BYTES = 2 * 1024 ** 3;

/**
 * Opens an INPX container (ZIP or 7z) for listing and on-demand entry reads. The parser and the
 * import enrichment open their own container and call `close()` when done; the serving path uses
 * {@link getCachedInpxContainer} so it does not re-read a large archive per request.
 */
export async function openInpxContainer(archivePath: string): Promise<InpxContainer> {
  const kind = await detectContainerKind(archivePath);
  return kind === 'zip' ? openZipContainer(archivePath) : openSevenZipContainer(archivePath);
}

// ── Serving cache ─────────────────────────────────────────────────────────────

const containerCache = new Map<string, { container: InpxContainer; lastUsed: number }>();
const MAX_CACHED_CONTAINERS = 3;

/**
 * A container for the serving path, reused across requests. Entries are not evicted eagerly (a
 * request may hold the container between resolution and stream), so memory from closed-over 7z
 * extractions is bounded only by the cap below; ZIP containers hold only the central directory.
 */
export async function getCachedInpxContainer(archivePath: string): Promise<InpxContainer> {
  const cached = containerCache.get(archivePath);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.container;
  }

  const container = await openInpxContainer(archivePath);
  containerCache.set(archivePath, { container, lastUsed: Date.now() });
  if (containerCache.size > MAX_CACHED_CONTAINERS) {
    const oldest = [...containerCache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (oldest) containerCache.delete(oldest[0]);
  }
  return container;
}

// ── Detection ─────────────────────────────────────────────────────────────────

async function detectContainerKind(archivePath: string): Promise<InpxContainerKind> {
  const handle = await open(archivePath, 'r');
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, 8, 0);
    const signature = header.subarray(0, bytesRead);
    if (signature.length >= 2 && signature[0] === 0x50 && signature[1] === 0x4b) return 'zip';
    if (signature.length >= 6 && signature.subarray(0, 6).equals(SEVENZIP_MAGIC)) return '7z';
    const hex = [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    throw new Error(`Unsupported INPX container: expected ZIP or 7z, got signature "${hex}"`);
  } finally {
    await handle.close();
  }
}

// ── ZIP ───────────────────────────────────────────────────────────────────────

async function openZipContainer(archivePath: string): Promise<InpxContainer> {
  const index = await readCbzZipIndex(archivePath);
  if (index) {
    const byName = new Map<string, CbzZipEntry>();
    for (const entry of index.entries) byName.set(normalizeEntryName(entry.name), entry);
    const entries = [...byName.values()].map((entry) => ({ name: normalizeEntryName(entry.name), size: entry.uncompressedSize }));
    return {
      kind: 'zip',
      entries,
      readEntry: (name) => {
        const entry = byName.get(normalizeEntryName(name));
        return entry ? extractCbzZipEntry(archivePath, entry) : Promise.resolve(null);
      },
      readEntryStream: (name) => {
        const entry = byName.get(normalizeEntryName(name));
        if (!entry) return Promise.resolve(null);
        return Promise.resolve({ stream: createCbzZipEntryReadStream(archivePath, entry), size: entry.uncompressedSize });
      },
      close: () => Promise.resolve(),
    };
  }

  // Fallback for ZIPs the byte-offset reader cannot parse (e.g. trailing bytes after the central
  // directory). unzipper is more lenient about the end-of-archive record.
  return openZipContainerWithUnzipper(archivePath);
}

async function openZipContainerWithUnzipper(archivePath: string): Promise<InpxContainer> {
  const { Open } = await import('unzipper');
  const archive = await Open.file(archivePath);
  const byName = new Map<string, { name: string; size: number }>();
  for (const file of archive.files) {
    const normalized = normalizeEntryName(file.path);
    if (!byName.has(normalized)) byName.set(normalized, { name: normalized, size: file.uncompressedSize });
  }
  return {
    kind: 'zip',
    entries: [...byName.values()],
    readEntry: (name) => {
      const target = normalizeEntryName(name);
      const file = archive.files.find((candidate) => normalizeEntryName(candidate.path) === target);
      return file ? file.buffer() : Promise.resolve(null);
    },
    readEntryStream: (name) => {
      const target = normalizeEntryName(name);
      const file = archive.files.find((candidate) => normalizeEntryName(candidate.path) === target);
      if (!file) return Promise.resolve(null);
      return Promise.resolve({ stream: file.stream(), size: file.uncompressedSize });
    },
    close: () => Promise.resolve(),
  };
}

// ── 7z ────────────────────────────────────────────────────────────────────────

async function openSevenZipContainer(archivePath: string): Promise<InpxContainer> {
  const { size } = await stat(archivePath);
  if (size > MAX_SEVENZIP_ARCHIVE_BYTES) {
    throw new Error(
      `INPX 7z archive is ${size} bytes, above the ${MAX_SEVENZIP_ARCHIVE_BYTES} byte limit supported for 7z; use a ZIP-format INPX archive instead`,
    );
  }

  const sevenZip = await getSevenZip();
  const workingDirectory = `/${createSevenZipTempId('inpx')}`;
  const archiveName = `${workingDirectory}/archive.7z`;

  try {
    sevenZip.FS.mkdir(workingDirectory);
    const bytes = new Uint8Array(await readFile(archivePath));
    const fd = sevenZip.FS.open(archiveName, 'w+');
    sevenZip.FS.write(fd, bytes, 0, bytes.length);
    sevenZip.FS.close(fd);

    try {
      sevenZip.callMain(['x', archiveName, `-o${workingDirectory}/out`, '-y', '-p']);
    } catch {
      throw new Error('INPX 7z archive could not be extracted (it may be password protected)');
    }

    const collected = collectSevenZipEntries(sevenZip, `${workingDirectory}/out`, '');
    const byName = new Map(collected.map((entry) => [normalizeEntryName(entry.relativePath), entry]));

    return {
      kind: '7z',
      entries: [...byName.values()].map((entry) => ({ name: normalizeEntryName(entry.relativePath), size: entry.sizeBytes })),
      readEntry: (name) => {
        const entry = byName.get(normalizeEntryName(name));
        if (!entry) return Promise.resolve(null);
        return Promise.resolve(Buffer.from(sevenZip.FS.readFile(entry.path)));
      },
      readEntryStream: (name) => {
        const entry = byName.get(normalizeEntryName(name));
        if (!entry) return Promise.resolve(null);
        const buffer = Buffer.from(sevenZip.FS.readFile(entry.path));
        return Promise.resolve({ stream: Readable.from(buffer), size: buffer.length });
      },
      close: () => Promise.resolve(removeSevenZipDirectory(sevenZip, workingDirectory)),
    };
  } catch (err) {
    removeSevenZipDirectory(sevenZip, workingDirectory);
    throw err;
  }
}

function collectSevenZipEntries(
  sevenZip: Awaited<ReturnType<typeof getSevenZip>>,
  path: string,
  relativePath: string,
): Array<{ relativePath: string; path: string; sizeBytes: number }> {
  const collected: Array<{ relativePath: string; path: string; sizeBytes: number }> = [];
  let names: string[];
  try {
    names = sevenZip.FS.readdir(path).filter((name) => name !== '.' && name !== '..');
  } catch {
    return collected;
  }

  for (const name of names) {
    const child = `${path}/${name}`;
    const childRelative = relativePath ? `${relativePath}/${name}` : name;
    try {
      const stats = sevenZip.FS.stat(child);
      if (sevenZip.FS.isDir(stats.mode)) {
        collected.push(...collectSevenZipEntries(sevenZip, child, childRelative));
        continue;
      }
      collected.push({ relativePath: childRelative, path: child, sizeBytes: stats.size });
    } catch {
      continue;
    }
  }
  return collected;
}

function removeSevenZipDirectory(sevenZip: Awaited<ReturnType<typeof getSevenZip>>, path: string): void {
  let names: string[];
  try {
    names = sevenZip.FS.readdir(path).filter((name) => name !== '.' && name !== '..');
  } catch {
    return;
  }
  for (const name of names) {
    const child = `${path}/${name}`;
    try {
      sevenZip.FS.unlink(child);
    } catch {
      removeSevenZipDirectory(sevenZip, child);
    }
  }
  try {
    sevenZip.FS.rmdir(path);
  } catch {
    // best effort
  }
}

export function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\/+/, '');
}
