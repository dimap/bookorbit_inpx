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
  publishedYear: number | null;
  /** Per-book identifier used to derive the FB2 entry name (`fb2-<id>.fb2`). */
  fileId: string | null;
  /** The `.inp` shard this record came from; its base name maps to a companion `.7z` archive. */
  sourceArchiveName: string | null;
  /** Resolved by the importer: companion archive that holds the FB2 entry (null = inside the INPX). */
  sourceArchivePath: string | null;
}

export interface InpxParseResult {
  books: InpxBookRecord[];
  languages: string[];
  containerKind: 'zip' | '7z';
  totalEntries: number;
  inpEntryCount: number;
  fb2EntryCount: number;
  sampleBookEntries: string[];
  /** Contents of small auxiliary files like structure.info/version.info, which describe the layout. */
  infoFiles: { name: string; content: string }[];
  totalIndexedBooks: number;
  skippedDel: number;
  skippedNoFile: number;
  skippedEmptyTitle: number;
  skippedUnsupported: number;
  /** `.inp` entries that existed but could not be read (not SQLite, or unreadable). */
  failedIndexEntries: string[];
  /** Why each failed entry was rejected, for diagnostics. */
  indexFailureReasons: { name: string; reason: string }[];
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
      // The catalog ships `fb2` shards (books) next to `usr` shards (users); only the former parse
      // as books.
      const inpEntries = entries.filter((entry) => /\.inp$/i.test(entry.name) && !/usr/i.test(entry.name));
      const fb2EntryCount = entries.filter((entry) => /\.fb2(\.zip)?$/i.test(entry.name)).length;
      const sampleBookEntries = entries
        .filter((entry) => !/\.inp$/i.test(entry.name))
        .slice(0, 5)
        .map((entry) => entry.name);
      const infoFiles: { name: string; content: string }[] = [];
      for (const info of entries.filter((entry) => /\.info$/i.test(entry.name)).slice(0, 5)) {
        const buffer = await container.readEntry(info.name);
        if (buffer && buffer.length > 0 && buffer.length <= 8192) {
          infoFiles.push({ name: info.name, content: buffer.toString('utf8').slice(0, 600) });
        }
      }
      const tempDir = await mkdtemp(join(tmpdir(), 'bookorbit-inpx-'));
      const languages = new Set<string>();
      const books: InpxBookRecord[] = [];
      const failedIndexEntries: string[] = [];
      const indexFailureReasons: { name: string; reason: string }[] = [];
      const counts = {
        totalIndexedBooks: 0,
        skippedDel: 0,
        skippedNoFile: 0,
        skippedEmptyTitle: 0,
        skippedUnsupported: 0,
      };

      try {
        let crossChecked = false;
        for (const [index, inp] of inpEntries.entries()) {
          try {
            const buffer = await container.readEntry(inp.name);
            if (!buffer) {
              throw new Error('entry could not be read from the archive');
            }
            const parsed = await this.parseInpEntry(index, inp.name, buffer, tempDir, entryNames, languages, counts);
            books.push(...parsed);
          } catch (err) {
            // A single bad index must not sink the whole archive: other languages/producers may be
            // readable, and the failure names are surfaced in the result for the caller to log.
            let reason = err instanceof Error ? err.message : String(err);
            // For a ZIP read by the byte-offset reader, cross-check the first SQLite-rejected entry
            // through unzipper: tells us whether the bytes are genuinely not SQLite or the reader
            // handed us the wrong slice.
            if (container.kind === 'zip' && reason.includes('is not a SQLite database') && !crossChecked) {
              crossChecked = true;
              reason += ` (${await this.crossCheckSqlite(archivePath, inp.name)})`;
            }
            failedIndexEntries.push(inp.name);
            indexFailureReasons.push({ name: inp.name, reason });
          }
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }

      if (books.length === 0 && failedIndexEntries.length > 0) {
        const samples = indexFailureReasons
          .slice(0, 3)
          .map(({ name, reason }) => `${name} (${reason})`)
          .join(', ');
        const extra = failedIndexEntries.length > 3 ? ` and ${failedIndexEntries.length - 3} more` : '';
        throw new Error(`INPX archive has no readable index (failed: ${samples}${extra})`);
      }

      return {
        books,
        languages: [...languages],
        containerKind: container.kind,
        totalEntries: entries.length,
        inpEntryCount: inpEntries.length,
        fb2EntryCount,
        sampleBookEntries,
        infoFiles,
        failedIndexEntries,
        indexFailureReasons,
        ...counts,
      };
    } finally {
      await container.close();
    }
  }

  private async crossCheckSqlite(archivePath: string, entryName: string): Promise<string> {
    try {
      const { Open } = await import('unzipper');
      const archive = await Open.file(archivePath);
      const file = archive.files.find((candidate) => normalizeEntryName(candidate.path) === normalizeEntryName(entryName));
      if (!file) return 'unzipper: entry missing';
      const buffer = await file.buffer();
      if (isSqliteBuffer(buffer)) return 'unzipper: SQLite';
      const signature = [...buffer.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
      return `unzipper: not SQLite (${buffer.length} bytes, signature "${signature}")`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `unzipper failed: ${message}`;
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
    if (isSqliteBuffer(buffer)) {
      return this.parseSqliteInp(index, entryName, buffer, tempDir, entryNames, languages, counts);
    }
    if (looksLikeTextInp(buffer)) {
      return this.parseTextInp(entryName, buffer, languages, counts);
    }
    // Not every `.inp` in the wild is a recognized index; skip rather than fail the archive, but
    // record the name, signature and a text preview so the caller can tell the user which entries
    // were ignored and what they actually are.
    const signature = [...buffer.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const rawPreview = buffer.subarray(0, 120).toString('utf8');
    let preview = '';
    for (const char of rawPreview) {
      const code = char.charCodeAt(0);
      preview += code < 32 && code !== 9 && code !== 10 && code !== 13 ? '.' : char;
    }
    preview = preview.replace(/\s+/g, ' ').trim();
    throw new Error(`${entryName} is not a readable index (${buffer.length} bytes, signature "${signature}", text "${preview}")`);
  }

  private async parseSqliteInp(
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

  /**
   * Flibusta's text catalog format: records split by CRLF, fields split by 0x04. Field order
   * (from the classic `lib.rus.ec`/Flibusta dump):
   *   authors, genres, title, series, seriesNumber, libid, fileid, bookid, del, ext, date,
   *   size, language, rating, ?, year, libraryName
   */
  private parseTextInp(
    shardName: string,
    buffer: Buffer,
    languages: Set<string>,
    counts: {
      totalIndexedBooks: number;
      skippedDel: number;
      skippedNoFile: number;
      skippedEmptyTitle: number;
      skippedUnsupported: number;
    },
  ): InpxBookRecord[] {
    const records: InpxBookRecord[] = [];
    const text = buffer.toString('utf8');
    for (const line of text.split(/\r\n|\r|\n/)) {
      if (line.length === 0) continue;
      const fields = line.split('\x04');
      if (fields.length < 8) continue;

      if (fields[8] === '1') {
        counts.skippedDel += 1;
        continue;
      }
      const title = (fields[2] ?? '').trim();
      if (!title) {
        counts.skippedEmptyTitle += 1;
        continue;
      }
      const ext = (fields[9] ?? '').toLowerCase();
      if (!SUPPORTED_BOOK_EXTENSIONS.has(ext)) {
        counts.skippedUnsupported += 1;
        continue;
      }
      const fileId = (fields[6] ?? '').trim();
      if (!fileId) {
        counts.skippedNoFile += 1;
        continue;
      }

      const language = (fields[12] ?? '').trim() || null;
      if (language) languages.add(language);
      counts.totalIndexedBooks += 1;

      records.push({
        file: `fb2-${fileId}.${ext === 'fb2.zip' ? 'zip' : ext}`,
        format: ext === 'fb2.zip' ? 'fb2' : ext,
        sizeBytes: null,
        title,
        authors: parseTextAuthors(fields[0] ?? ''),
        genres: this.resolveGenres(fields[1] ?? ''),
        seriesName: (fields[3] ?? '').trim() || null,
        seriesIndex: (fields[4] ?? '').trim() || null,
        language,
        publishedYear: toNullableNumber(fields[15]),
        fileId,
        sourceArchiveName: shardName,
        sourceArchivePath: null,
      });
    }
    return records;
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
        publishedYear: null,
        fileId: row.file ?? null,
        sourceArchiveName: null,
        sourceArchivePath: null,
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

/** A Flibusta text index: field separator 0x04 plus record separators. */
function looksLikeTextInp(buffer: Buffer): boolean {
  return buffer.length > 0 && buffer.includes(0x04) && (buffer.includes(0x0a) || buffer.includes(0x0d));
}

/**
 * Flibusta text authors are "Last,First,Middle" per author, authors separated by commas, so three
 * fields per person. Odd leftovers (a missing middle name) are joined as one name rather than lost.
 */
function parseTextAuthors(raw: string): string[] {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const names: string[] = [];
  for (let i = 0; i < parts.length;) {
    const rest = parts.slice(i);
    if (rest.length >= 3) {
      const name = [rest[1], rest[2], rest[0]].filter(Boolean).join(' ');
      if (name) names.push(name);
      i += 3;
    } else {
      const name = rest.join(' ');
      if (name) names.push(name);
      break;
    }
  }
  return names;
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
