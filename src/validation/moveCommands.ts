import { MoveCommand, MoveRoute } from '../utils/types.js';
import { ValidationWarning } from './eventCommands.js';

/**
 * Specification for a known RPG Maker MZ move-route command. `params` is the
 * exact number of parameters the command expects (default 0 for the many
 * parameterless move commands). Mirrors the CommandSpec shape in
 * `eventCommands.ts`, but move commands are a separate, smaller code table.
 */
interface MoveCommandSpec {
  name: string;
  params?: number;
}

/**
 * The RPG Maker MZ move-route command table (Game_Character `ROUTE_*` constants).
 * A move route's `list` uses these codes — a different, self-contained table from
 * the event-command codes in `eventCommands.ts`. Codes not listed here produce a
 * soft "unrecognized" warning (warn-by-default), since plugins can add their own.
 */
export const KNOWN_MOVE_COMMANDS: Record<number, MoveCommandSpec> = {
  0: { name: 'Route End' },
  // Directional movement
  1: { name: 'Move Down' },
  2: { name: 'Move Left' },
  3: { name: 'Move Right' },
  4: { name: 'Move Up' },
  5: { name: 'Move Lower Left' },
  6: { name: 'Move Lower Right' },
  7: { name: 'Move Upper Left' },
  8: { name: 'Move Upper Right' },
  9: { name: 'Move at Random' },
  10: { name: 'Move toward Player' },
  11: { name: 'Move away from Player' },
  12: { name: '1 Step Forward' },
  13: { name: '1 Step Backward' },
  14: { name: 'Jump', params: 2 },
  15: { name: 'Wait', params: 1 },
  // Turning
  16: { name: 'Turn Down' },
  17: { name: 'Turn Left' },
  18: { name: 'Turn Right' },
  19: { name: 'Turn Up' },
  20: { name: 'Turn 90° Right' },
  21: { name: 'Turn 90° Left' },
  22: { name: 'Turn 180°' },
  23: { name: 'Turn 90° Right or Left' },
  24: { name: 'Turn at Random' },
  25: { name: 'Turn toward Player' },
  26: { name: 'Turn away from Player' },
  // Switches / movement attributes
  27: { name: 'Switch ON', params: 1 },
  28: { name: 'Switch OFF', params: 1 },
  29: { name: 'Change Speed', params: 1 },
  30: { name: 'Change Frequency', params: 1 },
  31: { name: 'Walking Animation ON' },
  32: { name: 'Walking Animation OFF' },
  33: { name: 'Stepping Animation ON' },
  34: { name: 'Stepping Animation OFF' },
  35: { name: 'Direction Fix ON' },
  36: { name: 'Direction Fix OFF' },
  37: { name: 'Through ON' },
  38: { name: 'Through OFF' },
  39: { name: 'Transparent ON' },
  40: { name: 'Transparent OFF' },
  // Appearance / audio / script
  41: { name: 'Change Image', params: 2 },
  42: { name: 'Change Opacity', params: 1 },
  43: { name: 'Change Blend Mode', params: 1 },
  44: { name: 'Play SE', params: 1 },
  45: { name: 'Script', params: 1 },
};

/** Validate a single move-route command. */
export function validateMoveCommand(command: MoveCommand, path: string): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  if (typeof command?.code !== 'number') {
    warnings.push({ path, message: 'move command is missing a numeric `code`', severity: 'error' });
    return warnings;
  }

  if (!Array.isArray(command.parameters)) {
    warnings.push({
      path,
      code: command.code,
      message: '`parameters` is not an array',
      severity: 'error',
    });
    return warnings;
  }

  const spec = KNOWN_MOVE_COMMANDS[command.code];
  if (!spec) {
    // Advisory, for the same reason as an unrecognized event command code.
    warnings.push({
      path,
      code: command.code,
      message: `unrecognized move command code ${command.code} (may be a plugin move command)`,
      severity: 'warning',
    });
    return warnings;
  }

  const expected = spec.params ?? 0;
  if (command.parameters.length !== expected) {
    warnings.push({
      path,
      code: command.code,
      message: `${spec.name}: expected ${expected} parameter(s), got ${command.parameters.length}`,
      severity: 'error',
    });
  }

  return warnings;
}

/**
 * Validate a move route (the object command 205 carries, or an event page's
 * autonomous `moveRoute`). Checks that `list` is an array terminated by the
 * Route-End marker (code 0), then validates each move command. Never throws —
 * findings are returned and classified by `severity`; it's the mutating tools
 * that decide to refuse a write (see `validation/gate.ts`).
 */
export function validateMoveRoute(route: unknown, path = 'move route'): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  if (!route || typeof route !== 'object' || !Array.isArray((route as MoveRoute).list)) {
    warnings.push({ path, message: 'move route has no `list` array', severity: 'error' });
    return warnings;
  }

  const list = (route as MoveRoute).list;
  if (list.length === 0 || list[list.length - 1]?.code !== 0) {
    warnings.push({
      path,
      message: 'move route should end with a Route-End command (code 0)',
      severity: 'error',
    });
  }

  list.forEach((command, i) => {
    warnings.push(...validateMoveCommand(command, `${path} / command ${i}`));
  });

  return warnings;
}
