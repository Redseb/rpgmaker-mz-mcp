import { z } from 'zod';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'path';
import { fileExists } from '../utils/fileHandler.js';
import { writeZip } from '../utils/zip.js';
import { ToolDefinition } from '../registry.js';

/**
 * `export_web` — build a pruned HTML5 deployment of the project (the shape itch.io
 * and any static host expect: `index.html` at the root) and optionally zip it.
 *
 * **What is copied.** Runtime pieces wholesale — `index.html`, `js/`, `css/`,
 * `fonts/`, `icon/` — plus every `data/*.json`. Asset folders (`img/`, `audio/`,
 * `movies/`, `effects/`) are copied in full when `prune` is off; when it's on, a
 * file is kept only if its basename (extension stripped) is referenced
 * somewhere, except `img/system/` which is always kept (the engine loads it by
 * hard-coded names).
 *
 * **What "referenced" means** (deliberately over-inclusive — a kept unused file
 * costs bytes, a dropped used one is a runtime 404): every string in every
 * `data/*.json` (recursively, incl. JSON nested inside strings), every string
 * literal in the core `js/*.js` (the engine's hard-coded names, e.g. the default
 * battlebacks) and in `js/plugins.js` + `js/plugins/*.js` (plugin parameters and
 * hard-coded plugin assets), plus plugin `@default` annotations. Each string also
 * contributes its path-basename, its delimiter-split tokens (so a notetag like
 * `<Portrait: Hero>` keeps `Hero`), and extension-stripped forms of all of those.
 *
 * **`effects/`:** an `.efkefc` is kept only when its name is a *real* effect
 * reference ({@link collectEffectReferences}): an animation's `effectName`, a
 * Plugin Command's (357) arguments, or a plugin string (`js/plugins.js`
 * parameters, `js/plugins/*.js` literals and `@default`s). Other data strings are
 * ignored here — stock effect names (`Poison`, `Blind`, `Sleep`, …) collide with
 * ordinary animation/state/skill names. Its textures/models/sounds aren't named
 * anywhere in the data — they're listed inside the binary effect file — so they
 * are kept by parsing each kept effect's dependency list (see
 * {@link parseEffekseerDependencies}). If a kept effect can't be parsed (or pulls
 * in a material, which can reference further files), every non-`.efkefc` file
 * under `effects/` is kept instead. No referenced effect → no `effects/` at all
 * (the engine only fetches `effects/<name>.efkefc` on demand).
 */

/** Copied wholesale (no pruning). */
const WHOLESALE_DIRS = ['js', 'css', 'fonts', 'icon'] as const;
/** Pruned by referenced basename (except `img/system`). */
const PRUNABLE_DIRS = ['img', 'audio', 'movies'] as const;
/** Everything the export reads from — `outDir` may not live inside any of these. */
const SOURCE_DIRS = [...WHOLESALE_DIRS, ...PRUNABLE_DIRS, 'effects', 'data', 'save'];

/** Marker written into the export folder (never zipped) so a re-export may safely wipe it. */
const EXPORT_MARKER = '.rpgmaker-mcp-export';

/** itch.io caps an HTML5 upload at 1000 files and 200 MB per extracted file. */
const ITCH_MAX_FILES = 1000;
const ITCH_MAX_FILE_BYTES = 200 * 1024 * 1024;
/** How many dropped paths to list before truncating. */
const DROPPED_LIST_CAP = 200;

export interface ExportWebOptions {
  outDir: string;
  zip?: boolean;
  prune?: boolean;
}

export interface ExportWebResult {
  outDir: string;
  zipPath?: string;
  zipBytes?: number;
  /** Files in the deployment. */
  files: number;
  /** Total uncompressed bytes of those files. */
  bytes: number;
  /** Asset files (img/audio/movies/effects) kept. */
  kept: number;
  /** Asset files dropped as unreferenced. */
  dropped: number;
  droppedList?: string[];
  droppedListTruncated?: true;
  /** Game resolution from `System.advanced` — use it as the itch.io embed size. */
  screen: { width: number; height: number };
  warnings?: string[];
}

/** Recursively list files under `dir` as project-relative forward-slash paths. Missing dir → []. */
async function walk(root: string, rel: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, ...rel.split('/')), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'Thumbs.db' || e.name === 'desktop.ini') continue;
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walk(root, child)));
    else if (e.isFile()) out.push(child);
  }
  return out;
}

/** Strip one trailing extension (`Foo.png` → `Foo`, `Foo.png_` → `Foo`); no extension → unchanged. */
function stripExt(name: string): string {
  return name.replace(/\.[A-Za-z0-9_]{1,8}$/, '');
}

const TOKEN_SPLIT = /[\s,:;<>"'`=(){}[\]|\\/]+/;

/** Add one referenced string (and its derived forms) to the set. */
function addRef(refs: Set<string>, raw: string, depth = 0): void {
  const s = raw.trim();
  if (!s) return;
  const forms = new Set<string>([s]);
  const base = s.split(/[\\/]/).pop();
  if (base) forms.add(base);
  if (s.length <= 4096) for (const tok of s.split(TOKEN_SPLIT)) if (tok) forms.add(tok);
  for (const f of forms) {
    refs.add(f);
    refs.add(stripExt(f));
  }
  // Plugin parameters nest JSON inside strings (struct/list params) — descend.
  if (depth < 6 && (s.startsWith('{') || s.startsWith('[') || s.startsWith('"'))) {
    try {
      collectJsonStrings(refs, JSON.parse(s), depth + 1);
    } catch {
      /* not JSON */
    }
  }
}

function collectJsonStrings(refs: Set<string>, value: unknown, depth = 0): void {
  if (typeof value === 'string') addRef(refs, value, depth);
  else if (Array.isArray(value)) for (const v of value) collectJsonStrings(refs, v, depth);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) collectJsonStrings(refs, v, depth);
}

const JS_STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

/** Add every string literal (and `@default` annotation) in a JS source to the set. */
export function collectJsStrings(refs: Set<string>, source: string): void {
  for (const m of source.matchAll(JS_STRING_LITERAL)) {
    addRef(refs, m[2].replace(/\\(.)/g, '$1'));
  }
  for (const m of source.matchAll(/@default[ \t]+([^\r\n]+)/g)) addRef(refs, m[1]);
}

/**
 * The set of names the game may load — see the module comment for what is
 * scanned. Over-inclusive by design.
 */
export async function collectReferencedNames(projectPath: string): Promise<Set<string>> {
  const refs = new Set<string>();
  const dataDir = join(projectPath, 'data');
  let dataFiles: string[] = [];
  try {
    dataFiles = (await readdir(dataDir)).filter((f) => f.endsWith('.json'));
  } catch {
    /* no data dir — nothing referenced */
  }
  for (const f of dataFiles) {
    try {
      collectJsonStrings(refs, JSON.parse(await readFile(join(dataDir, f), 'utf8')));
    } catch {
      /* unreadable/corrupt json — skip rather than fail the export */
    }
  }

  const jsFiles: string[] = [];
  try {
    jsFiles.push(
      ...(await readdir(join(projectPath, 'js')))
        .filter((f) => f.endsWith('.js'))
        .map((f) => join(projectPath, 'js', f)),
    );
  } catch {
    /* no js dir */
  }
  for (const rel of await walk(projectPath, 'js/plugins')) {
    if (rel.endsWith('.js')) jsFiles.push(join(projectPath, ...rel.split('/')));
  }
  for (const file of jsFiles) {
    try {
      collectJsStrings(refs, await readFile(file, 'utf8'));
    } catch {
      /* unreadable — skip */
    }
  }
  return refs;
}

/** Plugin Command (MZ) event command code; `parameters[3]` holds its argument object. */
const PLUGIN_COMMAND_CODE = 357;

/** Add the string arguments of every Plugin Command in an event command list. */
function collectPluginCommandArgs(refs: Set<string>, list: unknown): void {
  if (!Array.isArray(list)) return;
  for (const cmd of list) {
    if (cmd?.code === PLUGIN_COMMAND_CODE && Array.isArray(cmd.parameters)) {
      collectJsonStrings(refs, cmd.parameters[3]);
    }
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined; // missing/corrupt — skip rather than fail the export
  }
}

/**
 * The names that may be played as an Effekseer effect — narrower than
 * {@link collectReferencedNames}: `Animations.json[*].effectName`, the arguments
 * of Plugin Commands (357) in maps, common events and troops, and plugin strings
 * (`js/plugins.js` parameters, `js/plugins/*.js` literals and `@default`s).
 */
export async function collectEffectReferences(projectPath: string): Promise<Set<string>> {
  const refs = new Set<string>();
  const dataDir = join(projectPath, 'data');
  const animations = await readJson(join(dataDir, 'Animations.json'));
  if (Array.isArray(animations)) {
    for (const a of animations) if (typeof a?.effectName === 'string') addRef(refs, a.effectName);
  }

  let dataFiles: string[] = [];
  try {
    dataFiles = await readdir(dataDir);
  } catch {
    /* no data dir */
  }
  for (const f of dataFiles) {
    if (/^Map\d+\.json$/.test(f)) {
      const map = (await readJson(join(dataDir, f))) as { events?: unknown } | undefined;
      if (!Array.isArray(map?.events)) continue;
      for (const ev of map.events) {
        if (Array.isArray(ev?.pages))
          for (const page of ev.pages) collectPluginCommandArgs(refs, page?.list);
      }
    } else if (f === 'CommonEvents.json') {
      const events = await readJson(join(dataDir, f));
      if (Array.isArray(events)) for (const ev of events) collectPluginCommandArgs(refs, ev?.list);
    } else if (f === 'Troops.json') {
      const troops = await readJson(join(dataDir, f));
      if (!Array.isArray(troops)) continue;
      for (const t of troops) {
        if (Array.isArray(t?.pages))
          for (const page of t.pages) collectPluginCommandArgs(refs, page?.list);
      }
    }
  }

  const pluginFiles = [join(projectPath, 'js', 'plugins.js')];
  for (const rel of await walk(projectPath, 'js/plugins')) {
    if (rel.endsWith('.js')) pluginFiles.push(join(projectPath, ...rel.split('/')));
  }
  for (const file of pluginFiles) {
    try {
      collectJsStrings(refs, await readFile(file, 'utf8'));
    } catch {
      /* missing/unreadable — skip */
    }
  }
  return refs;
}

/** Whether a prunable asset (project-relative path) is referenced. */
function isReferenced(rel: string, refs: Set<string>): boolean {
  const parts = rel.split('/');
  if (parts[0] === 'img' && parts[1] === 'system') return true;
  const file = parts[parts.length - 1];
  if (refs.has(file) || refs.has(stripExt(file))) return true;
  // A name referenced with a subfolder (e.g. a picture "ui/Frame" in img/pictures/ui/).
  const inKind = parts.slice(2).join('/');
  return inKind.length > 0 && (refs.has(inKind) || refs.has(stripExt(inKind)));
}

/**
 * Dependency paths (relative to the effect file, e.g. `Texture/Spin.png`) listed in
 * an Effekseer `.efkefc`'s `INFO` chunk, or `undefined` if the file doesn't parse.
 *
 * Layout: `"EFKE"` + u32 version, then chunks of fourcc + u32 size + data. `INFO`
 * data is an i32 version followed by lists (color/normal/distortion textures,
 * models, sounds, materials, … — more in newer versions), each an i32 count of
 * i32 length (UTF-16 code units, incl. the NUL) + UTF-16LE string. Every list is
 * read the same way, so the exact set of lists doesn't matter; the parse must
 * consume the chunk exactly or it's rejected. No `INFO` chunk → no dependencies.
 */
export function parseEffekseerDependencies(buf: Buffer): string[] | undefined {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'EFKE') return undefined;
  let o = 8;
  while (o + 8 <= buf.length) {
    const tag = buf.toString('latin1', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    const start = o + 8;
    const end = start + size;
    if (end > buf.length) return undefined;
    if (tag === 'INFO') {
      const deps: string[] = [];
      let p = start + 4;
      if (p > end) return undefined;
      while (p + 4 <= end) {
        const count = buf.readInt32LE(p);
        p += 4;
        if (count < 0 || count > 65536) return undefined;
        for (let i = 0; i < count; i++) {
          if (p + 4 > end) return undefined;
          const len = buf.readInt32LE(p);
          p += 4;
          if (len <= 0 || p + len * 2 > end) return undefined;
          const s = buf.toString('utf16le', p, p + len * 2);
          p += len * 2;
          if (!s.endsWith('\0')) return undefined;
          if (s.length > 1) deps.push(s.slice(0, -1));
        }
      }
      return p === end ? deps : undefined;
    }
    o = end;
  }
  return o === buf.length ? [] : undefined;
}

/**
 * Split `effects/` files into kept/dropped: referenced `.efkefc`s plus their
 * dependencies (or every non-effect file, if a kept effect can't be parsed).
 */
async function pruneEffects(
  projectPath: string,
  refs: Set<string>,
): Promise<{ kept: string[]; dropped: string[] }> {
  const all = await walk(projectPath, 'effects');
  // Dependency paths are matched case-insensitively (authored on Windows), then copied by real name.
  const byLower = new Map(all.map((rel) => [rel.toLowerCase(), rel]));
  const keep = new Set<string>();
  let keepAllDeps = false;
  for (const rel of all) {
    if (!rel.endsWith('.efkefc')) continue;
    const name = stripExt(rel.slice('effects/'.length));
    const base = name.split('/').pop()!;
    if (!refs.has(name) && !refs.has(base)) continue;
    keep.add(rel);
    let deps: string[] | undefined;
    try {
      deps = parseEffekseerDependencies(await readFile(join(projectPath, ...rel.split('/'))));
    } catch {
      deps = undefined;
    }
    if (!deps || deps.some((d) => /\.efkmat$/i.test(d))) {
      keepAllDeps = true;
      continue;
    }
    const dir = posix.dirname(rel);
    for (const d of deps) {
      const dep = byLower.get(
        posix.normalize(posix.join(dir, d.replace(/\\/g, '/'))).toLowerCase(),
      );
      if (dep) keep.add(dep);
    }
  }
  if (keepAllDeps && keep.size > 0) {
    for (const rel of all) if (!rel.endsWith('.efkefc')) keep.add(rel);
  }
  return {
    kept: all.filter((rel) => keep.has(rel)),
    dropped: all.filter((rel) => !keep.has(rel)),
  };
}

/** `child` is `parent` or lives beneath it. */
function isWithin(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** Refuse output locations that would clobber or recurse into the project. */
function checkOutDir(projectPath: string, outAbs: string): void {
  const proj = resolve(projectPath);
  if (isWithin(proj, outAbs)) {
    throw new Error(
      `outDir ${outAbs} is the project folder or contains it — choose a separate folder.`,
    );
  }
  for (const d of [...SOURCE_DIRS, 'index.html']) {
    if (isWithin(outAbs, join(proj, d))) {
      throw new Error(
        `outDir ${outAbs} is inside the project's ${d}/ folder, which the export copies from — choose a folder outside it.`,
      );
    }
  }
}

/** Prepare an empty outDir: create it, or wipe a previous export (marker present). Refuse anything else. */
async function prepareOutDir(outAbs: string): Promise<void> {
  let existing: string[] = [];
  try {
    existing = await readdir(outAbs);
  } catch {
    /* doesn't exist yet */
  }
  if (existing.length > 0) {
    if (!(await fileExists(join(outAbs, EXPORT_MARKER)))) {
      throw new Error(
        `outDir ${outAbs} exists and is not empty (and isn't a previous export_web output). Choose an empty or new folder.`,
      );
    }
    await rm(outAbs, { recursive: true, force: true });
  }
  await mkdir(outAbs, { recursive: true });
  await writeFile(join(outAbs, EXPORT_MARKER), 'Created by rpgmaker-mz-mcp export_web.\n');
}

async function screenSize(projectPath: string): Promise<{ width: number; height: number }> {
  try {
    const sys = JSON.parse(await readFile(join(projectPath, 'data', 'System.json'), 'utf8'));
    const adv = sys?.advanced ?? {};
    return {
      width: Number(adv.screenWidth) || 816,
      height: Number(adv.screenHeight) || 624,
    };
  } catch {
    return { width: 816, height: 624 };
  }
}

/**
 * Build the deployment folder at `outDir` (resolved against the project root when
 * relative) and, with `zip` (default), `<outDir>.zip` beside it with `index.html`
 * at the archive root. Writes nothing inside the project.
 */
export async function exportWeb(
  projectPath: string,
  opts: ExportWebOptions,
): Promise<ExportWebResult> {
  const { zip = true, prune = true } = opts;
  if (!opts.outDir || !opts.outDir.trim()) throw new Error('outDir is required.');
  const outAbs = resolve(projectPath, opts.outDir);
  checkOutDir(projectPath, outAbs);
  if (!(await fileExists(join(projectPath, 'index.html')))) {
    throw new Error(
      `No index.html in ${projectPath} — not a deployable RPG Maker MZ project (the web runtime entry point is missing).`,
    );
  }

  // Gather the file list first, so a bad project fails before outDir is touched.
  const files: string[] = ['index.html'];
  for (const d of WHOLESALE_DIRS) files.push(...(await walk(projectPath, d)));
  try {
    files.push(
      ...(await readdir(join(projectPath, 'data')))
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => `data/${f}`),
    );
  } catch {
    /* no data dir — the deployment will be broken, but that's the project's state */
  }

  const refs = prune ? await collectReferencedNames(projectPath) : undefined;
  let kept = 0;
  const droppedPaths: string[] = [];
  for (const d of PRUNABLE_DIRS) {
    for (const rel of await walk(projectPath, d)) {
      if (!refs || isReferenced(rel, refs)) {
        files.push(rel);
        kept++;
      } else {
        droppedPaths.push(rel);
      }
    }
  }
  if (refs) {
    const effects = await pruneEffects(projectPath, await collectEffectReferences(projectPath));
    files.push(...effects.kept);
    kept += effects.kept.length;
    droppedPaths.push(...effects.dropped);
  } else {
    const effects = await walk(projectPath, 'effects');
    files.push(...effects);
    kept += effects.length;
  }

  await prepareOutDir(outAbs);
  let bytes = 0;
  const warnings: string[] = [];
  for (const rel of files) {
    const src = join(projectPath, ...rel.split('/'));
    const dest = join(outAbs, ...rel.split('/'));
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    const { size } = await stat(src);
    bytes += size;
    if (size > ITCH_MAX_FILE_BYTES) {
      warnings.push(
        `${rel} is ${(size / 1048576).toFixed(1)} MB — itch.io rejects HTML5 uploads with any file over 200 MB.`,
      );
    }
  }
  if (files.length > ITCH_MAX_FILES) {
    warnings.push(
      `${files.length} files — itch.io caps HTML5 uploads at ${ITCH_MAX_FILES} files${prune ? '' : ' (try prune: true)'}.`,
    );
  }

  const result: ExportWebResult = {
    outDir: outAbs,
    files: files.length,
    bytes,
    kept,
    dropped: droppedPaths.length,
    screen: await screenSize(projectPath),
  };
  if (droppedPaths.length > 0) {
    result.droppedList = droppedPaths.slice(0, DROPPED_LIST_CAP);
    if (droppedPaths.length > DROPPED_LIST_CAP) result.droppedListTruncated = true;
  }

  if (zip) {
    const zipPath = `${outAbs}.zip`;
    const zipped = await writeZip(
      zipPath,
      files.map((rel) => ({ name: rel, source: join(outAbs, ...rel.split('/')) })),
    );
    result.zipPath = zipped.path;
    result.zipBytes = zipped.bytes;
  }
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

export const exportToolDefinitions: ToolDefinition[] = [
  {
    name: 'export_web',
    description:
      "Export a pruned HTML5 web deployment (for itch.io or any static host): copies index.html, js/, css/, fonts/, icon/ and data/*.json, plus only the img/audio/movies files the game references (every string in data/*.json, string literals in the core js and plugins, plugin @default annotations; img/system is always kept) and only the effects/*.efkefc Effekseer effects actually referenced (an animation's effectName, a Plugin Command argument, or a plugin parameter/string — not other data strings) together with the textures/models they list internally. Writes the folder to outDir and, by default, <outDir>.zip with index.html at the archive root. Returns file/byte counts, kept/dropped asset counts (+ dropped paths), the screen size from System.advanced (the itch embed size), and warnings for itch's 1000-file / 200 MB-per-file limits. Writes nothing inside the project; outDir must be outside the project's copied folders, and an existing non-empty outDir is only replaced if it was a previous export_web output. Follow up with a playtest of the exported build.",
    inputSchema: {
      outDir: z
        .string()
        .describe(
          'Folder to write the deployment into (absolute, or relative to the project root). Must not be the project folder or inside its img/audio/data/js/… folders.',
        ),
      zip: z
        .boolean()
        .optional()
        .describe('Also write <outDir>.zip with index.html at the archive root (default true).'),
      prune: z
        .boolean()
        .optional()
        .describe(
          'Drop img/audio/movies/effects files nothing references (default true). Set false to copy every asset — the escape hatch if a plugin builds asset names at runtime.',
        ),
    },
    handler: (ctx, args) =>
      exportWeb(ctx.projectPath, { outDir: args.outDir, zip: args.zip, prune: args.prune }),
  },
];
