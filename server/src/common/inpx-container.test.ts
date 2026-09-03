import { ZipArchive } from 'archiver';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getCachedInpxContainer, openInpxContainer } from './inpx-container';

describe('InpxContainer', () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'bookorbit-inpx-container-'));
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it('opens a ZIP archive, lists normalized entries and reads entry bytes', async () => {
    const archivePath = join(testRoot, 'library.inpx');
    await buildZip(archivePath, [
      { name: 'rus.inp', content: 'sqlite-bytes' },
      { name: 'a/author/book.fb2', content: '<FictionBook/>' },
    ]);

    const container = await openInpxContainer(archivePath);
    try {
      expect(container.kind).toBe('zip');
      expect(container.entries).toEqual(
        expect.arrayContaining([
          { name: 'rus.inp', size: 12 },
          { name: 'a/author/book.fb2', size: 14 },
        ]),
      );
      await expect(container.readEntry('a/author/book.fb2')).resolves.toEqual(Buffer.from('<FictionBook/>'));
      const stream = await container.readEntryStream('rus.inp');
      expect(stream?.size).toBe(12);
    } finally {
      await container.close();
    }
  });

  it('caches containers for the serving path', async () => {
    const archivePath = join(testRoot, 'library.inpx');
    await buildZip(archivePath, [{ name: 'rus.inp', content: 'sqlite-bytes' }]);

    const first = await getCachedInpxContainer(archivePath);
    const second = await getCachedInpxContainer(archivePath);
    expect(first).toBe(second);
    expect(first.entries).toHaveLength(1);
  });

  it('rejects a file that is neither ZIP nor 7z with the detected signature', async () => {
    const badPath = join(testRoot, 'broken.inpx');
    await writeFile(badPath, 'this is definitely not an archive');

    await expect(openInpxContainer(badPath)).rejects.toThrow('Unsupported INPX container');
  });
});

async function buildZip(archivePath: string, files: { name: string; content: string }[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(archivePath);
    const archive = new ZipArchive({ zlib: { level: 1 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const file of files) archive.append(file.content, { name: file.name });
    void archive.finalize();
  });
}
