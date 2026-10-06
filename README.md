<div align="center">

# BookOrbit (INPX fork)

A self-hosted library and reading platform for ebooks, PDFs, audiobooks, and comics, with added
support for **INPX archive catalogs** (Flibusta / FLibrary / FlibRusEc).

**English** | [Русский](README.ru.md)

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg?style=flat-square&color=B461B3)](LICENSE)
[![Fork](https://img.shields.io/badge/fork-dimap%2Fbookorbit__inpx-2ea44f?style=flat-square&logo=github)](https://github.com/dimap/bookorbit_inpx)
[![Upstream](https://img.shields.io/badge/upstream-bookorbit%2Fbookorbit-blue?style=flat-square&logo=github)](https://github.com/bookorbit/bookorbit)

![BookOrbit dashboard showing reading stats, widgets, and book shelves](docs/images/dashboard-overview.png)

</div>

---

## What is this fork?

This is **[dimap/bookorbit_inpx](https://github.com/dimap/bookorbit_inpx)**, a fork of
[BookOrbit](https://bookorbit.app). It keeps everything the upstream project does (web readers,
Kobo and KOReader sync, metadata, statistics, multi-user accounts, and more) and adds the ability to
import and read from **INPX archive catalogs**.

An INPX catalog is a ZIP that bundles `.inp` indexes (SQLite databases) together with the book
archives they reference. This fork reads books straight out of those archives at read and download
time, so a large Flibusta-style library (hundreds of GB) stays on disk exactly once and nothing is
copied or unpacked.

The fork's changes are on the **`main`** branch (development happens on `feat/inpx-support`).
Upstream BookOrbit's `main` does not contain them.

## What's different from upstream BookOrbit

### INPX and Flibusta archive support

- **Archive-backed libraries**: register an `.inpx` file, import it, and browse the whole catalog.
  Books are served directly from the archive when you open or download them.
- **Companion `.7z` shards**: supports the FlibRusEc / FLibrary layout where each `.inp` index shard
  is paired with a same-named `.7z` shard holding the actual book files.
- **No whole-shard extraction**: enrichment opens one book at a time from its shard. The shard is
  never unpacked in full, so import works without extra disk space.
- **Content-based format detection**: the real format is sniffed from the file bytes (ZIP EPUB, 7z,
  or FB2), not from the index extension. FLibrary EPUBs stored as 7z archives are handled too.
- **Native 7z reader**: reads 7z archives (including solid archives) through the system `7z` binary,
  with a byte-offset ZIP reader for ordinary EPUBs.
- **Sidecar covers**: FLibrary keeps covers outside the books, in a `covers/` archive named after the
  book archive itself (`covers/f.fb2-009373-367300.zip`, not a book-id range). The cover entry is the
  INPX lib id / file name (`814211`, `814211.jpg`), resolved at runtime so any mirror layout works.
- **Sidecar annotations**: book descriptions are read from `etc/annotations.7z`, keyed by the book
  archive name and file name, and stored as the book description.
- **Author portraits and bios**: FLibrary keeps author photos in `etc/authors/pictures/*.zip|7z` and
  bios in `etc/authors/*.zip|7z`, keyed by MD5(author name). The import lists these shards once and
  indexes the keys; the portrait or bio is extracted the first time an author page is opened, so the
  import stays fast for large libraries.
- **Metadata enrichment**: FB2 (title, authors, series, ISBN, description, genres, cover) is extracted
  from the file; FLibrary 7z EPUBs get their cover and description from the sidecar archives.
  Enrichment is resumable, drains every book once, and reports live progress.
- **Virtual folders**: each archive gets a virtual `inpx://<archiveId>` library folder. The scanner
  and file watcher skip it, so INPX books are never flagged missing. Rename and move are rejected for
  archive-backed files.
- **UI and progress**: an "INPX archives" panel in the library detail view, plus WebSocket progress
  for the index and enrich phases.

### Operational fixes

- The runtime Docker image now installs the native `7zip` package required by the archive reader.
- Postgres gets `shm_size: '1gb'` so heavy catalog queries (series pages, counts) do not abort on
  Docker's default 64 MB `/dev/shm`.
- Deleting a large library drains its books in bounded batches (1000 at a time, with the per-statement
  timeout lifted inside each batch) instead of one giant cascade that hit the 30s statement timeout.

See [docs/INPX_SUPPORT.md](docs/INPX_SUPPORT.md) for the full data model, API routes, and module map.

## Roadmap / TODO

Done:

- [x] Register and import `.inpx` catalogs (index phase)
- [x] Read and download books straight from the archive
- [x] Companion `.7z` shards (FlibRusEc / FLibrary layout)
- [x] Content-based format detection (ZIP EPUB, 7z, FB2)
- [x] Native 7z reader for solid archives
- [x] Metadata enrichment for FB2 (title, authors, series, ISBN, description, genres)
- [x] FLibrary sidecar covers resolved by book archive stem (`covers/{stem}.zip|7z`)
- [x] FLibrary sidecar annotations (`etc/annotations.7z`) imported as book descriptions
- [x] Author portraits and bios from `etc/authors/`, resolved lazily per author page
- [x] Virtual `inpx://` folders so the scanner and file watcher skip archive books
- [x] INPX panel and WebSocket progress in the UI
- [x] `7zip` in the runtime image and Postgres `shm_size`

Planned:

- [ ] Book reviews from `etc/reviews/`
- [ ] Hide rename/move/export-only actions in the UI for archive-backed files
- [ ] Re-import reconciliation when the archive file changes (`mtimeMs`)
- [ ] Surface per-language counts in the UI
- [ ] Byte-range requests for archive-backed files
- [ ] Metadata write-back to archive files

## Installation (Docker, built from source)

This fork is not published to GHCR, so you build the image from this repository. The runtime image
bundles the native `7z` binary the archive reader needs.

Clone the repository and prepare the folders:

```bash
git clone https://github.com/dimap/bookorbit_inpx.git bookorbit
cd bookorbit
mkdir -p books data/app data/postgres
cp .env.example .env
```

Edit `.env` and set these required values:

```dotenv
APP_URL=http://your-server-ip:3000     # the URL you'll open in your browser
BOOKS_HOST_PATH=./books                # folder on your server where your book files live

POSTGRES_PASSWORD=         # database password           - openssl rand -hex 24
JWT_SECRET=                # signs login tokens          - openssl rand -hex 32
SETUP_BOOTSTRAP_TOKEN=     # one-time setup wizard token - openssl rand -hex 16
```

Then pick one of the two ways to start.

### Option A: ready-made compose (builds automatically)

`docker-compose.build.yml` builds the image from this checkout and starts the stack. The `APP_IMAGE`
variable is not used by this file.

```bash
docker compose -f docker-compose.build.yml up -d --build
```

### Option B: build the image yourself

Build the image first, set `APP_IMAGE` in `.env`, then start the default compose:

```dotenv
APP_IMAGE=bookorbit-inpx:latest        # the image you build below, NOT ghcr.io/bookorbit/bookorbit
```

```bash
docker build -t bookorbit-inpx:latest .
docker compose up -d
```

Open `http://your-server-ip:3000` and complete setup using your `SETUP_BOOTSTRAP_TOKEN`. Database
migrations run automatically on container start.

On a NAS, or any host where your book folder is owned by a user other than UID 1000, also set `PUID`
and `PGID` to match that owner. Run `id -u` and `id -g` as the owning user to find them. Getting
these wrong is the most common cause of permission errors on first scan.

Optionally set `LIBRARY_BROWSE_ROOT=/books` to start the library folder picker at `/books` instead
of `/`.

### Updating

```bash
git pull --ff-only
docker compose -f docker-compose.build.yml up -d --build
```

### Importing an INPX library

1. Put your `.inpx` catalog, its book shards (`.7z` / `.zip`), and any `covers/` / `images/` folders
   under the host folder mounted at `/books` (the `BOOKS_HOST_PATH` from above).
2. In BookOrbit, create a library and open its detail panel.
3. Under **INPX archives**, register the absolute path to the `.inpx` file inside the container
   (for example `/books/flibusta.inpx`) and start the import.
4. Watch progress in the panel. You can re-run **Extract metadata** later to fill in covers and
   descriptions for books that were imported without them.

For lightweight by-language shards, you can register each `.inpx` under the same library.

## Features

The following is inherited from upstream BookOrbit and is unchanged by this fork.

### Reading Experience & Sync

- **Built-in Web Readers**: Ebooks (EPUB, KEPUB, MOBI, AZW3, AZW, FB2), PDFs, comics (CBZ, CBR, CB7), and audiobooks (M4B, MP3, M4A, OPUS, OGG, FLAC), with no extra plugins required.
- **Three-Way Sync (Kobo + KOReader + BookOrbit)**: Progress and annotations flow bidirectionally between Kobo devices, KOReader, and the BookOrbit web reader. Pick up on any surface where you left off on another, including highlights and deletions.
- **KOReader Plugin**: An on-device catalog browser with search, download, and status and rating management, alongside full progress and annotation sync.
- **Annotations & Highlights**: Highlights from the web reader, KOReader, and Kobo merge into one searchable hub. Filter by color, style, and source; export as Markdown, CSV, or JSON.
- **Hardcover, Readwise & StoryGraph Sync**: Push status, progress, reading dates, and ratings to Hardcover on configurable triggers; status and progress to The StoryGraph; and new highlights and notes to Readwise as you create them, from both the web reader and synced devices. Hardcover read history can be pulled back to backfill blank BookOrbit entries.
- **Statistics, Goals & Achievements**: Daily reading time, heatmaps, streaks, and library health, plus yearly goals, monthly challenges, and 50+ achievements across five categories. Reading DNA profiles your reading style from your actual session history.

### Library Management

- **Multiple Libraries**: Isolate content with per-library folders, custom scan rules, and format priorities.
- **14 Metadata Providers**: Google Books, Open Library, Amazon, Goodreads, Kobo, Hardcover, Audible, Audnexus, Libro.fm, and iTunes, plus ComicVine for comics, RanobeDB for light novels, and Aladin and Lubimyczytać for Korean and Polish catalogs. Cover art is sourced separately from iTunes, DuckDuckGo, and AudiobookCovers.
- **Smart Scopes & Collections**: Organize your collection with curated lists and dynamic, rule-based saved filters.

### Platform & Delivery

- **Multi-User & SSO**: Granular per-user permissions and isolated reading data, with native support for Authentik, Keycloak, and Authelia via OIDC.
- **Multilingual Interface**: Community translations are managed on [Crowdin](https://crowdin.com/project/bookorbit). See the [localization guide](docs/LOCALIZATION.md) for current language support and contributor instructions.
- **Content Delivery**: OPDS support for compatible apps, Send-to-Kindle via email, and browser drag-and-drop uploads.
- **Automated Ingestion**: Configure a Book Dock drop folder for hands-free importing.

## KOReader Plugin

The BookOrbit plugin for KOReader adds progress sync, two-way annotation sync, and a native catalog browser: navigate, search, and download books from your library without leaving the device.

![BookOrbit KOReader Plugin showing dashboard, catalog search, and book details](docs/images/koreader-plugin-preview.png)

1. In BookOrbit, go to **Settings > KOReader**, create credentials if prompted, and click **Download Plugin**.
2. Unzip `bookorbit.koplugin.zip`.
3. Copy `bookorbit.koplugin` to `koreader/plugins/` on the device.
4. Restart KOReader and open a book.
5. Use **Tools > BookOrbit Sync** to connect.

The download is pre-configured with your server URL and credentials, so there is no manual entry on the device. For full setup and sync options, see **[bookorbit.app/koreader-plugin](https://bookorbit.app/koreader-plugin)**.

## Documentation and Contributing

Upstream documentation is at **[bookorbit.app](https://bookorbit.app/what-is-bookorbit)**, covering libraries, metadata, readers, Kobo sync, OPDS, users and permissions, OIDC setup, and more.

Fork-specific documentation:

- [INPX archive support](docs/INPX_SUPPORT.md): data model, API routes, import pipeline, known limitations.

For setting up book requests, see the [book requests guide](docs/BOOK_REQUESTS.md): indexers,
download clients, path mappings, automation, and the encryption key they all need.
For a one-time import from Audiobookshelf, see the [Audiobookshelf migration guide](docs/AUDIOBOOKSHELF_MIGRATION.md).
For a stopped-snapshot import from Calibre-Web Automated, see the
[Calibre-Web Automated migration guide](docs/CALIBRE_WEB_AUTOMATED_MIGRATION.md).
For local development, see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). To contribute, see [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for the full workflow: branch naming, test expectations, PR checklist, and commit format.

This fork is based on upstream BookOrbit `main`. When reporting an issue that is not about INPX,
please check whether it also reproduces on
[upstream BookOrbit](https://github.com/bookorbit/bookorbit) first.

## License

BookOrbit is licensed under the **[GNU Affero General Public License v3.0](LICENSE)**. This fork is
distributed under the same license.
