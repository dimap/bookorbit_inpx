import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { InpxArchive, InpxArchiveStatus } from '@bookorbit/types';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { RequestUser } from '../../common/types/request-user';
import { LibraryService } from '../library/library.service';
import { InpxImportService } from './inpx.import.service';
import { InpxRepository } from './inpx.repository';
import { RegisterInpxArchiveDto } from './dto/register-inpx-archive.dto';

type InpxArchiveRow = Awaited<ReturnType<InpxRepository['findArchiveById']>> & {};

@Injectable()
export class InpxService {
  private readonly logger = new Logger(InpxService.name);

  constructor(
    private readonly repo: InpxRepository,
    private readonly importService: InpxImportService,
    private readonly libraryService: LibraryService,
  ) {}

  async register(libraryId: number, dto: RegisterInpxArchiveDto, user: RequestUser): Promise<InpxArchive> {
    const event = 'inpx.register';
    const startedAt = Date.now();
    this.logger.log(
      `[${event}] [start] libraryId=${libraryId} userId=${user.id} name="${sanitizeLogValue(dto.name)}" - register inpx archive started`,
    );
    try {
      await this.verifyLibraryAccess(user, libraryId);

      if (!isAbsolute(dto.path)) {
        throw new BadRequestException('INPX archive path must be absolute');
      }
      if (!/\.inpx$/i.test(dto.path)) {
        throw new BadRequestException('INPX archive path must end with .inpx');
      }

      let fileStat;
      try {
        fileStat = await stat(dto.path);
      } catch {
        throw new BadRequestException('INPX archive path does not exist on disk');
      }
      if (!fileStat.isFile()) {
        throw new BadRequestException('INPX archive path is not a file');
      }

      const archive = await this.repo.createArchive({
        libraryId,
        name: dto.name,
        absolutePath: dto.path,
        sizeBytes: fileStat.size,
        mtimeMs: Math.round(fileStat.mtimeMs),
        status: 'pending',
      });

      const virtualPath = `inpx://${archive.id}`;
      const existingFolderId = await this.repo.findVirtualFolderByPath(libraryId, virtualPath);
      if (existingFolderId == null) {
        await this.repo.createVirtualFolder(libraryId, virtualPath);
      }

      this.logger.log(
        `[${event}] [end] archiveId=${archive.id} libraryId=${libraryId} durationMs=${Date.now() - startedAt} sizeBytes=${fileStat.size} - register inpx archive completed`,
      );
      return this.toApiArchive(archive);
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      if (err instanceof BadRequestException || err instanceof ForbiddenException) throw err;
      const error = err instanceof Error ? err : new Error(String(err));
      const errorMessage = sanitizeLogValue(error.message);
      this.logger.warn(
        `[${event}] [fail] libraryId=${libraryId} userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${error.name} error="${errorMessage}" - register inpx archive failed`,
      );
      if (isUniqueViolation(err)) throw new ConflictException('An INPX archive at this path is already registered');
      throw err;
    }
  }

  async list(libraryId: number, user: RequestUser): Promise<InpxArchive[]> {
    await this.verifyLibraryAccess(user, libraryId);
    const archives = await this.repo.findArchivesByLibrary(libraryId);
    return archives.map((archive) => this.toApiArchive(archive));
  }

  async get(archiveId: number, user: RequestUser): Promise<InpxArchive> {
    const archive = await this.findOwnedArchive(archiveId, user);
    return this.toApiArchive(archive);
  }

  async import(archiveId: number, user: RequestUser): Promise<InpxArchive> {
    const archive = await this.findOwnedArchive(archiveId, user);
    if (this.importService.isRunning(archiveId)) {
      throw new BadRequestException('INPX import is already running for this archive');
    }
    void this.importService.startImport(archiveId).catch(() => undefined);
    return this.toApiArchive(archive);
  }

  async enrich(archiveId: number, user: RequestUser): Promise<InpxArchive> {
    const archive = await this.findOwnedArchive(archiveId, user);
    if (this.importService.isRunning(archiveId)) {
      throw new BadRequestException('INPX import or enrichment is already running for this archive');
    }
    void this.importService.enrich(archiveId).catch(() => undefined);
    return this.toApiArchive(archive);
  }

  async remove(archiveId: number, user: RequestUser): Promise<void> {
    const event = 'inpx.remove';
    const startedAt = Date.now();
    const archive = await this.findOwnedArchive(archiveId, user);
    this.logger.log(`[${event}] [start] archiveId=${archiveId} libraryId=${archive.libraryId} userId=${user.id} - remove inpx archive started`);
    try {
      if (this.importService.isRunning(archiveId)) {
        throw new BadRequestException('Cannot remove an INPX archive while its import is running');
      }

      const deletedBooks = await this.repo.deleteBooksByArchive(archiveId);
      await this.repo.deleteArchive(archiveId);
      const virtualPath = `inpx://${archiveId}`;
      const folderId = await this.repo.findVirtualFolderByPath(archive.libraryId, virtualPath);
      if (folderId != null) {
        await this.repo.deleteVirtualFolderIfEmpty(folderId);
      }

      this.logger.log(
        `[${event}] [end] archiveId=${archiveId} durationMs=${Date.now() - startedAt} deletedBooks=${deletedBooks} - remove inpx archive completed`,
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const errorMessage = sanitizeLogValue(error.message);
      this.logger.warn(
        `[${event}] [fail] archiveId=${archiveId} durationMs=${Date.now() - startedAt} errorClass=${error.name} error="${errorMessage}" - remove inpx archive failed`,
      );
      throw err;
    }
  }

  private async findOwnedArchive(archiveId: number, user: RequestUser): Promise<InpxArchiveRow> {
    const archive = await this.repo.findArchiveById(archiveId);
    if (!archive) throw new NotFoundException(`INPX archive ${archiveId} not found`);
    await this.verifyLibraryAccess(user, archive.libraryId);
    return archive;
  }

  private async verifyLibraryAccess(user: RequestUser, libraryId: number): Promise<void> {
    await this.libraryService.verifyUserAccess(user.id, libraryId, user.isSuperuser);
  }

  private toApiArchive(archive: InpxArchiveRow): InpxArchive {
    return {
      id: archive.id,
      libraryId: archive.libraryId,
      name: archive.name,
      absolutePath: archive.absolutePath,
      sizeBytes: archive.sizeBytes,
      mtimeMs: archive.mtimeMs,
      status: archive.status as InpxArchiveStatus,
      totalBooks: archive.totalBooks,
      importedBooks: archive.importedBooks,
      enrichedBooks: archive.enrichedBooks,
      errorMessage: archive.errorMessage,
      lastImportedAt: archive.lastImportedAt?.toISOString() ?? null,
      createdAt: archive.createdAt.toISOString(),
    };
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === '23505' || code === 'ER_DUP_ENTRY';
}
