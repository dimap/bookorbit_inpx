import { Injectable } from '@nestjs/common';
import type { InpxImportProgressEvent } from '@bookorbit/types';

/**
 * In-memory progress snapshot for in-flight INPX imports. Kept separate from the DB row so the
 * hot import path never writes the database for every book; the archive row is persisted at phase
 * boundaries and when the job finishes.
 */
@Injectable()
export class InpxProgressStore {
  private readonly progress = new Map<number, InpxImportProgressEvent>();

  set(event: InpxImportProgressEvent): void {
    this.progress.set(event.archiveId, event);
  }

  get(archiveId: number): InpxImportProgressEvent | undefined {
    return this.progress.get(archiveId);
  }

  getForLibrary(libraryId: number): InpxImportProgressEvent[] {
    return [...this.progress.values()].filter((entry) => entry.libraryId === libraryId);
  }

  clear(archiveId: number): void {
    this.progress.delete(archiveId);
  }
}
