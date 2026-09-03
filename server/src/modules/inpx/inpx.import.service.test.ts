import { InpxGateway } from './inpx.gateway';
import { InpxImportService } from './inpx.import.service';
import { InpxProgressStore } from './inpx-progress.store';
import { InpxParser } from './inpx.parser';
import { InpxRepository } from './inpx.repository';
import { MetadataService } from '../metadata/metadata.service';

vi.mock('../../common/cbz-zip-reader', () => ({
  readCbzZipIndex: vi.fn(),
  extractCbzZipEntry: vi.fn(),
  createCbzZipEntryReadStream: vi.fn(),
}));
import { extractCbzZipEntry, readCbzZipIndex } from '../../common/cbz-zip-reader';

const ZIP_ENTRIES = [
  { name: 'r/rus00001.fb2', compression: 8, compressedSize: 10, uncompressedSize: 10, localHeaderOffset: 0, dataStart: 0 },
  { name: 'r/rus00002.fb2', compression: 8, compressedSize: 10, uncompressedSize: 10, localHeaderOffset: 0, dataStart: 0 },
];

describe('InpxImportService', () => {
  const repo = {
    findArchiveById: vi.fn(),
    findVirtualFolderByPath: vi.fn(),
    createVirtualFolder: vi.fn(),
    updateArchive: vi.fn(),
    importBooksChunked: vi.fn(),
  };
  const parser = { parse: vi.fn() };
  const metadataService = { extractAndSave: vi.fn() };
  const gateway = { emitProgress: vi.fn(), emitCompleted: vi.fn() };

  let service: InpxImportService;

  beforeEach(() => {
    vi.resetAllMocks();
    const progressStore = new InpxProgressStore();
    service = new InpxImportService(
      parser as unknown as InpxParser,
      repo as unknown as InpxRepository,
      metadataService as unknown as MetadataService,
      gateway as unknown as InpxGateway,
      progressStore,
    );
    repo.findArchiveById.mockResolvedValue({
      id: 11,
      libraryId: 3,
      name: 'test',
      absolutePath: '/data/test.inpx',
      status: 'pending',
      totalBooks: 0,
      importedBooks: 0,
      enrichedBooks: 0,
    });
    repo.findVirtualFolderByPath.mockResolvedValue(7);
    repo.importBooksChunked.mockResolvedValue({
      imported: 2,
      skipped: 0,
      createdBookIds: [101, 102],
      bookEntries: [
        { bookId: 101, entryPath: 'r/rus00001.fb2' },
        { bookId: 102, entryPath: 'r/rus00002.fb2' },
      ],
    });
    parser.parse.mockResolvedValue({
      books: [
        { file: 'r/rus00001.fb2', format: 'fb2', title: 'One' },
        { file: 'r/rus00002.fb2', format: 'fb2', title: 'Two' },
      ],
      languages: ['ru'],
      totalIndexedBooks: 2,
      skippedDel: 0,
      skippedNoFile: 0,
      skippedEmptyTitle: 0,
      skippedUnsupported: 0,
      failedIndexEntries: [],
    });
    metadataService.extractAndSave.mockResolvedValue(undefined);
    (readCbzZipIndex as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ entries: ZIP_ENTRIES, comment: null });
    (extractCbzZipEntry as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('<FictionBook/>'));
  });

  it('imports the index, enriches from the archive and marks the archive complete', async () => {
    await service.startImport(11);

    expect(repo.findArchiveById).toHaveBeenCalledWith(11);
    expect(repo.findVirtualFolderByPath).toHaveBeenCalledWith(3, 'inpx://11');
    expect(repo.importBooksChunked).toHaveBeenCalledWith(3, 7, 11, expect.any(Array));
    expect(repo.updateArchive).toHaveBeenCalledWith(11, expect.objectContaining({ status: 'importing' }));
    expect(repo.updateArchive).toHaveBeenCalledWith(11, expect.objectContaining({ totalBooks: 2 }));
    expect(repo.updateArchive).toHaveBeenCalledWith(11, expect.objectContaining({ importedBooks: 2 }));
    expect(metadataService.extractAndSave).toHaveBeenCalledTimes(2);
    expect(metadataService.extractAndSave).toHaveBeenCalledWith(101, expect.any(String), 'fb2');
    expect(repo.updateArchive).toHaveBeenCalledWith(11, expect.objectContaining({ status: 'complete', enrichedBooks: 2 }));
    expect(gateway.emitCompleted).toHaveBeenCalledWith({
      archiveId: 11,
      libraryId: 3,
      importedBooks: 2,
      enrichedBooks: 2,
    });
  });

  it('shares one run across concurrent startImport calls', async () => {
    const run = service.startImport(11);
    const second = service.startImport(11);

    await Promise.all([run, second]);
    expect(parser.parse).toHaveBeenCalledTimes(1);
  });

  it('marks the archive failed when the index parse throws', async () => {
    parser.parse.mockRejectedValue(new Error('corrupt zip'));

    await expect(service.startImport(11)).rejects.toThrow('corrupt zip');
    expect(repo.updateArchive).toHaveBeenCalledWith(11, expect.objectContaining({ status: 'failed', errorMessage: 'corrupt zip' }));
  });

  it('keeps enriching when a single book fails to extract', async () => {
    metadataService.extractAndSave.mockRejectedValueOnce(new Error('bad fb2'));

    await service.startImport(11);

    expect(metadataService.extractAndSave).toHaveBeenCalledTimes(2);
    expect(repo.updateArchive).toHaveBeenCalledWith(11, expect.objectContaining({ status: 'complete', enrichedBooks: 1 }));
  });

  it('tracks live progress in the store and clears it when done', async () => {
    const run = service.startImport(11);
    await run;
    expect(service.getProgress(11)).toBeUndefined();
    const phases = gateway.emitProgress.mock.calls.map((call) => (call[0] as { phase: string }).phase);
    expect(phases).toContain('index');
    expect(phases).toContain('enrich');
  });
});
