import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import {
  authors,
  bookAuthors,
  bookFiles,
  bookGenres,
  bookMetadata,
  bookSeriesMemberships,
  books,
  genres,
  inpxArchives,
  libraryFolders,
} from '../../db/schema';
import { SeriesIdentityService } from '../../common/services/series-identity.service';
import { InpxBookRecord, normalizeAuthorName, normalizeEntryName } from './inpx.parser';

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const INPX_BOOKS_CHUNK_SIZE = 300;

export interface InpxImportChunkResult {
  imported: number;
  skipped: number;
  createdBookIds: number[];
  bookEntries: { bookId: number; entryPath: string; sourceArchivePath: string | null }[];
}

@Injectable()
export class InpxRepository {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly seriesIdentity: SeriesIdentityService,
  ) {}

  // ── Archives ────────────────────────────────────────────────────────────────

  async createArchive(data: typeof inpxArchives.$inferInsert): Promise<typeof inpxArchives.$inferSelect> {
    const [row] = await this.db.insert(inpxArchives).values(data).returning();
    if (!row) throw new Error('Failed to create INPX archive');
    return row;
  }

  async updateArchive(id: number, data: Partial<typeof inpxArchives.$inferInsert>): Promise<void> {
    await this.db.update(inpxArchives).set(data).where(eq(inpxArchives.id, id));
  }

  async findArchiveById(id: number): Promise<typeof inpxArchives.$inferSelect | null> {
    const [row] = await this.db.select().from(inpxArchives).where(eq(inpxArchives.id, id)).limit(1);
    return row ?? null;
  }

  async findArchivesByLibrary(libraryId: number): Promise<(typeof inpxArchives.$inferSelect)[]> {
    return this.db.select().from(inpxArchives).where(eq(inpxArchives.libraryId, libraryId)).orderBy(inpxArchives.id);
  }

  async createVirtualFolder(libraryId: number, path: string): Promise<number> {
    const [row] = await this.db.insert(libraryFolders).values({ libraryId, path }).returning({ id: libraryFolders.id });
    if (!row) throw new Error('Failed to create virtual library folder');
    return row.id;
  }

  async findVirtualFolderByPath(libraryId: number, path: string): Promise<number | null> {
    const [row] = await this.db
      .select({ id: libraryFolders.id })
      .from(libraryFolders)
      .where(and(eq(libraryFolders.libraryId, libraryId), eq(libraryFolders.path, path)))
      .limit(1);
    return row?.id ?? null;
  }

  async deleteVirtualFolderIfEmpty(folderId: number): Promise<void> {
    const [countRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(books)
      .where(eq(books.libraryFolderId, folderId));
    if (countRow?.count === 0) {
      await this.db.delete(libraryFolders).where(eq(libraryFolders.id, folderId));
    }
  }

  async deleteArchive(id: number): Promise<void> {
    await this.db.delete(inpxArchives).where(eq(inpxArchives.id, id));
  }

  async findBookIdsByArchive(archiveId: number): Promise<number[]> {
    const rows = await this.db.selectDistinct({ bookId: bookFiles.bookId }).from(bookFiles).where(eq(bookFiles.inpxArchiveId, archiveId));
    return rows.map((row) => row.bookId);
  }

  async deleteBooksByArchive(archiveId: number): Promise<number> {
    const bookIds = await this.findBookIdsByArchive(archiveId);
    if (bookIds.length === 0) return 0;
    await this.db.delete(books).where(inArray(books.id, bookIds));
    return bookIds.length;
  }

  /** Book files of an archive whose books have no cover yet, oldest first. */
  async findUnenrichedBookFiles(
    archiveId: number,
    limit: number,
  ): Promise<{ bookId: number; entryPath: string; sourceArchivePath: string | null }[]> {
    return this.db
      .select({
        bookId: bookFiles.bookId,
        entryPath: bookFiles.archiveEntryPath,
        sourceArchivePath: bookFiles.sourceArchivePath,
      })
      .from(bookFiles)
      .innerJoin(bookMetadata, eq(bookMetadata.bookId, bookFiles.bookId))
      .where(and(eq(bookFiles.inpxArchiveId, archiveId), isNull(bookMetadata.coverSource), isNotNull(bookFiles.archiveEntryPath)))
      .orderBy(bookFiles.id)
      .limit(limit);
  }

  /**
   * Renames (or merges into) author rows whose name carries the `First Middle: Last` colon artifact
   * imported before the text parser understood that format. Returns how many names changed.
   */
  async fixColonAuthorNames(): Promise<number> {
    const rows = await this.db
      .select({ id: authors.id, name: authors.name, sortName: authors.sortName })
      .from(authors)
      .where(sql`${authors.name} like '%:%'`);
    let fixed = 0;

    for (const row of rows) {
      const fixedName = normalizeAuthorName(row.name);
      if (!fixedName || fixedName === row.name) continue;

      const [existing] = await this.db.select({ id: authors.id }).from(authors).where(eq(authors.name, fixedName)).limit(1);
      if (existing) {
        // Point the duplicate's links at the survivor, skipping books that already have it.
        await this.db.execute(sql`
          UPDATE book_authors AS ba
          SET author_id = ${existing.id}
          WHERE ba.author_id = ${row.id}
            AND NOT EXISTS (SELECT 1 FROM book_authors AS x WHERE x.book_id = ba.book_id AND x.author_id = ${existing.id})
        `);
        await this.db.delete(authors).where(eq(authors.id, row.id));
      } else {
        await this.db
          .update(authors)
          .set({ name: fixedName, sortName: row.sortName ? normalizeAuthorName(row.sortName) : deriveSortName(fixedName) })
          .where(eq(authors.id, row.id));
      }
      fixed += 1;
    }

    return fixed;
  }

  // ── Import ──────────────────────────────────────────────────────────────────

  /**
   * Imports one chunk of indexed books inside the caller's transaction. Books whose synthetic
   * folder path already exists are skipped, which makes re-imports of partially completed runs
   * resume instead of duplicating rows. See `INPX_BOOKS_CHUNK_SIZE`.
   */
  async importBooksChunked(libraryId: number, libraryFolderId: number, archiveId: number, records: InpxBookRecord[]): Promise<InpxImportChunkResult> {
    return this.db.transaction((tx) => this.importBooksChunk(tx, libraryId, libraryFolderId, archiveId, records));
  }

  private async importBooksChunk(
    tx: Tx,
    libraryId: number,
    libraryFolderId: number,
    archiveId: number,
    records: InpxBookRecord[],
  ): Promise<InpxImportChunkResult> {
    const authorIds = await this.resolveAuthorIds(
      tx,
      records.flatMap((record) => record.authors),
    );
    const genreIds = await this.resolveGenreIds(
      tx,
      records.flatMap((record) => record.genres),
    );

    const result: InpxImportChunkResult = { imported: 0, skipped: 0, createdBookIds: [], bookEntries: [] };

    for (const record of records) {
      const folderPath = buildInpxFolderPath(archiveId, record.file);
      const normalizedEntry = normalizeEntryName(record.file);

      const [bookRow] = await tx
        .insert(books)
        .values({ libraryId, libraryFolderId, folderPath, status: 'present' })
        .onConflictDoNothing()
        .returning({ id: books.id });
      if (!bookRow) {
        result.skipped += 1;
        continue;
      }

      const series = record.seriesName ? await this.resolveSeries(tx, record.seriesName) : null;

      await tx.insert(bookMetadata).values({
        bookId: bookRow.id,
        title: record.title,
        language: record.language,
        publishedYear: record.publishedYear,
        seriesName: series?.name ?? null,
        seriesId: series?.id ?? null,
        seriesIndex: record.seriesIndex,
      });

      const [fileRow] = await tx
        .insert(bookFiles)
        .values({
          bookId: bookRow.id,
          libraryFolderId,
          absolutePath: folderPath,
          relPath: normalizedEntry,
          format: record.format,
          sizeBytes: record.sizeBytes,
          role: 'content',
          storageKind: 'inpx',
          archiveEntryPath: normalizedEntry,
          inpxArchiveId: archiveId,
          sourceArchivePath: record.sourceArchivePath,
        })
        .returning({ id: bookFiles.id });

      if (fileRow) {
        await tx.update(books).set({ primaryFileId: fileRow.id }).where(eq(books.id, bookRow.id));
      }

      for (const [index, authorName] of record.authors.entries()) {
        const authorId = authorIds.get(authorName);
        if (authorId == null) continue;
        await tx.insert(bookAuthors).values({ bookId: bookRow.id, authorId, displayOrder: index });
      }

      for (const genreName of record.genres) {
        const genreId = genreIds.get(genreName);
        if (genreId == null) continue;
        await tx.insert(bookGenres).values({ bookId: bookRow.id, genreId });
      }

      if (series && record.seriesIndex) {
        await tx.insert(bookSeriesMemberships).values({
          bookId: bookRow.id,
          seriesId: series.id,
          seriesIndex: record.seriesIndex,
          displayOrder: 0,
        });
      }

      result.imported += 1;
      result.createdBookIds.push(bookRow.id);
      result.bookEntries.push({ bookId: bookRow.id, entryPath: normalizedEntry, sourceArchivePath: record.sourceArchivePath });
    }

    return result;
  }

  private async resolveAuthorIds(tx: Tx, names: string[]): Promise<Map<string, number>> {
    const unique = [...new Set(names.filter((name) => name && name.length <= 500))];
    const byName = new Map<string, number>();
    if (unique.length === 0) return byName;

    const existing = await tx.select({ id: authors.id, name: authors.name }).from(authors).where(inArray(authors.name, unique));
    for (const row of existing) byName.set(row.name, row.id);

    const missing = unique.filter((name) => !byName.has(name));
    if (missing.length > 0) {
      await tx
        .insert(authors)
        .values(missing.map((name) => ({ name, sortName: deriveSortName(name) })))
        .onConflictDoNothing();
      const inserted = await tx.select({ id: authors.id, name: authors.name }).from(authors).where(inArray(authors.name, missing));
      for (const row of inserted) byName.set(row.name, row.id);
    }

    return byName;
  }

  private async resolveGenreIds(tx: Tx, names: string[]): Promise<Map<string, number>> {
    const unique = [...new Set(names.filter((name) => name && name.length <= 200))];
    const byName = new Map<string, number>();
    if (unique.length === 0) return byName;

    const existing = await tx.select({ id: genres.id, name: genres.name }).from(genres).where(inArray(genres.name, unique));
    for (const row of existing) byName.set(row.name, row.id);

    const missing = unique.filter((name) => !byName.has(name));
    if (missing.length > 0) {
      await tx
        .insert(genres)
        .values(missing.map((name) => ({ name })))
        .onConflictDoNothing();
      const inserted = await tx.select({ id: genres.id, name: genres.name }).from(genres).where(inArray(genres.name, missing));
      for (const row of inserted) byName.set(row.name, row.id);
    }

    return byName;
  }

  private async resolveSeries(tx: Tx, rawName: string): Promise<{ id: number; name: string } | null> {
    const displayName = this.seriesIdentity.normalizeDisplayName(rawName);
    if (!displayName) return null;
    const id = await this.seriesIdentity.resolveSeriesId(displayName, tx);
    return id == null ? null : { id, name: displayName };
  }
}

export function buildInpxFolderPath(archiveId: number, entryPath: string): string {
  return `inpx://${archiveId}/${entryPath.replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

function deriveSortName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes(',')) return trimmed;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return trimmed;
  const last = parts[parts.length - 1]!;
  const rest = parts.slice(0, -1).join(' ');
  return `${last}, ${rest}`;
}
