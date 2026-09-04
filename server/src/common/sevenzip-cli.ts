import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Thin wrapper around the native `7z` binary (7-Zip). The INPX reader needs large Flibusta shard
 * archives that would exhaust memory if loaded through the WASM module; the native binary streams
 * from disk and only ever holds one entry at a time.
 */

const BINARY_CANDIDATES = ['7zz', '7z', '7za'];
let resolvedBinary: string | undefined;

async function resolveBinary(): Promise<string> {
  if (resolvedBinary) return resolvedBinary;
  for (const candidate of BINARY_CANDIDATES) {
    try {
      await run7z(candidate, ['i']);
      resolvedBinary = candidate;
      return candidate;
    } catch (err) {
      // ENOENT means the binary is absent; anything else means it exists but `i` misbehaved, which
      // still leaves l/e usable.
      if ((err as { code?: string }).code !== 'ENOENT') {
        resolvedBinary = candidate;
        return candidate;
      }
    }
  }
  throw new Error('7z binary not found; install 7-Zip (7zip/p7zip) in the container');
}

function run7z(binary: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`7z exited with code ${code}: ${stderr.slice(0, 300)}`);
      (error as { code?: number | null }).code = code;
      reject(error);
    });
  });
}

export interface SevenZipCliEntry {
  name: string;
  size: number;
}

export async function listSevenZipEntries(archivePath: string): Promise<SevenZipCliEntry[]> {
  const binary = await resolveBinary();
  const { stdout } = await run7z(binary, ['l', '-slt', archivePath]);
  return parseSevenZipList(stdout);
}

/**
 * Extracts one entry into `outDir` and returns the path of the extracted file, or null when the
 * entry is absent or the extraction fails.
 */
export async function extractSevenZipEntry(archivePath: string, entryName: string, outDir: string): Promise<string | null> {
  const binary = await resolveBinary();
  const target = join(outDir, basename(entryName));
  try {
    await run7z(binary, ['e', archivePath, `-o${outDir}`, '-y', entryName]);
  } catch {
    return null;
  }
  return existsSync(target) ? target : null;
}

/** Extracts the whole archive into `outDir`, preserving internal paths. */
export async function extractSevenZipAll(archivePath: string, outDir: string): Promise<void> {
  const binary = await resolveBinary();
  await run7z(binary, ['x', archivePath, `-o${outDir}`, '-y']);
}

export function parseSevenZipList(stdout: string): SevenZipCliEntry[] {
  const entries: SevenZipCliEntry[] = [];
  for (const block of stdout.split('----------')) {
    if (/^\s*Folder = \+$/m.test(block)) continue;
    const pathMatch = block.match(/^\s*Path = (.+)$/m);
    const sizeMatch = block.match(/^\s*Size = (\d+)$/m);
    if (!pathMatch || !sizeMatch) continue;
    const name = pathMatch[1]!.trim();
    const size = Number(sizeMatch[1]);
    if (!name || name.endsWith('/') || !Number.isFinite(size)) continue;
    entries.push({ name, size });
  }
  return entries;
}
