---
name: tileset-catalog
description: Bootstrap a semantic tile catalog for a custom (non-RTP) RPG Maker MZ tileset by vision. Use when a project's tileset sheets (e.g. Custom_A2.png, an unfamiliar A1–A5/B–E sheet) are NOT covered by the server's built-in catalog, so find_tile/get_tile_catalog return nothing for them and paint commands only have opaque tile ids. Slices each sheet into one labelled sample per autotile kind / flat tile, names them by sight, and writes a versioned, project-scoped catalog file. Not needed for the default Overworld tileset (World_A1/A2/B/C — already cataloged).
---

# Tileset catalog bootstrap (Phase 3f)

Give a custom tileset the same "ask for grass, get a paintable tile id" layer the
built-in Overworld catalog provides — but for sheets the server has never seen.
RPG Maker's default sheets ship an English `.txt` name sidecar (that's how the
Overworld catalog was built); **custom tilesets don't**, so their names must come
from **looking at the tiles**. This skill does that safely: it slices, you name,
it writes a file a human verifies before it's trusted.

## When to use

- A project uses a tileset whose sheet filenames aren't `World_A1/A2/B/C` (i.e.
  not the built-in Overworld catalog), and you need semantic names for painting.
- Confirm the gap first: `get_tile_catalog(tilesetId)` / `find_tile` come back
  empty or thin for that tileset — its custom sheets are silently omitted.

Do **not** use it for the Overworld tileset; that catalog already exists and is
authoritative (from RPG Maker's own labels).

## What you produce

A versioned catalog at **`<projectPath>/data/tilecatalog/<Sheet>.json`**, one file
per sheet, keyed by the sheet's local index (autotile _kind_ index for A1–A4, flat
tile offset for A5/B–E). Passability and terrain-tag are **left null on purpose** —
those are design decisions, not perception; a human sets them later.

## Workflow

Scripts live in `scripts/` next to this file and need only Node (built-in `zlib`;
no `sharp`/`canvas`/`pngjs`). Let `SKILL=.claude/skills/tileset-catalog`.

### 1. Find the sheets to catalog

Read the project's `data/Tilesets.json` for the target `tilesetId`; its
`tilesetNames` array holds the 9 sheet filenames `[A1,A2,A3,A4,A5,B,C,D,E]`
(empty string = unused slot). The image files are in `<projectPath>/img/tilesets/`.
Catalog the non-empty sheets that aren't already covered by the built-in catalog.

### 2. Slice each sheet into a labelled montage

```bash
node $SKILL/scripts/slice-tileset.mjs <projectPath>/img/tilesets/<Sheet>.png <workDir>
```

Writes `<workDir>/<Sheet>.samples.png` (a montage: one representative sample per
autotile kind — its shape-0, fully-surrounded tile — or per non-transparent flat
tile, each with its **local index printed above it** in white on a dark strip) and
`<Sheet>.samples.json` (`index → {kind, tileId}`). Fully-transparent flat tiles are
dropped; autotile kinds that render mostly-transparent (edge-only sets like clouds)
still appear so you can see and name them.

### 3. Name the samples by sight

**Read (view) the montage image.** For each labelled sample, decide:

- `name` — a short, paint-friendly noun phrase ("Grass", "Brick Wall", "Shallow
  Water"). Match the visual, not a guess about behaviour.
- `confidence` — `high` / `medium` / `low`. Use `low` for ambiguous or abstract
  tiles; that flags them for the human to check.
- `description` — one short clause of visual detail ("mossy grey cobblestone").
- `duplicateOf` — if a sample looks essentially identical to an earlier index in
  the same sheet, set this to that index (near-duplicate flag). Otherwise `null`.

Write a naming JSON to `<workDir>/<Sheet>.naming.json`:

```json
{
  "sheet": "<Sheet>",
  "role": "A2",
  "autotile": true,
  "entries": {
    "0": {
      "name": "Grass",
      "confidence": "high",
      "description": "bright green grass",
      "duplicateOf": null
    },
    "1": {
      "name": "Grass (Dark)",
      "confidence": "medium",
      "description": "shadowed grass",
      "duplicateOf": 0
    }
  }
}
```

Only include indices that appear in the montage/`samples.json`. Copy `sheet`,
`role`, `autotile` straight from `samples.json`.

### 4. Merge into the project catalog (diff-safe)

Preview first, then apply:

```bash
node $SKILL/scripts/write-catalog.mjs <workDir>/<Sheet>.naming.json <projectPath> --dry-run
node $SKILL/scripts/write-catalog.mjs <workDir>/<Sheet>.naming.json <projectPath>
```

The writer **never clobbers human corrections**: any catalog entry a human has set
`"manual": true` on is kept verbatim; other entries are updated to your new naming;
new indices are added; the file `version` bumps each run. So re-running the
bootstrap on an already-verified sheet proposes/updates rather than overwriting.

### 5. Hand off for verification

Tell the user the catalog is a **draft for review**: to correct an entry they edit
`data/tilecatalog/<Sheet>.json`, fix `name`/`description`, and set `"manual": true`
so future re-runs leave it alone. Point out any `low`-confidence or `duplicateOf`
entries as the ones most worth a look. Passability/terrain-tag stay `null` until a
human (or a later design pass) sets them.

## Notes & sharp edges

- **Sample = shape 0.** For autotiles the montage shows each kind's fully-surrounded
  (shape-0) tile — exactly the base id `find_tile`/paint commands use. Some kinds
  (clouds, land's-end edges) are legitimately mostly-transparent at shape 0.
- **Local index, not tile id, is the catalog key** — the same convention the
  built-in `overworld.ts` uses, so a future server loader resolves `(sheet slot,
local index) → tile id` identically for custom and default sheets.
- **Geometry is engine-exact.** `scripts/tilegeom.mjs` mirrors
  `Tilemap._addAutotile`/`_addNormalTile` (rmmz_core.js v1.7.0): A1 water/waterfall
  special layout, A2 96×144 ground blocks, A3 96×96 wall blocks, A4 alternating
  wall-top/wall-side rows, and the two-half-column flat-sheet layout.
- **Consuming the catalog:** these files are the deliverable; wiring the MCP
  server's `find_tile`/`get_tile_catalog` to load project-scoped catalogs from
  `data/tilecatalog/` is a separate follow-up (the built-in catalog is compiled TS).
