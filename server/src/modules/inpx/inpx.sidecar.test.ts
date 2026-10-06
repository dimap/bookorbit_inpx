import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  annotationFolderCandidates,
  annotationInternalCandidates,
  coverEntryCandidates,
  parseAnnotationFromXml,
  resolveAnnotationsArchivePath,
  resolveCoverArchivePath,
  sidecarStemVariants,
} from './inpx.sidecar';

describe('inpx sidecar helpers', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'inpx-sidecar-test-'));
    // Flat mirror layout: book archive and covers live side by side.
    mkdirSync(join(root, 'covers'), { recursive: true });
    writeFileSync(join(root, 'f.fb2-009373-367300.7z'), 'book');
    writeFileSync(join(root, 'covers', 'f.fb2-009373-367300.zip'), 'cover');
    // Variant spelling: INPX says `f.fb2-*`, covers say `fb2-*`.
    writeFileSync(join(root, 'f.fb2-100000-200000.7z'), 'book');
    writeFileSync(join(root, 'covers', 'fb2-100000-200000.zip'), 'cover');
    mkdirSync(join(root, 'etc'), { recursive: true });
    writeFileSync(join(root, 'etc', 'annotations.7z'), 'ann');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('expands the f.fb2- stem both ways', () => {
    expect(sidecarStemVariants('f.fb2-009373-367300')).toEqual(['f.fb2-009373-367300', 'fb2-009373-367300']);
    expect(sidecarStemVariants('fb2-100000-200000')).toEqual(['fb2-100000-200000', 'f.fb2-100000-200000']);
  });

  it('resolves the cover archive by book archive stem, not a book id range', () => {
    expect(resolveCoverArchivePath(root, join(root, 'f.fb2-009373-367300.7z'))).toBe(join(root, 'covers', 'f.fb2-009373-367300.zip'));
  });

  it('resolves the cover archive across f.fb2-/fb2- spelling differences', () => {
    expect(resolveCoverArchivePath(root, join(root, 'f.fb2-100000-200000.7z'))).toBe(join(root, 'covers', 'fb2-100000-200000.zip'));
  });

  it('returns null when no cover archive exists for the stem', () => {
    expect(resolveCoverArchivePath(root, join(root, 'f.fb2-777777-888888.7z'))).toBeNull();
  });

  it('resolves the annotations archive', () => {
    expect(resolveAnnotationsArchivePath(root)).toBe(join(root, 'etc', 'annotations.7z'));
  });

  it('builds cover entry candidates from the lib id and file name', () => {
    const candidates = coverEntryCandidates('814211', 'fb2-814211.fb2');
    expect(candidates).toContain('814211');
    expect(candidates).toContain('814211.jpg');
    expect(candidates).toContain('fb2-814211.fb2');
    expect(candidates).toContain('fb2-814211');
  });

  it('builds annotation internal entry and folder candidates', () => {
    expect(annotationInternalCandidates('/lib/f.fb2-009373-367300.7z')).toEqual(
      expect.arrayContaining(['f.fb2-009373-367300.7z', 'f.fb2-009373-367300.zip', 'fb2-009373-367300.zip']),
    );
    expect(annotationFolderCandidates('/lib/f.fb2-009373-367300.7z')).toEqual(
      expect.arrayContaining(['f.fb2-009373-367300.7z', 'f.fb2-009373-367300', 'fb2-009373-367300']),
    );
  });

  it('extracts one book annotation from the shard xml', () => {
    const xml = '<root><folder name="fb2-100000-200000.zip"><file name="814211.fb2">Hello</file><file name="2.fb2">Two</file></folder></root>';
    expect(parseAnnotationFromXml(xml, 'fb2-100000-200000.zip', '814211')).toBe('Hello');
    expect(parseAnnotationFromXml(xml, 'fb2-100000-200000.zip', '999')).toBeNull();
    expect(parseAnnotationFromXml(xml, 'missing.zip', '814211')).toBeNull();
  });
});
