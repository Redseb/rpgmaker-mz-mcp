# Map generation

`generate_dungeon_map` and `generate_map_from_template` each create a new map and register it in `MapInfos.json`. They share the existing `createMap` implementation, `commitChange` previews, and `applyAutotiling` shape handling. No project-analysis or runtime-bridge tool is required.

## Seeded rooms and corridors

```json
{
  "name": "Cave",
  "tilesetId": 1,
  "seed": "cave-first-floor",
  "width": 41,
  "height": 31,
  "roomCount": 8,
  "minRoomSize": 4,
  "maxRoomSize": 9,
  "tileProfile": {
    "floorTileId": 1536,
    "wallTileId": 1537
  },
  "dryRun": true
}
```

The tile IDs above are examples, not universal floor/wall assignments. Select IDs from the project's own tileset. `corridorTileId` is optional and defaults to the floor. Floor and corridor tiles, including every autotile variant, must be passable in all four directions; walls must block every direction with the project's empty upper layers. Assigned sheets must exist in the project. Image dimensions and appearance are not verified.

The seed controls geometry. Numeric and string seeds are distinct. Dimensions are 9–256, room count is 1–100, and room sizes are 3–64. Placement attempts are bounded; a crowded layout may contain fewer rooms than requested, with a warning. The tool checks static tile connectivity and returns suggested entrance/key/door/boss/exit positions. These are **design metadata only**: no gameplay events, key items, locks, rewards, or battles are created. Metadata is also recorded in the new map's note.

## Layout from an existing project map

```json
{
  "name": "Cave variation",
  "sourceMapId": 3,
  "parentId": 1,
  "tileRemap": [{ "from": 1536, "to": 1538 }],
  "dryRun": true
}
```

This copies all six tile/shadow/region layers and scroll type, with optional `tilesetId` override. It starts from blank-map defaults for events, encounters, notes, audio, and parallax. The source is never modified. Templates are limited to 256×256 and must have exactly six complete layers with valid tile, shadow (0–15), and region (0–255) domains.

Remaps match exact raw tile IDs on the first four layers only, are applied once (not chained), and must have unique source IDs. Every changed tile layer is reshaped through `applyAutotiling`, including wrapping neighbors on looping maps. Shadow and region layers remain unchanged. With no remap, existing tile shapes are preserved.

## Previews and persistence

Both tools return a compact map identity, layout passage counts, and warnings. `dryRun: true` uses the server's normal preview machinery: both prospective files are reported without creating files or allocating a lasting map ID.

The shared `createMap` path validates map-tree indices and parent IDs, serializes allocations within this server process, refuses existing map files (including a file appearing after allocation), and uses `commitChange` for both writes. If publishing the map-tree entry fails, it removes the newly created map. The same safeguards apply to ordinary `create_map` calls.

The tree's original bytes are checked just before replacement to detect an intervening edit. This is **best-effort conflict detection**, not a cross-process lock or compare-and-swap. Do not save the same project concurrently in another server or the editor. The two-file operation provides rollback for ordinary errors, not crash-atomic transactions. An exceptional staging-file cleanup failure is reported to stderr without misreporting a successful publication as failed.

Connectivity uses the shared layered tile-passage rules and checks both directions of each step. It does not simulate active event pages, event collisions, vehicles, jumps, or plugin movement overrides. Review the result with existing `render_map` and `run_playtest` tools or the MZ editor.

For an isolated protocol check, run `npm run build` followed by `node scripts/verify-map-generation.mjs`. It creates and removes its own synthetic temporary project, checks discovery and previews, and concurrently creates blank, dungeon, and template maps through stdio. It does not access a game project or require licensed engine files.
