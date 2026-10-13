import type { ProjectData } from '../validation/references.js';
import { scanIdUsage, type IdNamespace } from '../validation/idUsage.js';
import type { EventCommand } from '../utils/types.js';

export const STATIC_COVERAGE =
  'Static JSON analysis only. Conditional pages and branches are treated as possible, not proven executable. Scripts, plugin commands, computed IDs, globally triggered common events and runtime state may add behavior this scan cannot resolve. Missing maps are reported separately; no reachability or writer finding proves a runtime defect.';

export interface CommandSource {
  path: string;
  label: string;
  note?: string;
  commands: EventCommand[];
  mapId?: number;
  eventId?: number;
  commonEventId?: number;
  troopId?: number;
  pageIndex?: number;
}

export function commandSources(data: ProjectData): CommandSource[] {
  const sources: CommandSource[] = [];
  for (const map of data.maps) {
    for (const event of map.events ?? []) {
      if (!event) continue;
      (event.pages ?? []).forEach((page, pageIndex) =>
        sources.push({
          path: `map ${map.id} / event ${event.id} / page ${pageIndex}`,
          label: event.name ?? '',
          note: event.note ?? '',
          mapId: map.id,
          eventId: event.id,
          pageIndex,
          commands: Array.isArray(page.list) ? page.list : [],
        }),
      );
    }
  }
  for (const common of data.commonEvents) {
    if (common)
      sources.push({
        path: `common event ${common.id}`,
        label: common.name ?? '',
        commonEventId: common.id,
        commands: common.list ?? [],
      });
  }
  for (const troop of data.troops) {
    if (!troop) continue;
    (troop.pages ?? []).forEach((page, pageIndex) =>
      sources.push({
        path: `troop ${troop.id} / page ${pageIndex}`,
        label: troop.name ?? '',
        troopId: troop.id,
        pageIndex,
        commands: Array.isArray(page.list) ? page.list : [],
      }),
    );
  }
  return sources;
}

export interface Edge {
  from: number;
  to: number;
  path: string;
}
export function mapGraph(data: ProjectData, removeMapId?: number) {
  const loaded = new Set(data.maps.map((map) => map.id));
  const info = data.mapInfos.filter((value) => value !== null);
  const nodes = info.filter((map) => loaded.has(map.id)).map(({ id, name }) => ({ id, name }));
  const missingMaps = info
    .filter((map) => !loaded.has(map.id))
    .map(({ id, name }) => ({ id, name }));
  const edges: Edge[] = [];
  const unresolved: { path: string; reason: string }[] = [];
  const sources = commandSources(data);
  const common = new Map(
    sources
      .filter((source) => source.commonEventId !== undefined)
      .map((source) => [source.commonEventId!, source]),
  );
  const pendingSources = sources
    .filter((source) => source.mapId !== undefined)
    .map((source) => ({ mapId: source.mapId!, source, prefix: '' }));
  const visitedSources = new Set<string>();
  while (pendingSources.length) {
    const { mapId, source, prefix } = pendingSources.pop()!;
    const sourceKey = `${mapId}:${source.path}`;
    if (visitedSources.has(sourceKey)) continue;
    visitedSources.add(sourceKey);
    source.commands.forEach((command, index) => {
      const p = command?.parameters ?? [];
      const path = `${prefix}${source.path} / command ${index}`;
      if (command?.code === 201) {
        if (p[0] === 0 && Number.isSafeInteger(p[1]) && Number(p[1]) > 0)
          edges.push({ from: mapId, to: Number(p[1]), path });
        else
          unresolved.push({ path, reason: 'Transfer destination is variable-based or malformed' });
      } else if (command?.code === 117) {
        const id = Number(p[0]);
        const called = common.get(id);
        if (called)
          pendingSources.push({ mapId, source: called, prefix: `${path.slice(-500)} -> ` });
        else unresolved.push({ path, reason: `Common event ${id} was not loaded` });
      } else if ([355, 356, 357].includes(command?.code))
        unresolved.push({ path, reason: 'Script/plugin behavior is not statically resolved' });
    });
  }
  const uniqueEdges = [
    ...new Map(edges.map((edge) => [`${edge.from}:${edge.to}:${edge.path}`, edge])).values(),
  ];
  const startMapId = data.system?.startMapId ?? 0;
  const reachableFromStart = (removed?: number) => {
    const seen = new Set<number>();
    const pending = loaded.has(startMapId) && removed !== startMapId ? [startMapId] : [];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id) || id === removed) continue;
      seen.add(id);
      for (const edge of uniqueEdges)
        if (edge.from === id && loaded.has(edge.to) && edge.to !== removed) pending.push(edge.to);
    }
    return [...seen].sort((a, b) => a - b);
  };
  const reachable = reachableFromStart();
  const afterRemoval = new Set(reachableFromStart(removeMapId));
  const removal =
    removeMapId === undefined
      ? undefined
      : {
          mapId: removeMapId,
          isStartMap: removeMapId === startMapId,
          incoming: uniqueEdges.filter(
            (edge) => edge.to === removeMapId && edge.from !== removeMapId,
          ),
          newlyUnreachable: nodes.filter(
            (node) =>
              node.id !== removeMapId && reachable.includes(node.id) && !afterRemoval.has(node.id),
          ),
        };
  return {
    startMapId,
    nodes,
    edges: uniqueEdges,
    reachable,
    unreachable: nodes.filter((node) => !reachable.includes(node.id)),
    missingMaps,
    unresolved,
    ...(removal ? { removal } : {}),
    coverage: STATIC_COVERAGE,
  };
}

export function idExplanation(data: ProjectData, namespace: IdNamespace, id: number) {
  const commands = new Map<string, EventCommand>();
  for (const source of commandSources(data))
    source.commands.forEach((command, index) =>
      commands.set(`${source.path} / command ${index}`, command),
    );
  const matchingReferences = scanIdUsage(data, namespace).filter((ref) => ref.id === id);
  // The general scanner caps range expansion at 1,000 IDs. A single-ID query
  // can test range membership directly, without allocating every intervening ID.
  const rangeCode = namespace === 'switch' ? 121 : namespace === 'variable' ? 122 : undefined;
  for (const [path, command] of commands) {
    if (rangeCode === undefined || command?.code !== rangeCode) continue;
    const p = command.parameters;
    if (
      Array.isArray(p) &&
      Number.isSafeInteger(p[0]) &&
      Number.isSafeInteger(p[1]) &&
      Number(p[0]) > 0 &&
      Number(p[0]) <= id &&
      id <= Number(p[1])
    )
      matchingReferences.push({
        id,
        path,
        via: rangeCode === 121 ? 'Control Switches' : 'Control Variables',
      });
  }
  const references = matchingReferences.map((ref) => {
    const command = commands.get(ref.path);
    const p = command?.parameters ?? [];
    let write = false;
    let read = true;
    if (namespace === 'switch' && command?.code === 121) {
      write = true;
      read = false;
    }
    if (namespace === 'variable' && command?.code === 122) {
      write = id >= Number(p[0]) && id <= Number(p[1]);
      read = (write && p[2] !== 0) || (p[3] === 1 && p[4] === id);
    }
    if (namespace === 'variable' && command && [103, 104, 285].includes(command.code)) {
      write = p[0] === id;
      read = command.code === 285 && p[2] === 1 && (p[3] === id || p[4] === id);
    }
    return { ...ref, role: write ? (read ? 'both' : 'write') : 'read' };
  });
  const unique = [...new Map(references.map((ref) => [`${ref.path}:${ref.role}`, ref])).values()];
  const readers = unique.filter((ref) => ref.role !== 'write');
  const writers = unique.filter((ref) => ref.role !== 'read');
  const label =
    namespace === 'common_event'
      ? (data.commonEvents.find((common) => common?.id === id)?.name ?? '')
      : ((namespace === 'switch' ? data.system?.switches : data.system?.variables)?.[id] ?? '');
  const diagnosis = !unique.length
    ? 'No statically recognized references were found.'
    : namespace === 'common_event'
      ? `${unique.length} static reference sites found.`
      : !writers.length
        ? 'Readers were found but no static writer was identified. Check scripts, plugins and initialization before treating this as a bug.'
        : !readers.length
          ? 'Static writes were found without a recognized reader. Review runtime/plugin use before removing them.'
          : `${writers.length} static writer sites and ${readers.length} reader sites were found; this does not establish execution order or values.`;
  return {
    namespace,
    id,
    name: label,
    references: unique,
    readers,
    writers,
    diagnosis,
    coverage: `${STATIC_COVERAGE} Recognized switch/variable write ranges are checked against the queried ID directly, beyond the general scanner's 1,000-ID expansion cap. Other reference forms follow the curated ID scanner and may be omitted when unsupported.`,
  };
}

export interface SearchDocument {
  path: string;
  label: string;
  text: string;
}
export function projectDocuments(data: ProjectData): SearchDocument[] {
  const docs: SearchDocument[] = data.mapInfos
    .filter((info) => info !== null)
    .map((info) => ({ path: `map ${info.id}`, label: info.name, text: info.name }));
  for (const source of commandSources(data)) {
    const text = source.commands
      .flatMap((command) => {
        if ([101, 401, 405, 108, 408, 102, 402, 357, 657].includes(command?.code))
          return [JSON.stringify(command.parameters)];
        return [];
      })
      .join('\n');
    docs.push({ path: source.path, label: source.label, text: `${source.note ?? ''}\n${text}` });
  }
  for (const kind of [
    'actors',
    'classes',
    'skills',
    'items',
    'weapons',
    'armors',
    'enemies',
    'states',
  ] as const) {
    for (const entry of data[kind]) {
      if (!entry) continue;
      const fields = entry as unknown as Record<string, unknown>;
      docs.push({
        path: `${kind} ${entry.id}`,
        label: entry.name,
        text: ['description', 'note', 'profile', 'nickname']
          .map((key) => String(fields[key] ?? ''))
          .join('\n'),
      });
    }
  }
  return docs;
}

export function searchDocuments(documents: SearchDocument[], query: string, limit: number) {
  const terms = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const phrase = query.toLocaleLowerCase().trim();
  const hits = documents
    .map((doc) => {
      const label = doc.label.toLocaleLowerCase();
      const text = doc.text.toLocaleLowerCase();
      const score =
        terms.reduce(
          (sum, term) => sum + (label.includes(term) ? 6 : 0) + (text.includes(term) ? 1 : 0),
          0,
        ) +
        (label.includes(phrase) ? 10 : 0) +
        (text.includes(phrase) ? 3 : 0);
      const at = Math.max(
        0,
        ...terms
          .map((term) => text.indexOf(term))
          .filter((index) => index >= 0)
          .slice(0, 1),
      );
      return {
        path: doc.path,
        label: doc.label,
        score,
        snippet: `${doc.label}: ${doc.text.slice(Math.max(0, at - 50), at + 180)}`,
      };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    total: hits.length,
    hits: hits.slice(0, limit),
    coverage:
      'Offline lexical token/phrase matching over names, dialogue, notes and database descriptions. No embeddings, synonym inference, script execution or plugin-generated text.',
  };
}

export function duplicateCommands(sources: CommandSource[], minLength: number, limit: number) {
  const windows = new Map<
    string,
    { source: CommandSource; index: number; commands: EventCommand[] }[]
  >();
  for (const source of sources) {
    for (let index = 0; index + minLength <= source.commands.length; index++) {
      const commands = source.commands.slice(index, index + minLength);
      if (
        commands.some((command) => !command || command.code === 0) ||
        new Set(commands.map((command) => command.code)).size < 2
      )
        continue;
      const base = Math.min(...commands.map((command) => command.indent ?? 0));
      const key = JSON.stringify(
        commands.map((command) => [command.code, (command.indent ?? 0) - base, command.parameters]),
      );
      const group = windows.get(key) ?? [];
      group.push({ source, index, commands });
      windows.set(key, group);
    }
  }
  const blocks = [...windows.values()]
    .filter((group) => new Set(group.map((occ) => occ.source.path)).size >= 2)
    .map((group) => ({
      length: minLength,
      codes: group[0].commands.map((command) => command.code),
      occurrences: group.map((occ) => ({ path: occ.source.path, startIndex: occ.index })),
      recommendation:
        'Review this repeated sequence for a shared common event. Verify complete control-flow boundaries and event/map/self-switch context before extracting.',
    }))
    .sort((a, b) => b.occurrences.length - a.occurrences.length);
  return {
    total: blocks.length,
    blocks: blocks.slice(0, limit),
    coverage: `Exact ${minLength}-command windows with equal parameters and relative indentation across different sources. Overlapping windows may be reported. This is a review proposal, not an automatic extraction or proof that context is interchangeable.`,
  };
}
