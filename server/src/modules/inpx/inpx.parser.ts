import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalizeEntryName, openInpxContainer } from '../../common/inpx-container';
import { resolveFb2GenreName } from './fb2-genres';

type SqlRow = Record<string, unknown>;

const MAX_SQL_ROWS_PER_TABLE = 2_000_000;
const MAX_ARCHIVE_ENTRIES = 5_000_000;
const MAX_INP_BYTES = 2 * 1024 * 1024 * 1024;

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');

const SUPPORTED_BOOK_EXTENSIONS = new Set(['fb2', 'fb2.zip']);

/** Columns the parser understands on the `books` table. Producers may omit some. */
const BOOKS_COLUMNS = [
  'id',
  'file',
  'booktitle',
  'authorid',
  'authors',
  'booklang',
  'genre',
  'seqid',
  'seqname',
  'seqnumber',
  'ext',
  'size',
  'del',
] as const;

/** Columns the parser understands on the `authors` table. */
const AUTHORS_COLUMNS = ['id', 'firstname', 'middlename', 'lastname', 'nickname'] as const;

export interface InpxBookRecord {
  file: string;
  format: string;
  sizeBytes: number | null;
  title: string;
  authors: string[];
  genres: string[];
  seriesName: string | null;
  seriesIndex: string | null;
  language: string | null;
}

export interface InpxParseResult {
  books: InpxBookRecord[];
  languages: string[];
  totalIndexedBooks: number;
  skippedDel: number;
  skippedNoFile: number;
  skippedEmptyTitle: number;
  skippedUnsupported: number;
  /** `.inp` entries that existed but could not be read (not SQLite, or unreadable). */
  failedIndexEntries: string[];
}

interface InpxAuthorRow {
  id: number;
  firstname: string | null;
  middlename: string | null;
  lastname: string | null;
  nickname: string | null;
}

interface InpxBookRow {
  id: number;
  file: string | null;
  booktitle: string | null;
  authorid: string | null;
  authors: string | null;
  booklang: string | null;
  genre: string | null;
  seqid: string | null;
  seqname: string | null;
  seqnumber: number | null;
  ext: string | null;
  size: number | null;
  del: number | null;
}

export class InpxParser {
  /**
   * Parses a self-contained INPX archive (a ZIP or 7z holding `.inp` SQLite indexes and the FB2
   * files they reference) into normalized book records. The `.inp` files are streamed to temp files
   * and read with the built-in SQLite driver; books marked deleted in the index and books whose
   * file is not actually inside the archive are skipped.
   */
  async parse(archivePath: string): Promise<InpxParseResult> {
    const container = await openInpxContainer(archivePath);
    try {
      const entries = container.entries;
      if (entries.length > MAX_ARCHIVE_ENTRIES) {
        throw new Error(`INPX archive has too many entries: ${entries.length}`);
      }

      const entryNames = new Set(entries.map((entry) => entry.name));
      const inpEntries = entries.filter((entry) => /\.inp$/i.test(entry.name));
      const tempDir = await mkdtemp(join(tmpdir(), 'bookorbit-inpx-'));
      const languages = new Set<string>();
      const books: InpxBookRecord[] = [];
      const failedIndexEntries: string[] = [];
      const counts = {
        totalIndexedBooks: 0,
        skippedDel: 0,
        skippedNoFile: 0,
        skippedEmptyTitle: 0,
        skippedUnsupported: 0,
      };

      try {
        for (const [index, inp] of inpEntries.entries()) {
          try {
            const buffer = await container.readEntry(inp.name);
            if (!buffer) {
              throw new Error(`INPX entry ${inp.name} could not be read`);
            }
            const parsed = await this.parseInpEntry(index, inp.name, buffer, tempDir, entryNames, languages, counts);
            books.push(...parsed);
          } catch {
            // A single bad index must not sink the whole archive: other languages/producers may be
            // readable, and the failure names are surfaced in the result for the caller to log.
            failedIndexEntries.push(inp.name);
          }
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }

      if (books.length === 0 && failedIndexEntries.length > 0) {
        const detail = failedIndexEntries.slice(0, 5).join(', ');
        const extra = failedIndexEntries.length > 5 ? ` and ${failedIndexEntries.length - 5} more` : '';
        throw new Error(`INPX archive has no readable index (failed: ${detail}${extra})`);
      }

      return { books, languages: [...languages], failedIndexEntries, ...counts };
    } finally {
      await container.close();
    }
  }

  private async parseInpEntry(
    index: number,
    entryName: string,
    buffer: Buffer,
    tempDir: string,
    entryNames: Set<string>,
    languages: Set<string>,
    counts: {
      totalIndexedBooks: number;
      skippedDel: number;
      skippedNoFile: number;
      skippedEmptyTitle: number;
      skippedUnsupported: number;
    },
  ): Promise<InpxBookRecord[]> {
    if (buffer.length > MAX_INP_BYTES) {
      throw new Error(`INPX index entry ${entryName} is too large`);
    }
    if (!isSqliteBuffer(buffer)) {
      // Not every `.inp` in the wild is a SQLite database; skip rather than fail the archive, but
      // record the name so the caller can tell the user which entries were ignored.
      throw new Error(`${entryName} is not a SQLite database`);
    }

    const dbPath = join(tempDir, `idx-${index}.sqlite`);
    await writeFile(dbPath, buffer);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON');
      db.enableDefensive?.(true);

      const authors = this.readAuthors(db);
      const books = this.readBooks(db, entryNames, languages, counts);
      return this.resolveAuthors(books, authors);
    } finally {
      db.close();
    }
  }

  private readAuthors(db: DatabaseSync): Map<number, InpxAuthorRow> {
    const authors = new Map<number, InpxAuthorRow>();
    if (!this.tableExists(db, 'authors')) return authors;

    const columns = this.availableColumns(db, 'authors');
    const select = AUTHORS_COLUMNS.filter((column) => columns.has(column));
    if (select.length === 0) return authors;

    const statement = db.prepare(`SELECT ${select.join(', ')} FROM authors`);
    for (const row of statement.iterate() as IterableIterator<SqlRow>) {
      const id = toNumber(row.id);
      if (id == null) continue;
      authors.set(id, {
        id,
        firstname: toNullableString(row.firstname),
        middlename: toNullableString(row.middlename),
        lastname: toNullableString(row.lastname),
        nickname: toNullableString(row.nickname),
      });
    }
    return authors;
  }

  private readBooks(
    db: DatabaseSync,
    entryNames: Set<string>,
    languages: Set<string>,
    counts: {
      totalIndexedBooks: number;
      skippedDel: number;
      skippedNoFile: number;
      skippedEmptyTitle: number;
      skippedUnsupported: number;
    },
  ): InpxBookRow[] {
    if (!this.tableExists(db, 'books')) return [];

    const columns = this.availableColumns(db, 'books');
    const select = BOOKS_COLUMNS.filter((column) => columns.has(column));
    if (select.length === 0) return [];

    const statement = db.prepare(`SELECT ${select.join(', ')} FROM books`);
    const rows: InpxBookRow[] = [];
    for (const row of statement.iterate() as IterableIterator<SqlRow>) {
      if (rows.length >= MAX_SQL_ROWS_PER_TABLE) {
        throw new Error(`INPX index exceeds the ${MAX_SQL_ROWS_PER_TABLE} row limit`);
      }
      counts.totalIndexedBooks += 1;

      if (toNumber(row.del) === 1) {
        counts.skippedDel += 1;
        continue;
      }
      const file = toNullableString(row.file);
      if (!file || !entryNames.has(normalizeEntryName(file))) {
        counts.skippedNoFile += 1;
        continue;
      }
      if (!toNullableString(row.booktitle)) {
        counts.skippedEmptyTitle += 1;
        continue;
      }
      const ext = toNullableString(row.ext)?.toLowerCase() ?? '';
      if (!SUPPORTED_BOOK_EXTENSIONS.has(ext)) {
        counts.skippedUnsupported += 1;
        continue;
      }

      const booklang = toNullableString(row.booklang);
      if (booklang) languages.add(booklang);

      rows.push({
        id: toNumber(row.id) ?? 0,
        file,
        booktitle: toNullableString(row.booktitle),
        authorid: toNullableString(row.authorid),
        authors: toNullableString(row.authors),
        booklang,
        genre: toNullableString(row.genre),
        seqid: toNullableString(row.seqid),
        seqname: toNullableString(row.seqname),
        seqnumber: toNullableNumber(row.seqnumber),
        ext,
        size: toNullableNumber(row.size),
        del: toNullableNumber(row.del),
      });
    }
    return rows;
  }

  private resolveAuthors(books: InpxBookRow[], authorsById: Map<number, InpxAuthorRow>): InpxBookRecord[] {
    return books.map((row) => {
      const authors = splitCsv(row.authors).length > 0 ? splitCsv(row.authors) : this.composeAuthors(row.authorid, authorsById);
      return {
        file: row.file ?? '',
        format: 'fb2',
        sizeBytes: row.size,
        title: row.booktitle?.trim() ?? '',
        authors,
        genres: this.resolveGenres(row.genre),
        seriesName: row.seqname?.trim() || null,
        seriesIndex: row.seqnumber != null ? String(row.seqnumber) : null,
        language: row.booklang || null,
      };
    });
  }

  private composeAuthors(authorIds: string | null, authorsById: Map<number, InpxAuthorRow>): string[] {
    if (!authorIds) return [];
    const names: string[] = [];
    for (const id of splitCsv(authorIds)) {
      const parsed = Number.parseInt(id, 10);
      const author = Number.isFinite(parsed) ? authorsById.get(parsed) : undefined;
      if (!author) continue;
      const parts = [author.lastname, author.firstname, author.middlename].filter((part) => part && part.length > 0);
      const name = parts.join(' ') || author.nickname || '';
      if (name) names.push(name);
    }
    return names;
  }

  private resolveGenres(genreCsv: string | null): string[] {
    if (!genreCsv) return [];
    return splitCsv(genreCsv)
      .map((code) => resolveFb2GenreName(code))
      .filter(Boolean);
  }

  private tableExists(db: DatabaseSync, table: string): boolean {
    const row = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as SqlRow | undefined;
    return row !== undefined;
  }

  private availableColumns(db: DatabaseSync, table: string): Set<string> {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) return new Set();
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
    return new Set(rows.map((row) => toNullableString(row.name)).filter((name): name is string => name !== null));
  }
}

function isSqliteBuffer(buffer: Buffer): boolean {
  return buffer.length >= SQLITE_MAGIC.length && buffer.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC);
}

function splitCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Re-exported so existing callers keep one import site; the canonical definition lives in the container. */
export { normalizeEntryName } from '../../common/inpx-container';

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length === 0 ? null : value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  return null;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNullableNumber(value: unknown): number | null {
  return toNumber(value);
}
