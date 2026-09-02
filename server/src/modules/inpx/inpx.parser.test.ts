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

async function buildInpxArchive(root: string, createDatabase: (dbPath: string) => void): Promise<string> {
  const dbPath = join(root, 'rus.inp');
  const archivePath = join(root, 'library.inpx');
  createDatabase(dbPath);

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(archivePath);
    const archive = new ZipArchive({ zlib: { level: 1 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.file(dbPath, { name: 'rus.inp' });
    archive.append('<FictionBook/>', { name: 'r/rus00001.fb2' });
    archive.append('<FictionBook/>', { name: 'a/arthur_c_doyle/hound.fb2' });
    archive.append('<FictionBook/>', { name: 'r/rus00002.fb2' });
    archive.append('<FictionBook/>', { name: 'r/rus00004.epub' });
    void archive.finalize();
  });

  await rm(dbPath, { force: true });
  return archivePath;
}
