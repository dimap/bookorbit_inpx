import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InpxImportProgressEvent } from '@bookorbit/types';
import { openInpxContainer } from '../../common/inpx-container';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { MetadataService } from '../metadata/metadata.service';
import { InpxGateway } from './inpx.gateway';
import { InpxProgressStore } from './inpx-progress.store';
import { InpxParser } from './inpx.parser';
import { INPX_BOOKS_CHUNK_SIZE, InpxRepository } from './inpx.repository';

const ENRICH_CONCURRENCY = 4;
const PROGRESS_EMIT_EVERY = 10;

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
      await this.repo.updateArchive(archiveId, { totalBooks: parsed.books.length });
      progress.total = parsed.books.length;
      this.progressStore.set(progress);

      const bookEntries: { bookId: number; entryPath: string }[] = [];
      let imported = 0;
      for (const chunk of chunkArray(parsed.books, INPX_BOOKS_CHUNK_SIZE)) {
        const chunkResult = await this.repo.importBooksChunked(libraryId, folderId, archiveId, chunk);
        imported += chunkResult.imported;
        bookEntries.push(...chunkResult.bookEntries);
        progress.processed += chunk.length;
        this.progressStore.set(progress);
        this.gateway.emitProgress({ ...progress });
      }
      await this.repo.updateArchive(archiveId, { importedBooks: imported });
      this.logger.log(
        `[${event}] [end] archiveId=${archiveId} phase=index durationMs=${Date.now() - startedAt} totalBooks=${parsed.books.length} imported=${imported} skipped=${parsed.books.length - imported} - index phase completed`,
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
   * Extracts each FB2 from the archive to a temp file and lets the standard metadata pipeline fill
   * description, ISBN, dates, cover and author sort names. Runs with bounded concurrency; one bad
   * file is logged and skipped, never fatal.
   */
  private async enrichEntries(
    archivePath: string,
    entries: { bookId: number; entryPath: string }[],
    onProgress: (processed: number) => void,
  ): Promise<number> {
    const tempDir = await mkdtemp(join(tmpdir(), 'bookorbit-inpx-enrich-'));
    const container = await openInpxContainer(archivePath);
    let nextIndex = 0;
    let enriched = 0;
    let failed = 0;

    const worker = async (): Promise<void> => {
      while (nextIndex < entries.length) {
        const entry = entries[nextIndex]!;
        nextIndex += 1;
        const startedAt = Date.now();
        try {
          const buffer = await container.readEntry(entry.entryPath);
          if (!buffer || buffer.length === 0) continue;
          const tempPath = join(tempDir, `book-${entry.bookId}.fb2`);
          await writeFile(tempPath, buffer);
          try {
            await this.metadataService.extractAndSave(entry.bookId, tempPath, 'fb2');
            enriched += 1;
          } finally {
            await rm(tempPath, { force: true }).catch(() => undefined);
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
      this.logger.warn(`[inpx.enrich] [end] enriched=${enriched} failed=${failed} - enrichment completed with failures`);
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
