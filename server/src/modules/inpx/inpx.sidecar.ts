import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Flibusta/FLibrary lays covers, annotations, author bios/portraits and reviews out in "sidecar"
 * folders next to the INPX index (`covers/`, `images/`, `etc/annotations.7z`, `etc/authors/...`).
 *
 * The layout mirrors FLibrary itself:
 * - a cover archive is named after the *book archive* stem (`covers/f.fb2-009373-367300.zip`), not
 *   after a book id range;
 * - the entry inside it is the INPX `lib_id` / file name (`814211` or `814211.jpg`).
 *
 * These helpers only resolve paths and candidate entry names. Reading the archives is left to the
 * caller, which already owns container caching.
 */

/** Some mirrors keep `f.fb2-*.zip`, others `fb2-*.zip`; INPX and sidecar may disagree. */
export function sidecarStemVariants(stem: string): string[] {
  const out = new Set<string>([stem]);
  if (/^f\.fb2-/i.test(stem)) out.add(stem.replace(/^f\./i, ''));
  if (/^fb2-/i.test(stem) && !/^f\.fb2-/i.test(stem)) out.add(`f.${stem}`);
  return [...out];
}

export function bookArchiveStem(archivePath: string): string {
  return basename(archivePath.replace(/\\/g, '/')).replace(/\.(zip|7z)$/i, '');
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Cover archive that belongs to a book archive: `{dirname(bookArchive)}/covers/{stem}.zip|7z`, with
 * a fallback to `{libraryRoot}/covers/...` for the flat mirror layout.
 */
export function resolveCoverArchivePath(libraryRoot: string, bookArchivePath: string): string | null {
  const stem = bookArchiveStem(bookArchivePath);
  if (!stem) return null;
  const dirs = new Set<string>([join(dirname(bookArchivePath), 'covers'), join(libraryRoot, 'covers')]);
  for (const dir of dirs) {
    for (const variant of sidecarStemVariants(stem)) {
      for (const ext of ['.zip', '.7z']) {
        const candidate = join(dir, `${variant}${ext}`);
        if (isFile(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** Book descriptions for the whole mirror live in a single `etc/annotations.7z`. */
export function resolveAnnotationsArchivePath(libraryRoot: string): string | null {
  const candidate = join(libraryRoot, 'etc', 'annotations.7z');
  return isFile(candidate) ? candidate : null;
}

/**
 * Candidate cover entry names inside a `covers/` archive: the lib id (or file name) with and without
 * an image extension. JXL is intentionally omitted: the thumbnail pipeline cannot decode it yet.
 */
export function coverEntryCandidates(fileId: string, fileName?: string | null): string[] {
  const keys = new Set<string>();
  const add = (value: string | null | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed) keys.add(trimmed);
  };

  add(fileId);
  if (fileName) {
    const normalized = fileName.replace(/\\/g, '/');
    add(normalized);
    add(basename(normalized));
    add(basename(normalized).replace(/\.[^/.]+$/, ''));
  }

  const out: string[] = [];
  for (const key of keys) {
    out.push(key);
    if (!/\.(jpe?g|png|gif|webp)$/i.test(key)) {
      for (const ext of ['.jpg', '.jpeg', '.png', '.gif', '.webp']) out.push(`${key}${ext}`);
    }
  }
  return out;
}

/** Entry names inside `etc/annotations.7z`: the book archive file name in its known spellings. */
export function annotationInternalCandidates(bookArchivePath: string): string[] {
  const base = basename(bookArchivePath.replace(/\\/g, '/'));
  if (!base || base.includes('..')) return [];
  const out = new Set<string>([base]);
  for (const variant of sidecarStemVariants(base.replace(/\.(zip|7z)$/i, ''))) {
    out.add(`${variant}.zip`);
    out.add(`${variant}.7z`);
  }
  return [...out];
}

/** `<folder name="...">` values in the annotation XML that may hold this book archive's records. */
export function annotationFolderCandidates(bookArchivePath: string): string[] {
  const base = basename(bookArchivePath.replace(/\\/g, '/'));
  const stem = base.replace(/\.(zip|7z)$/i, '');
  const out = new Set<string>([base, stem]);
  for (const variant of sidecarStemVariants(stem)) {
    out.add(variant);
    out.add(`${variant}.zip`);
    out.add(`${variant}.7z`);
  }
  return [...out];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pulls one book's annotation out of the `etc/annotations.7z` XML shard. The shard maps
 * `<folder name="{bookArchive}"><file name="{fileBase}.fb2">text</file></folder>`.
 */
export function parseAnnotationFromXml(xml: string, folderName: string, fileBase: string): string | null {
  if (!xml || !folderName || !fileBase) return null;
  const folderMatch = xml.match(new RegExp(`<folder\\s+[^>]*name\\s*=\\s*["']${escapeRegExp(folderName)}["'][^>]*>([\\s\\S]*?)</folder>`, 'i'));
  if (!folderMatch) return null;
  const fileMatch = folderMatch[1].match(
    new RegExp(`<file\\s+[^>]*name\\s*=\\s*["']${escapeRegExp(fileBase)}\\.fb2["'][^>]*>([\\s\\S]*?)</file>`, 'i'),
  );
  return fileMatch ? fileMatch[1].trim() : null;
}
