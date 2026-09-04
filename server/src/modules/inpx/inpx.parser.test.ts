import { ZipArchive } from 'archiver';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InpxParser } from './inpx.parser';

describe('InpxParser', () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'bookorbit-inpx-test-'));
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it('parses books and resolves authors, genres, series and language', async () => {
    const archivePath = await buildInpxArchive(testRoot, createInpxDatabase);
    const parser = new InpxParser();

    const result = await parser.parse(archivePath);

    expect(result.languages).toEqual(['en']);
    expect(result.totalIndexedBooks).toBe(5);
    expect(result.skippedDel).toBe(1);
    expect(result.skippedNoFile).toBe(1);
    expect(result.skippedUnsupported).toBe(1);
    expect(result.books).toHaveLength(2);

    const [study, hound] = result.books;
    expect(study.title).toBe('A Study in Scarlet');
    expect(study.authors).toEqual(['Arthur Conan Doyle']);
    expect(study.genres).toEqual(['Classic Detective', 'Police Detective']);
    expect(study.seriesName).toBe('Sherlock Holmes');
    expect(study.seriesIndex).toBe('1');
    expect(study.language).toBe('en');
    expect(study.file).toBe('r/rus00001.fb2');
    expect(study.format).toBe('fb2');
    expect(study.sizeBytes).toBe(123456);

    expect(hound.title).toBe('The Hound of the Baskervilles');
    expect(hound.genres).toEqual(['Classic Detective']);
    expect(hound.seriesIndex).toBe('2');
  });

  it('falls back to author rows when the denormalized authors column is empty', async () => {
    const archivePath = await buildInpxArchive(testRoot, (dbPath) => {
      createInpxDatabase(dbPath);
      const db = new DatabaseSync(dbPath, { readOnly: false });
      db.prepare("UPDATE books SET authors = '' WHERE id = 1").run();
      db.close();
    });
    const parser = new InpxParser();

    const result = await parser.parse(archivePath);

    const study = result.books.find((book) => book.title === 'A Study in Scarlet');
    expect(study?.authors).toEqual(['Conan Doyle Arthur']);
  });

  it('throws a descriptive error for a non-zip file', async () => {
    const badPath = join(testRoot, 'broken.inpx');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(badPath, 'not a zip');

    const parser = new InpxParser();
    await expect(parser.parse(badPath)).rejects.toThrow();
  });

  it('skips non-SQLite .inp entries and keeps the readable ones', async () => {
    const archivePath = await buildInpxArchive(testRoot, createInpxDatabase, [
      { name: 'garbage.inp', content: 'this is not a sqlite database at all' },
    ]);
    const parser = new InpxParser();

    const result = await parser.parse(archivePath);

    expect(result.books).toHaveLength(2);
    expect(result.failedIndexEntries).toEqual(['garbage.inp']);
  });

  it('throws a clear error when no index entry is readable', async () => {
    const archivePath = await buildInpxArchive(testRoot, () => undefined, [{ name: 'broken.inp', content: 'not sqlite at all' }], {
      includeInp: false,
    });
    const parser = new InpxParser();

    await expect(parser.parse(archivePath)).rejects.toThrow('no readable index');
    await expect(parser.parse(archivePath)).rejects.toThrow('broken.inp is not a readable index');
  });

  it('parses the Flibusta text catalog format and maps file ids to archive entries', async () => {
    const textIndex =
      'Громов,Александр,Николаевич\x04sf_social\x04Первый из могикан\x04Русская фантастика\x04\x04110119\x04511014\x04110119\x040\x04fb2\x042008-07-05\x041\x04ru\x043\x04\x042006\x04Flibusta\r\n' +
      'Громов,Александр,Николаевич\x04sf_heroic\x04Звёздный мост\x04\x04\x04110125\x04356607\x04110125\x040\x04fb2\x042008-07-05\x042\x04ru\x044\x04\x042005\x04Flibusta\r\n' +
      'Пупкин,Вася,Иванович\x04det_classic\x04Пустой год\x04\x04\x0412345\x041234\x0412345\x040\x04fb2\x042020-01-01\x041\x04ru\x043\x04\x040\x04Flibusta\r\n';
    const archivePath = await buildInpxArchiveWithExtra(
      testRoot,
      [{ name: 'rus.inp', content: textIndex }],
      [
        { name: '110119.fb2', content: '<FictionBook/>' },
        { name: '110125.fb2', content: '<FictionBook/>' },
        { name: '12345.fb2', content: '<FictionBook/>' },
      ],
    );
    const parser = new InpxParser();

    const result = await parser.parse(archivePath);

    expect(result.totalIndexedBooks).toBe(3);
    expect(result.books).toHaveLength(3);
    const [first, second, third] = result.books;
    expect(first.title).toBe('Первый из могикан');
    expect(first.authors).toEqual(['Александр Николаевич Громов']);
    expect(first.genres).toEqual(['Social Science Fiction']);
    expect(first.seriesName).toBe('Русская фантастика');
    expect(first.seriesIndex).toBeNull();
    expect(first.language).toBe('ru');
    expect(first.publishedYear).toBe(2006);
    expect(first.file).toBe('110119.fb2');
    expect(first.fileId).toBe('110119');
    expect(first.sizeBytes).toBe(511014);
    expect(second.title).toBe('Звёздный мост');
    expect(second.seriesIndex).toBeNull();
    expect(second.publishedYear).toBe(2005);
    // Empty YEAR must not become 0 and trip the DB's published_year check.
    expect(third.publishedYear).toBeNull();
  });

  it('normalizes the "First Middle: Last" colon author format', async () => {
    const textIndex =
      'Александр Сергеевич: Пушкин\x04det_classic\x04Капитанская дочка\x04\x04\x04555001\x04123456\x04555001\x040\x04fb2\x042022-01-01\x041\x04ru\x043\x04\x041836\x04Flibusta\r\n' +
      'Лев Николаевич: Толстой,Фёдор Михайлович: Достоевский\x04prose_classic\x04Сборник\x04\x04\x04555002\x04999\x04555002\x040\x04fb2\x042022-01-01\x041\x04ru\x043\x04\x041900\x04Flibusta\r\n';
    const archivePath = await buildInpxArchiveWithExtra(
      testRoot,
      [{ name: 'rus.inp', content: textIndex }],
      [
        { name: '555001.fb2', content: '<FictionBook/>' },
        { name: '555002.fb2', content: '<FictionBook/>' },
      ],
    );
    const parser = new InpxParser();

    const result = await parser.parse(archivePath);

    const [first, second] = result.books;
    expect(first.authors).toEqual(['Александр Сергеевич Пушкин']);
    expect(first.file).toBe('555001.fb2');
    expect(second.authors).toEqual(['Лев Николаевич Толстой', 'Фёдор Михайлович Достоевский']);
  });
});

function createInpxDatabase(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE authors (
      id INTEGER PRIMARY KEY,
      firstname TEXT, middlename TEXT, lastname TEXT, nickname TEXT,
      homepage TEXT, email TEXT, description TEXT, libid INTEGER
    );
    CREATE TABLE books (
      id INTEGER PRIMARY KEY,
      file TEXT, booktitle TEXT, authorid TEXT, authors TEXT, booklang TEXT,
      genre TEXT, seqid TEXT, seqname TEXT, seqnumber REAL, scrname TEXT,
      libraryid INTEGER, del INTEGER, ext TEXT, date TEXT, size INTEGER
    );
  `);
  db.prepare('INSERT INTO authors VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(1, 'Arthur', null, 'Conan Doyle', null, null, null, null, null);
  db.prepare('INSERT INTO books VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    1,
    'r/rus00001.fb2',
    'A Study in Scarlet',
    '1',
    'Arthur Conan Doyle',
    'en',
    'det_classic,det_police',
    '10',
    'Sherlock Holmes',
    1,
    null,
    null,
    0,
    'fb2',
    '2020-01-01',
    123456,
  );
  db.prepare('INSERT INTO books VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    2,
    'a/arthur_c_doyle/hound.fb2',
    'The Hound of the Baskervilles',
    '1',
    'Arthur Conan Doyle',
    'en',
    'det_classic',
    '10',
    'Sherlock Holmes',
    2,
    null,
    null,
    0,
    'fb2',
    '2020-01-02',
    1000,
  );
  db.prepare('INSERT INTO books VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    3,
    'r/rus00002.fb2',
    'Deleted Book',
    '1',
    'Arthur Conan Doyle',
    'en',
    'det_classic',
    null,
    null,
    null,
    null,
    null,
    1,
    'fb2',
    '2020-01-03',
    500,
  );
  db.prepare('INSERT INTO books VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    4,
    'r/rus00003.fb2',
    'Missing File Book',
    '1',
    'Arthur Conan Doyle',
    'en',
    'det_classic',
    null,
    null,
    null,
    null,
    null,
    0,
    'fb2',
    '2020-01-04',
    500,
  );
  db.prepare('INSERT INTO books VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    5,
    'r/rus00004.epub',
    'Unsupported Format Book',
    '1',
    'Arthur Conan Doyle',
    'en',
    'det_classic',
    null,
    null,
    null,
    null,
    null,
    0,
    'epub',
    '2020-01-05',
    500,
  );
  db.close();
}

async function buildInpxArchive(
  root: string,
  createDatabase: (dbPath: string) => void,
  extraEntries: { name: string; content: string }[] = [],
  options: { includeInp?: boolean } = {},
): Promise<string> {
  const dbPath = join(root, 'rus.inp');
  const archivePath = join(root, 'library.inpx');
  createDatabase(dbPath);
  const includeInp = options.includeInp ?? true;

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(archivePath);
    const archive = new ZipArchive({ zlib: { level: 1 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    if (includeInp) archive.file(dbPath, { name: 'rus.inp' });
    archive.append('<FictionBook/>', { name: 'r/rus00001.fb2' });
    archive.append('<FictionBook/>', { name: 'a/arthur_c_doyle/hound.fb2' });
    archive.append('<FictionBook/>', { name: 'r/rus00002.fb2' });
    archive.append('<FictionBook/>', { name: 'r/rus00004.epub' });
    for (const entry of extraEntries) {
      archive.append(entry.content, { name: entry.name });
    }
    void archive.finalize();
  });

  await rm(dbPath, { force: true });
  return archivePath;
}

async function buildInpxArchiveWithExtra(
  root: string,
  entries: { name: string; content: string }[],
  bookEntries: { name: string; content: string }[],
): Promise<string> {
  const archivePath = join(root, 'library.inpx');

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(archivePath);
    const archive = new ZipArchive({ zlib: { level: 1 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const entry of entries) archive.append(entry.content, { name: entry.name });
    for (const entry of bookEntries) archive.append(entry.content, { name: entry.name });
    void archive.finalize();
  });

  return archivePath;
}
