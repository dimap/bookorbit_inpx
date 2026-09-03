# INPX Archive Support

Status of the work done so far, for future AI agents and contributors to pick up.

## Overview

BookOrbit can now import books from self-contained **INPX** archives. An INPX file is a ZIP that
bundles `.inp` indexes (SQLite databases) together with the FB2 books they reference. Books are
served directly from the archive at read/download time, so nothing is copied to disk.

This is the "read from archive" (option B) approach chosen over extracting files to disk: it keeps
a multi-hundred-GB Flibusta library on disk exactly once.

## Current status

- The feature is implemented end to end (backend + client) but **not committed**.
- Working tree on `main` holds all changes. The plan is to commit them on a feature branch
  `feat/inpx-support` and push to the user's personal fork `dimap/bookorbit_inpx` (remote `fork`).
- A DB migration `0086_add-inpx.sql` is generated but **not applied** locally (no local DB).
- Tests, typecheck, lint all pass; the only failures seen are pre-existing Windows issues in
  `book.service.test.ts` (4) and `file-watcher.service.test.ts` (1) that exist without these
  changes too.

## Data model

### New table `inpx_archives` (`server/src/db/schema/inpx.ts`)

One row per registered archive. Fields: `id`, `libraryId` (FK cascade), `name`, `absolutePath`,
`sizeBytes`, `mtimeMs`, `status` (`pending` | `importing` | `complete` | `failed`), `totalBooks`,
`importedBooks`, `enrichedBooks`, `errorMessage`, `lastImportedAt`. Unique on
`(libraryId, absolutePath)`.

### `book_files` additions (`server/src/db/schema/books.ts`)

- `storageKind` varchar(20) default `filesystem`, check `('filesystem','inpx')`.
- `archiveEntryPath` varchar(4096) - normalized path of the entry inside the archive.
- `inpxArchiveId` integer FK -> `inpx_archives.id` (on delete cascade).
- `ino` is now nullable (archive files have no inode).

Constraints: `book_files_inpx_entry_chk` requires an `inpx` row to carry both
`archiveEntryPath` and `inpxArchiveId`.

### Virtual library folders

Each archive gets a virtual `library_folders` row whose `path` is `inpx://<archiveId>`. Books
inserted from the archive point at it (`books.libraryFolderId`, `book_files.libraryFolderId`), and
`books.folderPath` / `book_files.absolutePath` are the synthetic `inpx://<archiveId>/<entryPath>`.

The scanner and file watcher skip virtual folders so INPX books are never marked missing:

- `scanner.repository.ts` -> `findLibraryFolders()` filters `notLike(path, 'inpx://%')`.
- `file-watcher.service.ts` -> folder query filters the same way.

## Backend module: `server/src/modules/inpx/`

| File                     | Purpose                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `inpx.parser.ts`         | Opens the ZIP (`unzipper.Open.file`), reads each `.inp` with `node:sqlite` (`DatabaseSync`, read-only, defensive), filters `del=1`, normalizes to `InpxBookRecord[]`. Exports `normalizeEntryName`.                                                                                                                                                          |
| `fb2-genres.ts`          | FB2 genre code -> human-readable name map (`FB2_GENRE_NAMES`, `resolveFb2GenreName`). Unknown codes are prettified.                                                                                                                                                                                                                                          |
| `inpx.repository.ts`     | Archive CRUD, virtual folder helpers, `importBooksChunked()` (chunked, transactional, idempotent via `onConflictDoNothing` on `(libraryId, folderPath)`). Constants: `INPX_BOOKS_CHUNK_SIZE = 300`.                                                                                                                                                          |
| `inpx.import.service.ts` | Background import. Phase 1 `index` inserts books from the index; phase 2 `enrich` extracts each FB2 to a temp file and runs the existing `MetadataService.extractAndSave(bookId, temp, 'fb2')` (cover, ISBN, description, author sort names). Bounded concurrency 4, per-book failure is logged and skipped. `startImport()` is re-entrant (shares one run). |
| `inpx.service.ts`        | Orchestration: `register`, `list`, `get`, `import`, `remove`. Validates the path (absolute, `.inpx`, exists, is file). Removing an archive deletes its books (cascade) then the archive and its virtual folder.                                                                                                                                              |
| `inpx.controller.ts`     | Routes below. `register`/`import`/`remove` are gated by `Permission.LibraryUpload` + `RequireLibraryAccess('editor')`; `list`/`get` by `RequireLibraryAccess('viewer')`.                                                                                                                                                                                     |
| `inpx.gateway.ts`        | WebSocket namespace `/inpx`, events `inpx:progress` and `inpx:completed`, auth like `scan.gateway`.                                                                                                                                                                                                                                                          |
| `inpx-progress.store.ts` | In-memory progress snapshots so the hot path does not write the DB per book.                                                                                                                                                                                                                                                                                 |
| `inpx.module.ts`         | Imports `LibraryModule`, `MetadataModule`, `AuthModule`, `JwtModule.registerAsync` (same factory as scanner). Registered in `app.module.ts`.                                                                                                                                                                                                                 |

### Import pipeline

1. `POST /inpx/archives/:id/import` -> `InpxImportService.startImport(archiveId)` (fire and forget).
2. Resolve/create the virtual folder `inpx://<archiveId>`.
3. **Index phase**: `InpxParser.parse()` reads all `.inp` files; books are inserted in chunks of 300,
   each chunk in its own transaction. Authors/genres are upserted by name, series via
   `SeriesIdentityService`. Progress is emitted per chunk.
4. **Enrich phase**: for each newly created book, the FB2 entry is extracted to a temp file and
   `metadataService.extractAndSave(bookId, tempPath, 'fb2')` runs; the temp file is removed. 4
   workers, progress emitted every 10 items and at the end.
5. Archive row is marked `complete` (or `failed` with `errorMessage`); `inpx:completed` is emitted.

Idempotency: re-running the import skips books whose `folderPath` already exists, so a partial run
resumes instead of duplicating.

### API routes

| Method   | Path                                         | Purpose                               |
| -------- | -------------------------------------------- | ------------------------------------- |
| `POST`   | `/api/v1/inpx/libraries/:libraryId/archives` | Register an archive `{ name, path }`. |
| `GET`    | `/api/v1/inpx/libraries/:libraryId/archives` | List archives for a library.          |
| `GET`    | `/api/v1/inpx/archives/:id`                  | Archive detail.                       |
| `POST`   | `/api/v1/inpx/archives/:id/import`           | Start import (202).                   |
| `DELETE` | `/api/v1/inpx/archives/:id`                  | Remove archive + its books (204).     |

WS namespace `/inpx`: client emits `subscribe:library <libraryId>`; server sends
`inpx:progress` (`{ archiveId, libraryId, phase: 'index'|'enrich', status, processed, total }`) and
`inpx:completed` (`{ archiveId, libraryId, importedBooks, enrichedBooks }`).

## Serving integration (archive-aware reads)

Everything that resolves a file goes through `book.service.getFileInfo`, which now returns an
optional `archive: { archivePath, entry: CbzZipEntry }` for `storageKind === 'inpx'`:

- `book.service.ts` -> `getInpxFileInfo()` / `resolveInpxExportEntry()` use `readCbzZipIndex` and
  `normalizeArchiveEntryName` to find the entry inside the archive.
- `book.controller.ts` -> `serveFile` and `downloadFile` stream via
  `createCbzZipEntryReadStream(archivePath, entry)` instead of `createReadStream(path)`. Range
  requests are not supported for archive files (FB2 is fetched whole by the client/Foliate).
- Export (`streamBookExport`) appends the entry stream via `archive.append(...)` for archive files.
- `renameFile` rejects `storageKind === 'inpx'` with `BadRequestException`.
- `book.repository.ts` `findFileById` / `findPrimaryFilesByBookIds` / `findAllFilesByBookIds` now
  select the new `book_files` columns; added `findInpxArchiveAbsolutePath(archiveId)`.

No changes were needed to the client reader: FB2 is already fetched whole through
`GET /books/files/:fileId/serve` and rendered by Foliate.

## Client UI

- `client/src/features/inpx/composables/useInpxArchives.ts` - data + WS progress (socket singleton
  in `/inpx`, re-subscribes on reconnect, mirrors `useScanProgress`).
- `client/src/features/inpx/components/InpxArchivesPanel.vue` - archive list (status badge,
  counters, progress bar), register form, import/remove buttons. Mounted in
  `LibraryDetailPanel.vue`. Actions gated by `Permission.LibraryUpload`.
- i18n keys under `settings.admin.libraries.inpx.*` in `en.json` and `ru.json`.

## Shared types

`packages/types/src/inpx.ts` (exported from `index.ts`): `InpxArchiveStatus`, `InpxArchive`,
`RegisterInpxArchiveInput`, `InpxImportProgressEvent`, `InpxImportCompletedEvent`.

## Verification done

- Server: `tsc --noEmit -p tsconfig.build.json` clean; `eslint` clean on all touched files.
- Client: `vue-tsc --build` clean; `eslint` clean; `validate-locales.mjs` passes.
- Tests: `inpx.parser.test.ts` (3) + `inpx.import.service.test.ts` (5) pass.
- Pre-existing unrelated failures on Windows (present without these changes):
  - `book.service.test.ts` 4 tests (path separator `\tmp\...` vs `/tmp/...`).
  - `file-watcher.service.test.ts` 1 test (timing).

## Known limitations

- Only `fb2` / `fb2.zip` entries are imported; other formats in the index are skipped and counted.
- Byte-range requests are not supported for archive-backed files.
- Book rename/move of archive files is blocked server-side; the UI may still show those actions
  (a follow-up should hide them for `storageKind === 'inpx'`).
- Metadata write-back to files (`file-write`) is a no-op for archive files.

## Deployment

1. Apply the migration: `cd server && pnpm db:migrate` (generated as `0086_add-inpx.sql`).
2. Register an archive by absolute server path (e.g. `/data/flibusta.inpx`) in the library detail
   panel and start the import.

## Git state / next steps

- Everything lives uncommitted on `main`. Intended flow:
  - branch `feat/inpx-support` off `main`,
  - commit the feature files (list below) with `--no-verify`
    (hooks cannot run on this machine: `pnpm` is not on PATH, and `pre-push` runs `verify:fast`),
  - push to remote `fork` (`https://github.com/dimap/bookorbit_inpx.git`) with `--no-verify`.
- Push auth for the personal account uses a repo-local credential store
  (`credential.helper "store --file=C:/Users/TM QA/.git-credentials-dimap"`), so the work GCM
  credential for `github.com` is bypassed.
- Feature files to stage: new `client/src/features/inpx/`, `packages/types/src/inpx.ts`,
  `server/src/modules/inpx/`, `server/src/db/schema/inpx.ts`,
  `server/src/db/migrations/0086_add-inpx.sql`, `server/src/db/migrations/meta/0086_snapshot.json`;
  modified `client/src/features/settings/libraries/components/LibraryDetailPanel.vue`,
  `client/src/locales/{en,ru}.json`, `packages/types/src/index.ts`, `server/src/app.module.ts`,
  `server/src/db/schema/{books,index}.ts`, `server/src/db/migrations/meta/_journal.json`,
  `server/src/modules/book/{controller,repository,service}.ts`,
  `server/src/modules/scanner/{scanner.repository,file-watcher.service}.ts`.

## Suggested follow-ups

- Hide rename/move/export-only actions in the UI for `storageKind === 'inpx'` files.
- Re-import reconciliation: detect when the archive file on disk changes (`mtimeMs`) and offer a
  delta re-import.
- Per-language `.inp` handling is already aggregated; consider surfacing language counts in the UI.
