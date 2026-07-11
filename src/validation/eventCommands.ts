import { EventCommand, MapEvent } from '../utils/types.js';

/**
 * A single non-fatal validation finding. Validation is warn-by-default: findings
 * never block a write, they just tell the caller something looks off (a wrong
 * parameter count, an unterminated command list, an unrecognized command code —
 * which may simply be a plugin command).
 */
export interface ValidationWarning {
  path: string;
  code?: number;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  warnings: ValidationWarning[];
}

/**
 * Specification for a known RPG Maker MZ event command. `check` returns a warning
 * message when the parameters look wrong, or `null` when they're fine. Commands
 * with no `check` are recognized (so they don't trip the unknown-code warning)
 * but their parameters aren't inspected.
 */
interface CommandSpec {
  name: string;
  check?: (params: unknown[]) => string | null;
}

const expectLength =
  (n: number) =>
  (params: unknown[]): string | null =>
    params.length === n ? null : `expected ${n} parameter(s), got ${params.length}`;

const expectAtLeast =
  (n: number) =>
  (params: unknown[]): string | null =>
    params.length >= n ? null : `expected at least ${n} parameter(s), got ${params.length}`;

/**
 * Curated table of core RPG Maker MZ event command codes. Not exhaustive — it
 * covers the commands this server is most likely to read or write, plus enough
 * of the common set that an unrecognized code is a meaningful signal. Codes not
 * listed here produce a soft "unrecognized" warning rather than an error, since
 * plugins are free to introduce their own.
 */
export const KNOWN_COMMANDS: Record<number, CommandSpec> = {
  0: { name: 'End of list' },
  // Messages
  101: {
    name: 'Show Text (setup)',
    check: (p) =>
      p.length === 4 || p.length === 5
        ? null
        : `Show Text expects 4 or 5 parameters, got ${p.length}`,
  },
  102: { name: 'Show Choices', check: expectAtLeast(2) },
  103: { name: 'Input Number', check: expectLength(2) },
  104: { name: 'Select Item', check: expectLength(2) },
  105: { name: 'Show Scrolling Text', check: expectAtLeast(1) },
  108: { name: 'Comment', check: expectAtLeast(1) },
  // Flow control
  111: { name: 'Conditional Branch', check: expectAtLeast(1) },
  112: { name: 'Loop' },
  113: { name: 'Break Loop' },
  115: { name: 'Exit Event Processing' },
  117: { name: 'Common Event', check: expectLength(1) },
  118: { name: 'Label', check: expectLength(1) },
  119: { name: 'Jump to Label', check: expectLength(1) },
  // Game progression
  121: { name: 'Control Switches', check: expectLength(3) },
  122: { name: 'Control Variables', check: expectAtLeast(4) },
  123: { name: 'Control Self Switch', check: expectLength(2) },
  124: { name: 'Control Timer', check: expectAtLeast(1) },
  125: { name: 'Change Gold', check: expectLength(3) },
  126: { name: 'Change Items', check: expectLength(4) },
  127: { name: 'Change Weapons', check: expectLength(5) },
  128: { name: 'Change Armors', check: expectLength(5) },
  129: { name: 'Change Party Member', check: expectLength(3) },
  // Movement / character
  201: { name: 'Transfer Player', check: expectLength(6) },
  202: { name: 'Set Vehicle Location' },
  203: { name: 'Set Event Location' },
  204: { name: 'Scroll Map' },
  205: { name: 'Set Movement Route', check: expectAtLeast(2) },
  211: { name: 'Change Transparency' },
  212: { name: 'Show Animation', check: expectLength(3) },
  213: { name: 'Show Balloon Icon', check: expectLength(3) },
  // Screen / audio / timing
  221: { name: 'Fadeout Screen', check: expectLength(0) },
  222: { name: 'Fadein Screen', check: expectLength(0) },
  223: { name: 'Tint Screen', check: expectLength(3) },
  224: { name: 'Flash Screen', check: expectLength(3) },
  225: { name: 'Shake Screen', check: expectLength(4) },
  230: { name: 'Wait', check: expectLength(1) },
  231: { name: 'Show Picture', check: expectLength(10) },
  235: { name: 'Erase Picture', check: expectLength(1) },
  241: { name: 'Play BGM', check: expectLength(1) },
  242: { name: 'Fadeout BGM' },
  245: { name: 'Play BGS', check: expectLength(1) },
  249: { name: 'Play ME', check: expectLength(1) },
  250: { name: 'Play SE', check: expectLength(1) },
  // Actor / party
  301: { name: 'Battle Processing', check: expectLength(4) },
  302: { name: 'Shop Processing', check: expectLength(5) },
  303: { name: 'Name Input Processing', check: expectLength(2) },
  311: { name: 'Change HP', check: expectLength(6) },
  312: { name: 'Change MP', check: expectLength(5) },
  313: { name: 'Change State', check: expectLength(4) },
  314: { name: 'Recover All', check: expectLength(2) },
  315: { name: 'Change EXP', check: expectLength(6) },
  316: { name: 'Change Level', check: expectLength(6) },
  // Advanced
  355: { name: 'Script', check: expectAtLeast(1) },
  356: { name: 'Plugin Command (MV)', check: expectAtLeast(1) },
  357: { name: 'Plugin Command (MZ)', check: expectAtLeast(4) },
  // Continuation codes (data rows for the setup command above them)
  401: { name: 'Show Text line', check: expectLength(1) },
  402: { name: 'When [choice]', check: expectLength(2) },
  403: { name: 'When Cancel' },
  404: { name: 'End Choices' },
  405: { name: 'Scrolling Text line', check: expectLength(1) },
  408: { name: 'Comment line', check: expectAtLeast(1) },
  505: { name: 'Move Route step', check: expectLength(1) },
  605: { name: 'Shop goods', check: expectLength(4) },
  411: { name: 'Else' },
  412: { name: 'End Conditional Branch' },
  413: { name: 'Repeat Above' },
  655: { name: 'Script line', check: expectAtLeast(1) },
};

/** Validate a single event command. */
export function validateCommand(command: EventCommand, path: string): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  if (typeof command?.code !== 'number') {
    warnings.push({ path, message: 'command is missing a numeric `code`' });
    return warnings;
  }

  if (!Array.isArray(command.parameters)) {
    warnings.push({ path, code: command.code, message: '`parameters` is not an array' });
    return warnings;
  }

  const spec = KNOWN_COMMANDS[command.code];
  if (!spec) {
    warnings.push({
      path,
      code: command.code,
      message: `unrecognized command code ${command.code} (may be a plugin command)`,
    });
    return warnings;
  }

  const problem = spec.check?.(command.parameters);
  if (problem) {
    warnings.push({ path, code: command.code, message: `${spec.name}: ${problem}` });
  }

  return warnings;
}

/**
 * Validate an event command list (an event page's `list`). Checks that it is a
 * proper array terminated by the code-0 end marker, then validates each command.
 */
export function validateCommandList(list: unknown, path: string): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  if (!Array.isArray(list)) {
    warnings.push({ path, message: 'command list is not an array' });
    return warnings;
  }

  if (list.length === 0 || list[list.length - 1]?.code !== 0) {
    warnings.push({
      path,
      message: 'command list should end with an end-of-list command (code 0)',
    });
  }

  list.forEach((command, i) => {
    warnings.push(...validateCommand(command as EventCommand, `${path} / command ${i}`));
  });

  return warnings;
}

/** Validate every page of an event. */
export function validateEvent(event: MapEvent, path = `event ${event?.id}`): ValidationReport {
  const warnings: ValidationWarning[] = [];

  if (!event || !Array.isArray(event.pages)) {
    warnings.push({ path, message: 'event has no `pages` array' });
    return { ok: warnings.length === 0, warnings };
  }

  event.pages.forEach((page, i) => {
    warnings.push(...validateCommandList(page?.list, `${path} / page ${i}`));
  });

  return { ok: warnings.length === 0, warnings };
}

/** Validate every (non-null) event in a map's `events` array. */
export function validateEvents(events: (MapEvent | null)[]): ValidationReport {
  const warnings: ValidationWarning[] = [];

  events.forEach((event) => {
    if (event) {
      warnings.push(...validateEvent(event).warnings);
    }
  });

  return { ok: warnings.length === 0, warnings };
}
