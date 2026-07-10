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
    throw new Error(`Failed to read JSON file ${filePath}: ${error}`);
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
export async function validateProjectPath(projectPath: string): Promise<boolean> {
  try {
    // Check if project has essential files
    await readFile(join(projectPath, 'game.rmmzproject'), 'utf-8');
    await readFile(getDataPath(projectPath, 'System.json'), 'utf-8');
    return true;
  } catch {
    return false;
  }
}
