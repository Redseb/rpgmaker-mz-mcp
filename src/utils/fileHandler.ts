import { readFile, writeFile, readdir, access, unlink } from 'fs/promises';
import { join, extname } from 'path';

/**
 * Read and parse a JSON file from RPG Maker MZ project
 */
export async function readJsonFile<T>(filePath: string): Promise<T> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error) {
    // Unwrap the underlying Error's message so we don't nest `Error: …: Error: …`.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read JSON file ${filePath}: ${detail}`);
  }
}

/**
 * Write JSON data to a file.
 *
 * RPG Maker MZ's editor saves its `data/*.json` files as compact, single-line
 * JSON (no indentation). We match that format so that:
 *  - map tile arrays don't explode into thousands of lines, and
 *  - diffs stay minimal and consistent with what the editor itself writes,
 *    which keeps the per-session git-checkpoint workflow readable.
 */
export async function writeJsonFile(filePath: string, data: any): Promise<void> {
  try {
    const jsonString = JSON.stringify(data);
    await writeFile(filePath, jsonString, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to write JSON file ${filePath}: ${error}`);
  }
}

/**
 * Read a 1-indexed database array file, failing soft only on a *missing* file
 * (ENOENT → `[]`). Used by create-time reference checks that must degrade to
 * "can't verify" (skip) instead of breaking on a project (or test fixture) that
 * lacks the target file.
 *
 * A *corrupted* (present but malformed) file is a real error and throws — swallowing
 * it would silently skip reference/troop validation on a broken project instead of
 * surfacing the corruption. A parsed non-array value still yields `[]` (a wrong-typed
 * file is treated as "no records" rather than crashing callers that expect an array).
 */
export async function readJsonArraySoft<T>(filePath: string): Promise<(T | null)[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const parsed = JSON.parse(content);
  return Array.isArray(parsed) ? (parsed as (T | null)[]) : [];
}

/**
 * List all files in a directory with a specific extension
 */
export async function listFiles(dirPath: string, extension: string): Promise<string[]> {
  try {
    const files = await readdir(dirPath);
    return files.filter((file) => extname(file) === extension);
  } catch (error) {
    throw new Error(`Failed to list files in ${dirPath}: ${error}`);
  }
}

/**
 * Whether a file (or directory) exists at the given path.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a file. A missing file is treated as a no-op (the desired end state —
 * the file being gone — already holds), so deletions stay idempotent.
 */
export async function deleteFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`Failed to delete file ${filePath}: ${error}`);
  }
}

/**
 * Get the full path to a data file in RPG Maker MZ project
 */
export function getDataPath(projectPath: string, fileName: string): string {
  return join(projectPath, 'data', fileName);
}

/**
 * Get the full path to a map file in RPG Maker MZ project
 */
export function getMapPath(projectPath: string, mapId: number): string {
  const fileName = `Map${String(mapId).padStart(3, '0')}.json`;
  return getDataPath(projectPath, fileName);
}

/**
 * Validate RPG Maker MZ project path
 */
/**
 * Paths that have already validated successfully. A directory doesn't stop being
 * an RPG Maker project mid-session, so the check is memoized after the first pass
 * — every tool call would otherwise re-run it. Only successes are cached (a path
 * that isn't yet a project might become one).
 */
const validatedProjectPaths = new Set<string>();

export async function validateProjectPath(projectPath: string): Promise<boolean> {
  if (validatedProjectPaths.has(projectPath)) {
    return true;
  }
  try {
    // Check the essential files exist (access(), not a full read — we only need
    // presence, not contents).
    await access(join(projectPath, 'game.rmmzproject'));
    await access(getDataPath(projectPath, 'System.json'));
    validatedProjectPaths.add(projectPath);
    return true;
  } catch {
    return false;
  }
}
