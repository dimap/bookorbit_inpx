import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { InpxImportProgressEvent } from '@bookorbit/types';
import { openInpxContainer } from '../../common/inpx-container';
import { extractSevenZipAll } from '../../common/sevenzip-cli';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { MetadataService } from '../metadata/metadata.service';
import { InpxGateway } from './inpx.gateway';
import { InpxProgressStore } from './inpx-progress.store';
import type { InpxBookRecord } from './inpx.parser';
import { InpxParser } from './inpx.parser';
import { INPX_BOOKS_CHUNK_SIZE, InpxRepository } from './inpx.repository';

const ENRICH_CONCURRENCY = 4;
const PROGRESS_EMIT_EVERY = 10;

/** Companion archives whose entry layout has already been logged this process run. */
const inspectedArchives = new Set<number>();

@Injectable()
export class InpxImportService {
  private readonly logger = new Logger(InpxImportService.name);
  private readonly running = new Map<number, Promise<void>>();

  constructor(
    private readonly parser: InpxParser,
    private readonly repo: InpxRepository,
    private readonly metadataService: MetadataService,
    private readonly gateway: InpxGateway,
    private readonly progressStore: InpxProgressStore,
  ) {}

  getProgress(archiveId: number): InpxImportProgressEvent | undefined {
    return this.progressStore.get(archiveId);
  }

  isRunning(archiveId: number): boolean {
    return this.running.has(archiveId);
  }

  /**
   * Runs the import in the background. Concurrent calls for the same archive share one run, so a
   * double-click on "Import" is harmless.
   */
  startImport(archiveId: number): Promise<void> {
    const existing = this.running.get(archiveId);
    if (existing) return existing;
    const run = this.runImport(archiveId).finally(() => this.running.delete(archiveId));
    this.running.set(archiveId, run);
    return run;
  }

  private async runImport(archiveId: number): Promise<void> {
    const event = 'inpx.import';
    const startedAt = Date.now();
    const archive = await this.repo.findArchiveById(archiveId);
    if (!archive) throw new NotFoundException(`INPX archive ${archiveId} not found`);
    const libraryId = archive.libraryId;

    this.logger.log(
      `[${event}] [start] archiveId=${archiveId} libraryId=${libraryId} path="${sanitizeLogValue(archive.absolutePath)}" - inpx import started`,
    );

    const progress: InpxImportProgressEvent = {
      archiveId,
      libraryId,
      phase: 'index',
      status: 'importing',
      processed: 0,
      total: 0,
    };
    this.progressStore.set(progress);
    await this.repo.updateArchive(archiveId, { status: 'importing', errorMessage: null, lastImportedAt: new Date() });

    try {
      const virtualPath = `inpx://${archiveId}`;
      let folderId = await this.repo.findVirtualFolderByPath(libraryId, virtualPath);
      if (folderId == null) {
        folderId = await this.repo.createVirtualFolder(libraryId, virtualPath);
      }

      const parsed = await this.parser.parse(archive.absolutePath);
      this.logger.log(
        `[${event}] [end] archiveId=${archiveId} phase=parse container=${parsed.containerKind} entries=${parsed.totalEntries} inpIndexes=${parsed.inpEntryCount} fb2Files=${parsed.fb2EntryCount} sample="${sanitizeLogValue(parsed.sampleBookEntries.join(', '))}" - archive structure inspected`,
      );
      for (const info of parsed.infoFiles) {
        this.logger.log(
          `[${event}] [end] archiveId=${archiveId} phase=parse info="${sanitizeLogValue(info.name)}" content="${sanitizeLogValue(info.content.replace(/\r?\n/g, ' / '))}" - archive info file`,
        );
      }
      if (parsed.failedIndexEntries.length > 0) {
        const reasons = parsed.indexFailureReasons
          .slice(0, 3)
          .map(({ name, reason }) => `${name}: ${reason}`)
          .join('; ');
        const extra = parsed.failedIndexEntries.length > 3 ? ` and ${parsed.failedIndexEntries.length - 3} more` : '';
        this.logger.warn(
          `[${event}] [end] archiveId=${archiveId} phase=parse failedIndexes=${parsed.failedIndexEntries.length} reasons="${sanitizeLogValue(reasons)}"${extra ? ` (${extra})` : ''} - some INPX index entries were unreadable and skipped`,
        );
      }

      const { books, companionPaths, missingShards } = await this.resolveCompanionSources(parsed.books, archive.absolutePath);
      if (missingShards > 0) {
        this.logger.warn(
          `[${event}] [end] archiveId=${archiveId} phase=parse missingCompanionArchives=${missingShards} - books from shards without a companion archive were skipped`,
        );
      }
      if (companionPaths.length > 0 && !inspectedArchives.has(archiveId)) {
        inspectedArchives.add(archiveId);
        await this.logCompanionSample(archiveId, companionPaths[0]!);
      }

      await this.repo.updateArchive(archiveId, { totalBooks: books.length });
      progress.total = books.length;
      this.progressStore.set(progress);

      const bookEntries: { bookId: number; entryPath: string; sourceArchivePath: string | null }[] = [];
      let imported = 0;
      for (const chunk of chunkArray(books, INPX_BOOKS_CHUNK_SIZE)) {
        const chunkResult = await this.repo.importBooksChunked(libraryId, folderId, archiveId, chunk);
        imported += chunkResult.imported;
        bookEntries.push(...chunkResult.bookEntries);
        progress.processed += chunk.length;
        this.progressStore.set(progress);
        this.gateway.emitProgress({ ...progress });
      }
      await this.repo.updateArchive(archiveId, { importedBooks: imported });
      this.logger.log(
        `[${event}] [end] archiveId=${archiveId} phase=index durationMs=${Date.now() - startedAt} totalBooks=${books.length} imported=${imported} skipped=${books.length - imported} missingCompanionArchives=${missingShards} - index phase completed`,
      );

      progress.phase = 'enrich';
      progress.processed = 0;
      progress.total = bookEntries.length;
      this.progressStore.set(progress);
      this.gateway.emitProgress({ ...progress });

      let enriched = 0;
      if (bookEntries.length > 0) {
        enriched = await this.enrichEntries(archive.absolutePath, bookEntries, (count) => {
          progress.processed = count;
          this.progressStore.set(progress);
          if (count % PROGRESS_EMIT_EVERY === 0 || count >= progress.total) this.gateway.emitProgress({ ...progress });
        });
      }

      await this.repo.updateArchive(archiveId, { status: 'complete', enrichedBooks: enriched, errorMessage: null });
      this.progressStore.clear(archiveId);
      this.gateway.emitCompleted({ archiveId, libraryId, importedBooks: imported, enrichedBooks: enriched });
      this.logger.log(
        `[${event}] [end] archiveId=${archiveId} durationMs=${Date.now() - startedAt} imported=${imported} enriched=${enriched} - inpx import completed`,
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const errorMessage = sanitizeLogValue(error.message);
      this.logger.warn(
        `[${event}] [fail] archiveId=${archiveId} durationMs=${Date.now() - startedAt} errorClass=${error.name} error="${errorMessage}" - inpx import failed`,
      );
      this.progressStore.clear(archiveId);
      await this.repo.updateArchive(archiveId, { status: 'failed', errorMessage: error.message });
      throw err;
    }
  }

  /**
   * Resolves each indexed book to the archive that physically holds it. Text-format shards live
   * in a companion archive with the same base name next to the INPX (`d.fb2-*.inp` pairs with
   * `d.fb2-*.7z`); books whose companion archive is missing are dropped.
   */
  private async resolveCompanionSources(
    books: InpxBookRecord[],
    inpxPath: string,
  ): Promise<{ books: InpxBookRecord[]; companionPaths: string[]; missingShards: number }> {
    const directory = dirname(inpxPath);
    const cache = new Map<string, string | null>();
    const companionPaths = new Set<string>();
    let missingShards = 0;
    const resolved: InpxBookRecord[] = [];

    for (const book of books) {
      if (!book.sourceArchiveName) {
        resolved.push(book);
        continue;
      }
      let path = cache.get(book.sourceArchiveName);
      if (path === undefined) {
        path = await this.findCompanionArchive(directory, book.sourceArchiveName);
        if (path) companionPaths.add(path);
        else missingShards += 1;
        cache.set(book.sourceArchiveName, path);
      }
      if (!path) continue;
      resolved.push({ ...book, sourceArchivePath: path });
    }

    return { books: resolved, companionPaths: [...companionPaths], missingShards };
  }

  private async findCompanionArchive(directory: string, shardName: string): Promise<string | null> {
    const base = shardName.replace(/\.inp$/i, '');
    for (const ext of ['7z', 'zip']) {
      const candidate = join(directory, `${base}.${ext}`);
      try {
        const fileStat = await stat(candidate);
        if (fileStat.isFile()) return candidate;
      } catch {
        // not present; try the next container
      }
    }
    return null;
  }

  private async logCompanionSample(archiveId: number, archivePath: string): Promise<void> {
    const event = 'inpx.import';
    try {
      const container = await openInpxContainer(archivePath);
      const names = container.entries.slice(0, 5).map((entry) => entry.name);
      this.logger.log(
        `[${event}] [end] archiveId=${archiveId} phase=parse companion="${sanitizeLogValue(archivePath)}" entries=${container.entries.length} sample="${sanitizeLogValue(names.join(', '))}" - companion archive layout`,
      );
      await container.close();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const errorMessage = sanitizeLogValue(error.message);
      this.logger.warn(
        `[${event}] [fail] archiveId=${archiveId} phase=parse errorClass=${error.name} error="${errorMessage}" - companion archive could not be opened`,
      );
    }
  }

  /**
   * Extracts each FB2 from its archive to a temp file and lets the standard metadata pipeline fill
   * description, ISBN, dates, cover and author sort names. Runs with bounded concurrency; one bad
   * file is logged and skipped, never fatal. Entries are grouped by their source archive so each
   * companion 7z is opened and closed once.
   */
  private async enrichEntries(
    inpxPath: string,
    entries: { bookId: number; entryPath: string; sourceArchivePath: string | null }[],
    onProgress: (processed: number) => void,
  ): Promise<number> {
    const groups = new Map<string, { bookId: number; entryPath: string }[]>();
    for (const entry of entries) {
      const key = entry.sourceArchivePath ?? inpxPath;
      let list = groups.get(key);
      if (!list) {
        list = [];
        groups.set(key, list);
      }
      list.push({ bookId: entry.bookId, entryPath: entry.entryPath });
    }

    let enriched = 0;
    let runningTotal = 0;
    for (const [archivePath, groupEntries] of groups) {
      enriched += await this.enrichFromContainer(archivePath, groupEntries, (localProcessed) => {
        onProgress(runningTotal + localProcessed);
      });
      runningTotal += groupEntries.length;
    }
    return enriched;
  }

  private async enrichFromContainer(
    archivePath: string,
    entries: { bookId: number; entryPath: string }[],
    onProgress: (processed: number) => void,
  ): Promise<number> {
    const tempDir = await mkdtemp(join(enrichTempBase(), 'inpx-enrich-'));
    const container = await openInpxContainer(archivePath);
    let nextIndex = 0;
    let enriched = 0;
    let failed = 0;
    const isSevenZip = container.kind === '7z';
    if (isSevenZip) {
      // Solid 7z shards decompress the whole block to reach one file, so extract the shard once and
      // read its entries from disk instead of spawning a 7z process per book.
      await extractSevenZipAll(archivePath, tempDir);
    }

    const worker = async (): Promise<void> => {
      while (nextIndex < entries.length) {
        const entry = entries[nextIndex]!;
        nextIndex += 1;
        const startedAt = Date.now();
        try {
          let fb2Path: string | null = null;
          if (isSevenZip) {
            fb2Path =
              [entry.entryPath, `fb2-${entry.entryPath}`].map((name) => join(tempDir, basename(name))).find((path) => existsSync(path)) ?? null;
          } else {
            const buffer = (await container.readEntry(entry.entryPath)) ?? (await container.readEntry(`fb2-${entry.entryPath}`));
            if (buffer && buffer.length > 0) {
              fb2Path = join(tempDir, `book-${entry.bookId}.fb2`);
              await writeFile(fb2Path, buffer);
            }
          }
          if (!fb2Path) continue;
          try {
            await this.metadataService.extractAndSave(entry.bookId, fb2Path, 'fb2');
            enriched += 1;
          } finally {
            if (!isSevenZip) await rm(fb2Path, { force: true }).catch(() => undefined);
          }
        } catch (err) {
          failed += 1;
          const error = err instanceof Error ? err : new Error(String(err));
          const errorMessage = sanitizeLogValue(error.message);
          this.logger.warn(
            `[inpx.enrich] [fail] bookId=${entry.bookId} durationMs=${Date.now() - startedAt} errorClass=${error.name} error="${errorMessage}" - enrichment failed`,
          );
        }
        onProgress(Math.min(nextIndex, entries.length));
      }
    };

    try {
      await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, () => worker()));
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      await container.close();
    }

    if (failed > 0) {
      this.logger.warn(
        `[inpx.enrich] [end] archive="${sanitizeLogValue(archivePath)}" enriched=${enriched} failed=${failed} - enrichment completed with failures`,
      );
    }
    return enriched;
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** Enrichment extracts whole 7z shards to disk; use the persistent data volume, not the tmpfs. */
function enrichTempBase(): string {
  const dataPath = process.env.APP_DATA_PATH;
  return dataPath && dataPath !== '' ? dataPath : tmpdir();
}
