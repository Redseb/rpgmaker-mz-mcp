---
name: rpgmaker-authoring
description: How to build a coherent, playable RPG Maker MZ game with the rpgmaker-mz MCP server — the authoring judgment the tools don't enforce. Use when creating or editing a game with the mcp__rpgmaker-mz__* tools: painting maps, placing NPCs/events, wiring transfers/shops/chests/battles, or setting up a custom cast. Covers tile layering (transparent overlays need a base), the solid-landmark + facing-transfer entrance idiom, giving interactables graphics, verifying asset names, the Hit-Rate and Add-Skill-Type traits, the self-switch one-shot pattern, and always playing the build (validators prove structure, not that it looks/plays right). Not for bootstrapping a custom tileset catalog — that's the tileset-catalog skill.
---

# Authoring a playable RPG Maker MZ game

The `mcp__rpgmaker-mz__*` tools let you build a game, but a build that succeeds and
passes `validate_project`/`validate_references`/`validate_event` can still be a **badly
built game** — invisible NPCs, terrain with black gaps, entrances you walk _into_,
battlers that fail to load. This skill is the authoring judgment the tools don't
enforce, distilled from real playtests. Read it before/while building a game.

## Rule 0 — validators prove structure, not that it looks/plays right

`validate_*` check command shape and id integrity. They will **not** catch: a
transparent tile with nothing beneath it, an NPC with no sprite, a `battlerName` that
doesn't exist, a transfer placed on the wrong tile, a class that always misses. **The
only way to know the game is good is to open it in the RPG Maker editor and play it.**
Treat "validators clean" as necessary, never sufficient.

The flip side: the event-writing tools **refuse** a write whose result is structurally
broken (wrong parameter count for a command code, a `list` missing its `{ code: 0 }`
terminator, an action-button event stranded on an impassable tile) — the tool errors
and nothing is saved. That error is a real bug in what you were about to write: **fix
the input.** `force: true` writes it anyway and exists for the rare case where the
validator is wrong (an exotic plugin, a deliberate experiment) — reaching for it to
make an error go away just puts the broken data on disk, which is what the refusal
saved you from. Advisory findings (unknown command code, unknown asset name, long text
line) still come back as `warnings` on a successful write — **heed those too.**

When you finish a chunk,
say what still needs an in-editor look.

## Tile layering — transparent overlays need a base (the #1 map mistake)

Each map cell has **6 stacked z-layers** in the flat `data` array
(`index = (layer*height + y)*width + x`):

| layer | role                                              |
| ----- | ------------------------------------------------- |
| 0     | lower ground **A** (opaque base terrain)          |
| 1     | lower ground **B** (overlays)                     |
| 2     | upper tile **A** (objects, drawn over the player) |
| 3     | upper tile **B**                                  |
| 4     | shadow pen                                        |
| 5     | region id                                         |

The tilemap renders **bottom-up (0→1→2→3) with per-pixel alpha** — upper layers
composite over lower ones, and transparent pixels reveal what's beneath.

**Many autotiles are overlays with transparent/feathered edges** — Overworld
**forest, roads, mountains**, and similar decorative terrain elsewhere. If you paint
one directly on layer 0 (the paint default), it _replaces_ the base and its
transparent pixels show the **black empty background**, not ground.

**Do this:**

1. Fill the opaque base terrain (grass, plain dirt, floor) on **layer 0**:
   `fill_area(mapId, x, y, w, h, grassId)` _(layer defaults to 0)_
2. Paint transparent overlays on **layer 1**, leaving the base intact beneath:
   `fill_area(mapId, x, y, w, h, forestId, layer: 1)` — roads, forest, mountains.
3. Multi-tile B/C objects (houses, fountains) go on **layer 2** via `place_object`
   (its default), so they draw over the ground and the player can walk behind them.

Autotiling still works per-layer: forest on layer 1 borders against forest on layer 1
only (the base grass on layer 0 doesn't affect its shape), so a clump still feathers
its edges — and now grass shows through the feathering. Passability resolves
upper-first, so the layer-1 overlay decides the cell with the base as fallback.

**Heuristic:** opaque, full-cell ground → layer 0. Anything decorative that should
"sit on" the ground (forest/road/mountain/most named-feature autotiles) → layer 1
over a base. When unsure whether a tile is transparent, assume it is and layer it —
or check the sheet's alpha.

## Painting maps

- **Find tilesets first.** There's no tileset-list tool yet — read the project's
  `data/Tilesets.json`: each entry's `id`/`name` and `tilesetNames[9]`
  `[A1,A2,A3,A4,A5,B,C,D,E]` (empty string = unused sheet). You need the `tilesetId`
  for every paint/catalog/flag call.
- **Get tile ids** with `find_tile(tilesetId, query)` (case-insensitive **substring**,
  _not_ synonyms — "water" won't match "Sea"; browse names with
  `get_tile_catalog(tilesetId, sheet)` first) or `get_tile_catalog`. Autotile entries
  return the kind's base id — paint it and the shape is computed from neighbours.
- **Don't resize an existing map.** `update_map` changing `width`/`height` does **not**
  resize the tile `data` array — it corrupts the map. Create the map at the size you
  need with `create_map(name, width, height, tilesetId, parentId)` instead.
- **Empty cells are impassable.** A cell with no ground tile on any layer resolves to
  blocked (the engine's fall-through). Always lay a base ground layer before relying
  on a cell being walkable; verify with `check_passability(mapId, x, y)`.

## Entrances, doors & passability — the idiom

Landmarks the player should not walk through (buildings, dungeon mouths, trees, signs)
should be **solid**, and the transfer should trigger from the tile the player **faces
them from** — not from walking onto the landmark.

- **Make the landmark solid:** paint/`place_object` it, then if the tile isn't already
  blocked, `set_tile_flags(tilesetId, tileId, { passage: { down:false,... } },
applyToAutotileKind)` — or check with `get_tile_flags`/`check_passability`.
- **Action-button events only fire from facing when priority is `same`.** With
  priority `below` (the blank-page default), an action-button event fires only when
  the player is **standing on** its tile — so on an impassable tile (a `!Door` on a
  wall, an invisible trigger on a solid landmark) it can **never fire at all**. Any
  event the player activates by facing it — doors, entrance triggers on solid tiles,
  signs — needs `priorityType: 1` / `priority: 'same'`. (`create_npc` defaults to
  `same`; `create_map_event` pages default to `below` — set it explicitly.) The write
  tools **refuse** this combination on an impassable tile rather than placing a dead
  event; fix the priority, don't `force` past it.
- **Two valid transfer idioms:**
  - **Action-button, facing the landmark:** put a `trigger: action_button`,
    **priority `same`** event on the solid landmark tile (or the wall the door sits
    on); the player faces it and presses to enter. Best for buildings/dungeon
    entrances/doors.
  - **Player-touch doormat:** an invisible `trigger: player_touch`, priority `below`
    transfer event on a walkable door/threshold tile the player steps onto. Fine for
    interior exits and map-edge gaps.
- **Avoid** a `player_touch` transfer sitting _on_ a decorative marker tile you can walk
  onto — it works but reads wrong (you walk into the building to leave).
- Build the transfer with `build_transfer_player(mapId, x, y, direction, fade)` →
  `insert_event_commands` (or pass in a `create_map_event` page `list`).

## Events & NPCs

- **Give interactable NPCs a graphic.** `create_npc` with no `characterName` (and no
  tile graphic) makes an **invisible** NPC — almost always a mistake for a talker. Pass
  `characterName` (a basename from `list_assets('characters')`) + `characterIndex`.
  Invisible is only correct for pure trigger/controller events (auto-run logic, doormat
  transfers).
- **MZ does not word-wrap message text.** A Show Text line (401) longer than the
  window is silently **cut off at the right edge**. Break the text into short lines
  yourself: keep each line to **~55 characters** (or **~38 when a face graphic is
  shown** — the face eats a third of the window), max 4 lines per message box; start
  a new Show Text block for longer dialogue. Escape codes (`\C[n]`, `\N[n]`, …)
  don't count toward the display width.
- **One-shot events (chests, defeated bosses, one-time cutscenes) — two-page
  self-switch pattern:**
  - Page 1: does the thing (give item / battle / dialogue), then
    `build_control_switch(scope:'self_switch', name:'A', value:'on')` at the end.
  - Page 2: `conditions: { selfSwitchValid: true, selfSwitchCh: 'A' }`, showing the
    "done" state (opened chest graphic, or empty for a removed boss). `create_map_event`
    deep-merges page `conditions`, so you only pass the two fields.
- **Composition loop:** the `build_*` tools return `{ command }` or `{ commands }`;
  concatenate them into a page `list` (for `create_map_event`/`create_npc.commands`) or
  splice with `insert_event_commands(mapId, eventId, pageIndex, commands)`.
  `call_common_event` returns `{ command }` like the `build_*` tools, so it composes
  the same way.
- **Common-event bodies and troop pages** have their own insert path —
  `append_event_commands(target, …)` with `target: "common_event"` (needs
  `commonEventId`) or `"troop_page"` (needs `troopId` + `pageIndex`). Building the
  whole `list` up front and passing it to `create_common_event`/`create_troop` also
  works — append a `{ code: 0, indent: 0, parameters: [] }` terminator, or the write is
  refused as unterminated.

## Database & combat correctness

- **Hit Rate trait or everything misses.** A custom **class** and a custom **enemy**
  that should land physical attacks need an xparam-HIT trait —
  `{ code: 22, dataId: 0, value: 0.95 }` — passed in `traits`. The default templates
  ship `traits: []`, and HIT sums from 0 with no baseline, so a trait-free battler
  **always misses** physical actions. (`create_class`/`create_actor`/`create_enemy`
  descriptions carry this NOTE.)
- **Add Skill Type trait or learned skills never show.** A class's `learnings` only
  *teach* the skill — the actor can't see or use it unless the class also has an
  **Add Skill Type** trait for that skill's `stypeId`:
  `{ code: 41, dataId: <stypeId>, value: 1 }` (default DB: 1 = Magic, 2 = Special).
  Without it there is **no Magic/Special command in battle or the menu at all** — the
  symptom is "my characters have no skills" even though `learnings` are correct.
  Check each learned skill's `stypeId` in `Skills.json` and cover every distinct one
  with a code-41 trait (a class mixing Magic + Special skills needs both).
- **Verify every asset name.** A wrong filename is a silent blank sprite **and** a
  runtime load error (`Failed to load img/enemies/Foo.png`). Check names against
  `list_assets(...)` before wiring: `battlerName` → `enemies`, `characterName` →
  `characters`, `faceName` → `faces`, audio → `bgm`/`bgs`/`me`/`se`. Several tools warn
  on unknown names (warn-by-default) — **heed the warnings**, don't ignore them.
- **Double-check references the create tools don't validate.** Some create tools throw
  on a bad id (`add_class_learning` skillId, `create_troop` enemyId,
  `call_common_event`), but others silently accept a dangling id
  (`create_state_skill` stateId, `create_enemy` `actions`/`dropItems`, skill/item
  `effects` dataIds). After building, run **`validate_references`** to catch dangling
  ids across the whole project.
- **Set the starting party and position.** `set_party({ partyMembers: [...] })` (actor
  ids; note the arg name differs from `get_party`'s bare array) and
  `update_starting_position(mapId, x, y)`. A game with no party or a start on a blocked
  tile is broken.

## Ship checklist

1. `validate_project` (command shape), `validate_references` (id integrity),
   `validate_event` on the complex events.
2. **Open it in the editor and play:** every NPC visible? every transfer lands on the
   right tile, facing the right way? battlers render? attacks actually hit? terrain
   solid where it should be, no black gaps in forest/roads? entrances feel like
   entrances?
3. Report what you verified in-engine vs. what still needs a human look.
