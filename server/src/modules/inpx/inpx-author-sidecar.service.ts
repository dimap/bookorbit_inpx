import { Injectable, Logger } from '@nestjs/common';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import iconv from 'iconv-lite';

import { openInpxContainer } from '../../common/inpx-container';
import { htmlToPlainText } from '../../common/utils/html-to-text.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { InpxAuthorSidecar } from '../../db/schema';
import { authorEntryKeyFromPath, md5AuthorKeyCandidates } from './inpx.sidecar';
import { InpxAuthorSidecarInput, InpxRepository } from './inpx.repository';

const AUTHOR_EXTRAS_TTL_MS = 5 * 60_000;
const EXTRAS_CACHE_MAX = 2000;
const INDEX_ARCHIVE_LOG_EVERY = 25;

export interface InpxAuthorPortrait {
  data: Buffer;
  contentType: string;
}

/**
 * Reads the Flibusta/FLibrary author sidecars: bios from `etc/authors/*.zip|7z` and portraits from
 * `etc/authors/pictures/*.zip|7z`. Both are keyed by MD5(author name), so an index is built once per
 * library (see {@link buildIndex}) and lookups go through it. Reading is lazy: an author's bio or
 * portrait is only extracted when that author is actually viewed.
 */
@Injectable()
export class InpxAuthorSidecarService {
  private readonly logger = new Logger(InpxAuthorSidecarService.name);
  private readonly portraitCache = new Map<string, { value: InpxAuthorPortrait | null; expiresAt: number }>();
  private readonly bioCache = new Map<string, { value: string | null; expiresAt: number }>();

  constructor(private readonly repo: InpxRepository) {}

  /**
   * Lists the author shards once and stores MD5 key -> shard/entry rows. Skips when the library is
   * already indexed, so importing several archives of one library does not rescan every time.
   */
  async buildIndex(libraryId: number, libraryRoot: string): Promise<void> {
    const event = 'inpx.author_sidecar_build';
    const startedAt = Date.now();
    try {
      if ((await this.repo.countAuthorSidecars(libraryId)) > 0) return;

      const authorsDir = join(libraryRoot, 'etc', 'authors');
      const picturesDir = join(authorsDir, 'pictures');
      const rows = new Map<string, InpxAuthorSidecarInput>();
      const bioScores = new Map<string, number>();
      const bios = await this.scanDir(authorsDir, rows, bioScores, 'bio', event, libraryId);
      const portraits = await this.scanDir(picturesDir, rows, bioScores, 'portrait', event, libraryId);
      if (rows.size === 0) {
        if (bios > 0 || portraits > 0) {
          await this.repo.replaceAuthorSidecars(libraryId, libraryRoot, []);
        }
        return;
      }

      await this.repo.replaceAuthorSidecars(libraryId, libraryRoot, [...rows.values()]);
      this.logger.log(
        `[${event}] [end] libraryId=${libraryId} keys=${rows.size} bios=${bios} portraits=${portraits} durationMs=${Date.now() - startedAt} - author sidecar index built`,
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.warn(
        `[${event}] [fail] libraryId=${libraryId} durationMs=${Date.now() - startedAt} errorClass=${error.name} error="${sanitizeLogValue(error.message)}" - author sidecar index build failed`,
      );
    }
  }

  private async scanDir(
    dir: string,
    rows: Map<string, InpxAuthorSidecarInput>,
    bioScores: Map<string, number>,
    kind: 'bio' | 'portrait',
    event: string,
    libraryId: number,
  ): Promise<number> {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => /\.(zip|7z)$/i.test(name)).sort();
    } catch {
      return 0;
    }

    let found = 0;
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i]!;
      let container;
      try {
        container = await openInpxContainer(join(dir, name));
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(
          `[${event}] [fail] libraryId=${libraryId} kind=${kind} shard="${sanitizeLogValue(name)}" errorClass=${error.name} error="${sanitizeLogValue(error.message)}" - author shard could not be opened`,
        );
        continue;
      }
      try {
        for (const entry of container.entries) {
          const key = authorEntryKeyFromPath(entry.name);
          if (!key) continue;
          let row = rows.get(key);
          if (!row) {
            row = { authorKey: key, bioShardName: null, bioEntryPath: null, portraitShardName: null, portraitEntryPath: null };
            rows.set(key, row);
          }
          if (kind === 'bio') {
            const score = authorShardBioPathScore(entry.name);
            const previous = bioScores.get(key);
            if (previous === undefined || score < previous) {
              bioScores.set(key, score);
              row.bioShardName = name;
              row.bioEntryPath = entry.name;
              found += 1;
            }
          } else if (!row.portraitShardName) {
            row.portraitShardName = name;
            row.portraitEntryPath = entry.name;
            found += 1;
          }
        }
      } finally {
        await container.close();
      }
      if ((i + 1) % INDEX_ARCHIVE_LOG_EVERY === 0) {
        this.logger.log(
          `[${event}] [end] libraryId=${libraryId} kind=${kind} shards=${i + 1}/${names.length} keys=${rows.size} - author shard listing progress`,
        );
      }
    }
    return found;
  }

  async resolvePortrait(authorId: number, authorName: string): Promise<InpxAuthorPortrait | null> {
    const cacheKey = `${authorId}|${authorName}`;
    const cached = this.portraitCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let value: InpxAuthorPortrait | null = null;
    for (const row of await this.findRows(authorId, authorName)) {
      if (!row.portraitShardName || !row.portraitEntryPath) continue;
      value = await this.readPortrait(row.libraryRoot, row.portraitShardName, row.portraitEntryPath);
      if (value) break;
    }
    this.setCache(this.portraitCache, cacheKey, value);
    return value;
  }

  async resolveBio(authorId: number, authorName: string): Promise<string | null> {
    const cacheKey = `${authorId}|${authorName}`;
    const cached = this.bioCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let value: string | null = null;
    for (const row of await this.findRows(authorId, authorName)) {
      if (!row.bioShardName || !row.bioEntryPath) continue;
      value = await this.readBio(row.libraryRoot, row.bioShardName, row.bioEntryPath);
      if (value) break;
    }
    this.setCache(this.bioCache, cacheKey, value);
    return value;
  }

  private async findRows(authorId: number, authorName: string): Promise<InpxAuthorSidecar[]> {
    const keys = md5AuthorKeyCandidates(authorName).map((key) => key.toLowerCase());
    if (keys.length === 0) return [];
    const rows = await this.repo.findAuthorSidecarRows(authorId, keys);
    const order = new Map(keys.map((key, index) => [key, index]));
    return rows.sort((a, b) => (order.get(a.authorKey) ?? keys.length) - (order.get(b.authorKey) ?? keys.length));
  }

  private async readPortrait(libraryRoot: string, shardName: string, entryPath: string): Promise<InpxAuthorPortrait | null> {
    const archivePath = join(libraryRoot, 'etc', 'authors', 'pictures', shardName);
    let container;
    try {
      container = await openInpxContainer(archivePath);
    } catch {
      return null;
    }
    try {
      const bytes = await container.readEntry(entryPath.replace(/\\/g, '/'));
      if (!bytes || bytes.length === 0) return null;
      const contentType = sniffImageContentType(bytes);
      return contentType ? { data: bytes, contentType } : null;
    } catch {
      return null;
    } finally {
      await container.close();
    }
  }

  private async readBio(libraryRoot: string, shardName: string, entryPath: string): Promise<string | null> {
    const archivePath = join(libraryRoot, 'etc', 'authors', shardName);
    let container;
    try {
      container = await openInpxContainer(archivePath);
    } catch {
      return null;
    }
    try {
      const bytes = await container.readEntry(entryPath.replace(/\\/g, '/'));
      if (!bytes || bytes.length === 0) return null;
      let raw = bytes.toString('utf8').trim();
      if (!raw) {
        try {
          raw = iconv.decode(bytes, 'windows-1251').trim();
        } catch {
          // not windows-1251 either; treat as empty.
        }
      }
      const text = raw ? htmlToPlainText(raw, { preserveLineBreaks: true }) : '';
      return text || null;
    } catch {
      return null;
    } finally {
      await container.close();
    }
  }

  private setCache<T>(cache: Map<string, { value: T; expiresAt: number }>, key: string, value: T): void {
    cache.set(key, { value, expiresAt: Date.now() + AUTHOR_EXTRAS_TTL_MS });
    if (cache.size > EXTRAS_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
}

/** Bio entries are stored as html/xhtml when available; prefer those over xml/txt/fb2 mirrors. */
function authorShardBioPathScore(path: string): number {
  const lower = String(path || '').toLowerCase();
  if (/\.(html?|xhtml)$/.test(lower)) return 0;
  if (/\.(htm|xml|txt|fb2)$/.test(lower)) return 1;
  return 2;
}

function sniffImageContentType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
