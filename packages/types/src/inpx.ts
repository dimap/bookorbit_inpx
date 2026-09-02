export type InpxArchiveStatus = "pending" | "importing" | "complete" | "failed";

export interface InpxArchive {
  id: number;
  libraryId: number;
  name: string;
  absolutePath: string;
  sizeBytes: number | null;
  mtimeMs: number | null;
  status: InpxArchiveStatus;
  totalBooks: number;
  importedBooks: number;
  enrichedBooks: number;
  errorMessage: string | null;
  lastImportedAt: string | null;
  createdAt: string;
}

export interface RegisterInpxArchiveInput {
  name: string;
  path: string;
}

export interface InpxImportProgressEvent {
  archiveId: number;
  libraryId: number;
  phase: "index" | "enrich";
  status: InpxArchiveStatus;
  processed: number;
  total: number;
  errorMessage?: string;
}

export interface InpxImportCompletedEvent {
  archiveId: number;
  libraryId: number;
  importedBooks: number;
  enrichedBooks: number;
}