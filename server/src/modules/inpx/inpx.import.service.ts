import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { readdirSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { InpxImportProgressEvent } from '@bookorbit/types';
import { openInpxContainer } from '../../common/inpx-container';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { InpxGateway } from './inpx.gateway';
import { InpxProgressStore } from './inpx-progress.store';
import type { InpxBookRecord } from './inpx.parser';
import { InpxParser } from './inpx.parser';
import { INPX_BOOKS_CHUNK_SIZE, InpxRepository } from './inpx.repository';

/** Companion archives whose entry layout has already been logged this process run. */
const inspectedArchives = new Set<number>();

@Injectable()
export class InpxImportService {
  private readonly logger = new Logger(InpxImportService.name);
  private readonly running = new Map<number, Promise<void>>();

  constructor(
    private readonly parser: InpxParser,
    private readonly repo: InpxRepository,
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

  /**
   * Runs metadata extraction (covers, descriptions, ISBNs) for the archive's books that do not have
   * a cover yet. Useful after an import whose enrichment was interrupted, or when only the index
   * metadata was wanted first. Re-entrant: a run already in flight is shared.
   */
  enrich(archiveId: number): Promise<void> {
    const existing = this.running.get(archiveId);
    if (existing) return existing;
    const run = this.runEnrich(archiveId).finally(() => this.running.delete(archiveId));
    this.running.set(archiveId, run);
    return run;
  }

  private async runEnrich(archiveId: number): Promise<void> {
    const event = 'inpx.enrich';
    const startedAt = Date.now();
    cleanupStaleEnrichTempDirs();
    const archive = await this.repo.findArchiveById(archiveId);
    if (!archive) throw new NotFoundException(`INPX archive ${archiveId} not found`);
    const libraryId = archive.libraryId;

    const progress: InpxImportProgressEvent = {
      archiveId,
      libraryId,
      phase: 'enrich',
      status: 'importing',
      processed: 0,
      total: 0,
    };
    this.progressStore.set(progress);
    await this.repo.updateArchive(archiveId, { status: 'importing', errorMessage: null });

    try {
      // Book content is never unpacked for metadata: the index already carries title, authors,
      // genres, series and year, and covers live in separate archives. This pass only repairs the
      // author names imported before the text format was understood.
      const fixedAuthors = await this.repo.fixColonAuthorNames();
      if (fixedAuthors > 0) {
        this.logger.log(`[${event}] [end] archiveId=${archiveId} fixedAuthorNames=${fixedAuthors} - legacy colon author names normalized`);
      }

      const [totalBooks, enrichedCount] = await Promise.all([
        this.repo.countBooksByArchive(archiveId),
        this.repo.countEnrichedBooksByArchive(archiveId),
      ]);
      await this.repo.updateArchive(archiveId, { status: 'complete', importedBooks: totalBooks, enrichedBooks: enrichedCount, errorMessage: null });
      this.progressStore.clear(archiveId);
      this.gateway.emitCompleted({ archiveId, libraryId, importedBooks: totalBooks, enrichedBooks: enrichedCount });
      this.logger.log(
        `[${event}] [end] archiveId=${archiveId} durationMs=${Date.now() - startedAt} fixedAuthorNames=${fixedAuthors} totalEnriched=${enrichedCount} - enrichment completed`,
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const errorMessage = sanitizeLogValue(error.message);
      this.logger.warn(
        `[${event}] [fail] archiveId=${archiveId} durationMs=${Date.now() - startedAt} errorClass=${error.name} error="${errorMessage}" - enrichment failed`,
      );
      this.progressStore.clear(archiveId);
      await this.repo.updateArchive(archiveId, { status: 'failed', errorMessage: error.message });
      throw err;
    }
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
      for (const chunk of chunkArray(books, INPX_BOOKS_CHUNK_SIZE)) {
        const chunkResult = await this.repo.importBooksChunked(libraryId, folderId, archiveId, chunk);
        bookEntries.push(...chunkResult.bookEntries);
        progress.processed += chunk.length;
        this.progressStore.set(progress);
        this.gateway.emitProgress({ ...progress });
      }
      this.logger.log(
        `[${event}] [end] archiveId=${archiveId} phase=index durationMs=${Date.now() - startedAt} totalBooks=${books.length} skipped=${books.length - bookEntries.length} missingCompanionArchives=${missingShards} - index phase completed`,
      );

      const [totalBooks, enrichedCount] = await Promise.all([
        this.repo.countBooksByArchive(archiveId),
        this.repo.countEnrichedBooksByArchive(archiveId),
      ]);
      await this.repo.updateArchive(archiveId, { status: 'complete', importedBooks: totalBooks, enrichedBooks: enrichedCount, errorMessage: null });
      this.progressStore.clear(archiveId);
      this.gateway.emitCompleted({ archiveId, libraryId, importedBooks: totalBooks, enrichedBooks: enrichedCount });
      this.logger.log(
        `[${event}] [end] archiveId=${archiveId} durationMs=${Date.now() - startedAt} imported=${totalBooks} enriched=${enrichedCount} - inpx import completed`,
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

/** Removes `inpx-enrich-*` temp dirs left behind by a crashed run so extracted shards do not pile up. */
function cleanupStaleEnrichTempDirs(): void {
  const base = enrichTempBase();
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith('inpx-enrich-')) continue;
    void rm(join(base, name), { recursive: true, force: true }).catch(() => undefined);
  }
}
