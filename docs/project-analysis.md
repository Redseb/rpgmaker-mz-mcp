# Read-only project analysis

These tools inspect the current on-disk project JSON. They do not execute project
scripts, start the engine, change game files or create caches. Each call rereads
the files, so save changes in the editor before asking for another report.

| Tool | Arguments | Result |
| --- | --- | --- |
| `get_project_overview` | none | Record/command-list counts, unreachable/missing maps and a reference-warning sample. |
| `analyze_transfer_graph` | optional `removeMapId` | Static transfer edges, reachable/missing maps, unresolved transfers and optional removal impact. |
| `explain_state_id` | `type: "switch" | "variable"`, `id` | Static readers, writers, read-modify-write sites and a cautious diagnosis. |
| `outline_event` | `target` object (below) | A structured command tree and readable outline for one page or common event. |
| `analyze_database_balance` | optional `category`, `thresholdSd` | Advisory peer outliers and unsupported skill formulas. |
| `search_project` | `query`, optional `limit` | Ranked lexical matches, snippets and source paths. |
| `find_duplicate_event_blocks` | optional `minLength`, `limit` | Repeated command windows and their source positions. |
| `analyze_map_layout` | `mapId`, optional `start: {x,y}`, `maxComponents` | Static tile-passage components, reachable cells, repetition and event-position access. |

All eight tools advertise MCP read-only hints. Each has its own arguments; there
is no broad `analyze_project(view, ...)` dispatcher. The existing
`list_allocated_ids` remains the tool for allocation and simple reference lookup,
including common-event callers. `validate_references` still returns the complete
reference-lint report. `validate_event` checks map-event command structure.

## Examples

Ask whether deleting map 7 would disconnect other maps without modifying anything:

```json
{"tool":"analyze_transfer_graph","arguments":{"removeMapId":7}}
```

Inspect switch 12's readers and writers:

```json
{"tool":"explain_state_id","arguments":{"type":"switch","id":12}}
```

Outline a map event, common event or troop page. Page indexes are zero-based:

```json
{"tool":"outline_event","arguments":{"target":{"type":"map_event","mapId":1,"eventId":3,"pageIndex":0}}}
{"tool":"outline_event","arguments":{"target":{"type":"common_event","commonEventId":4}}}
{"tool":"outline_event","arguments":{"target":{"type":"troop_page","troopId":2,"pageIndex":0}}}
```

Find dialogue mentioning the gatekeeper, then inspect map access:

```json
{"tool":"search_project","arguments":{"query":"gatekeeper","limit":10}}
{"tool":"analyze_map_layout","arguments":{"mapId":1,"start":{"x":5,"y":8}}}
```

## Interpretation and limits

- Project snapshots reuse the existing reference linter's loader. Missing or
  unreadable database files are treated as empty; listed maps that could not be
  loaded appear as missing maps. Reports are not a replacement for validation.
- Transfer graphs include direct transfers and recursively called common events,
  with a cycle guard. All event pages and conditional branches count as possible
  paths. Variable destinations, global autoruns, scripts and plugin behavior can
  add connections the graph cannot resolve. Removal impact is a simulation.
- State explanations reuse the curated ID scanner and classify recognized writes.
  Switch/variable ranges are checked directly against the queried ID, including
  ranges larger than the scanner's expansion cap. Missing static writers or
  readers do not establish a runtime bug.
- Event outlines include MZ's speaker field and plugin-command labels. Malformed
  indentation receives best-effort rendering rather than structural validation.
- Balance reports compare peers, not progression tiers. Skills use damage per MP
  with fixed reference stats and a restricted arithmetic parser. Unsupported
  formulas are reported rather than executed. Other metrics and reference stats
  appear in the report. Fewer than four samples are insufficient for outlier
  detection; identical peers can produce an outlier with a null deviation score.
- Search matches lexical tokens and phrases across names, notes, descriptions,
  dialogue, choice labels and plugin-command text. It uses no external services
  or embeddings and cannot find dynamically generated dialogue.
- Duplicate reports compare exact command windows with relative indentation.
  Overlapping windows may appear. Review block boundaries, self-switches, event
  IDs and map context before extracting a shared common event.
- Map layout uses the existing layered tile flags, checking both source exit and
  destination entry, star flags and map wrapping. It ignores active event pages,
  event collisions, vehicles and plugins. With no `start`, the reference position
  comes from the largest static component. Repetition ignores autotile shapes.
  Use existing `render_map` and `run_playtest` for engine behavior and appearance.

## Verification

```bash
npm test
npm run verify:analysis
```

The protocol check starts the real stdio server with a temporary JSON-only
project, checks all eight advertised schemas and read-only annotations, exercises
their reports and invalid inputs, and verifies every fixture file is unchanged.
It does not read or modify the configured game project and needs no RPG Maker
installation or licensed assets.
