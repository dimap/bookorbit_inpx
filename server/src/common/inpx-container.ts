import { createReadStream } from 'node:fs';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCbzZipEntryReadStream, extractCbzZipEntry, readCbzZipIndex, type CbzZipEntry } from './cbz-zip-reader';
import { extractSevenZipEntry, listSevenZipEntries } from './sevenzip-cli';

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
  const listed = await listSevenZipEntries(archivePath);
  const byName = new Map(listed.map((entry) => [normalizeEntryName(entry.name), entry]));

  return {
    kind: '7z',
    entries: [...byName.values()].map((entry) => ({ name: normalizeEntryName(entry.name), size: entry.size })),
    readEntry: async (name) => {
      const entry = byName.get(normalizeEntryName(name)) ?? byName.get(`fb2-${normalizeEntryName(name)}`);
      if (!entry) return null;
      const outDir = await mkdtemp(join(tmpdir(), 'bookorbit-inpx-7z-'));
      try {
        const target = await extractSevenZipEntry(archivePath, entry.name, outDir);
        if (!target) return null;
        return readFile(target);
      } finally {
        await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    readEntryStream: async (name) => {
      const entry = byName.get(normalizeEntryName(name)) ?? byName.get(`fb2-${normalizeEntryName(name)}`);
      if (!entry) return null;
      const outDir = await mkdtemp(join(tmpdir(), 'bookorbit-inpx-7z-'));
      const target = await extractSevenZipEntry(archivePath, entry.name, outDir);
      if (!target) {
        await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
        return null;
      }
      const stream = createReadStream(target);
      const cleanup = (): void => {
        void rm(outDir, { recursive: true, force: true }).catch(() => undefined);
      };
      stream.on('close', cleanup);
      stream.on('error', cleanup);
      return { stream, size: entry.size };
    },
    close: () => Promise.resolve(),
  };
}

export function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\/+/, '');
}
