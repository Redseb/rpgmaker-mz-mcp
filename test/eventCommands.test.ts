import { describe, it, expect } from 'vitest';
import {
  validateCommand,
  validateCommandList,
  validateEvent,
  validateEvents,
  textLineWidthWarnings,
  KNOWN_COMMANDS,
} from '../src/validation/eventCommands.js';
import { EventCommand, MapEvent } from '../src/utils/types.js';

const cmd = (code: number, parameters: unknown[] = [], indent = 0): EventCommand => ({
  code,
  indent,
  parameters,
});

describe('validateCommand', () => {
  it('accepts a well-formed known command', () => {
    expect(validateCommand(cmd(117, [3]), 'x')).toEqual([]);
  });

  it('flags a wrong parameter count for a checked command', () => {
    const warnings = validateCommand(cmd(201, [0, 1, 2]), 'x');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: 201 });
    expect(warnings[0].message).toMatch(/Transfer Player/);
  });

  it('accepts either arity variant of Show Text (4 or 5 params)', () => {
    expect(validateCommand(cmd(101, ['', 0, 0, 2]), 'x')).toEqual([]);
    expect(validateCommand(cmd(101, ['', 0, 0, 2, 'Reid']), 'x')).toEqual([]);
    expect(validateCommand(cmd(101, ['', 0, 0]), 'x')).toHaveLength(1);
  });

  it('warns (does not error) on an unrecognized code, hinting at plugins', () => {
    const warnings = validateCommand(cmd(9999, []), 'x');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/unrecognized command code 9999.*plugin/);
  });

  it('flags a missing numeric code and a non-array parameters', () => {
    expect(validateCommand({ indent: 0 } as unknown as EventCommand, 'x')[0].message).toMatch(
      /numeric `code`/,
    );
    expect(
      validateCommand({ code: 117, parameters: 'nope' } as unknown as EventCommand, 'x')[0].message,
    ).toMatch(/not an array/);
  });
});

describe('validateCommandList', () => {
  it('accepts a list terminated by the code-0 end marker', () => {
    expect(validateCommandList([cmd(117, [1]), cmd(0)], 'p')).toEqual([]);
  });

  it('warns when the list is not terminated by code 0', () => {
    const warnings = validateCommandList([cmd(117, [1])], 'p');
    expect(warnings.some((w) => /end-of-list/.test(w.message))).toBe(true);
  });

  it('warns when the list is not an array', () => {
    expect(validateCommandList('nope', 'p')[0].message).toMatch(/not an array/);
  });
});

describe('textLineWidthWarnings', () => {
  const setup = (face: string) => cmd(101, [face, 0, 0, 2, '']);
  const line = (text: string) => cmd(401, [text]);

  it('accepts lines within the no-face budget (~55 chars)', () => {
    expect(textLineWidthWarnings([setup(''), line('a'.repeat(55))], 'p')).toEqual([]);
  });

  it('warns on a line too wide for the window (MZ does not wrap)', () => {
    const warnings = textLineWidthWarnings([setup(''), line('a'.repeat(60))], 'p');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: 401 });
    expect(warnings[0].message).toMatch(/does not word-wrap/);
  });

  it('shrinks the budget to ~38 chars while a face is shown', () => {
    const forgiving = 'a'.repeat(45); // fine without a face, too wide with one
    expect(textLineWidthWarnings([setup(''), line(forgiving)], 'p')).toEqual([]);
    const warnings = textLineWidthWarnings([setup('Actor1'), line(forgiving)], 'p');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/with a face shown/);
  });

  it('a later face-less 101 restores the full budget', () => {
    const list = [setup('Actor1'), line('short'), setup(''), line('a'.repeat(50))];
    expect(textLineWidthWarnings(list, 'p')).toEqual([]);
  });

  it('escape codes cost no display width', () => {
    const decorated = '\\C[3]' + 'a'.repeat(50) + '\\C[0]\\G\\\\';
    expect(textLineWidthWarnings([setup(''), line(decorated)], 'p')).toEqual([]);
  });

  it('surfaces through validateCommandList', () => {
    const warnings = validateCommandList([setup(''), line('a'.repeat(60)), cmd(0)], 'p');
    expect(warnings.some((w) => /cut off/.test(w.message))).toBe(true);
  });
});

describe('validateEvent / validateEvents', () => {
  const goodEvent = (id: number): MapEvent => ({
    id,
    name: `Event ${id}`,
    note: '',
    x: 0,
    y: 0,
    pages: [{ list: [cmd(101, ['', 0, 0, 2]), cmd(401, ['Hi']), cmd(0)] }] as MapEvent['pages'],
  });

  it('reports ok for a clean event', () => {
    expect(validateEvent(goodEvent(1))).toEqual({ ok: true, warnings: [] });
  });

  it('collects warnings across pages', () => {
    const bad: MapEvent = {
      ...goodEvent(2),
      pages: [{ list: [cmd(201, [0])] }] as MapEvent['pages'],
    };
    const report = validateEvent(bad);
    expect(report.ok).toBe(false);
    // Both the arity problem and the missing terminator surface.
    expect(report.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('skips null slots in an events array', () => {
    const report = validateEvents([null, goodEvent(1), null]);
    expect(report.ok).toBe(true);
  });
});

describe('KNOWN_COMMANDS table', () => {
  it('recognizes the code-0 end marker', () => {
    expect(KNOWN_COMMANDS[0]).toBeDefined();
  });
});
