import { describe, it, expect } from 'vitest';
import { blockingWarnings, assertWritable, writeGate } from '../src/validation/gate.js';
import { ValidationWarning } from '../src/validation/eventCommands.js';

const structural: ValidationWarning = {
  path: 'page 0',
  message: 'command list should end with an end-of-list command (code 0)',
  severity: 'error',
};
const advisory: ValidationWarning = {
  path: 'page 0 / command 1',
  message: 'unrecognized command code 999 (may be a plugin command)',
  severity: 'warning',
};
/** A finding from a validator that doesn't classify (asset names, references). */
const unclassified: ValidationWarning = { path: 'image.characterName', message: 'unknown sprite' };

describe('blockingWarnings', () => {
  it('selects only structural findings', () => {
    expect(blockingWarnings([structural, advisory, unclassified])).toEqual([structural]);
  });

  it('treats an unclassified finding as advisory, so it can never block', () => {
    expect(blockingWarnings([advisory, unclassified])).toEqual([]);
  });
});

describe('assertWritable', () => {
  it('passes when nothing is structural', () => {
    expect(() => assertWritable([advisory, unclassified], undefined, 'thing')).not.toThrow();
  });

  it('throws naming the subject, every blocking finding, and the escape hatch', () => {
    let error: Error | undefined;
    try {
      assertWritable([structural, advisory], undefined, 'event on map 3');
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toMatch(/event on map 3/);
    expect(error?.message).toMatch(/end-of-list command/);
    expect(error?.message).toMatch(/force: true/);
    // Advisory findings aren't listed as reasons for the refusal.
    expect(error?.message).not.toMatch(/unrecognized command code/);
  });

  it('does not throw when forced', () => {
    expect(() => assertWritable([structural], true, 'thing')).not.toThrow();
  });
});

describe('writeGate', () => {
  it('collects findings and lets a clean write through with no warnings key', async () => {
    const gate = writeGate<string>(undefined, 'thing', () => []);
    await gate.precommit('value');
    expect(gate.respond({ ok: true })).toEqual({ ok: true });
  });

  it('attaches advisory findings to the response without blocking', async () => {
    const gate = writeGate<string>(undefined, 'thing', () => [advisory]);
    await gate.precommit('value');
    expect(gate.respond({ ok: true })).toEqual({ ok: true, warnings: [advisory] });
  });

  it('throws from the precommit hook on a structural finding', async () => {
    const gate = writeGate<string>(undefined, 'thing', () => [structural]);
    await expect(gate.precommit('value')).rejects.toThrow(/Refusing to write thing/);
  });

  it('forced: still reports the structural finding, but writes', async () => {
    const gate = writeGate<string>(true, 'thing', () => [structural]);
    await gate.precommit('value');
    expect(gate.respond({ ok: true })).toEqual({ ok: true, warnings: [structural] });
  });

  it('awaits an async compute (reachability needs file reads)', async () => {
    const gate = writeGate<string>(undefined, 'thing', async () => [structural]);
    await expect(gate.precommit('value')).rejects.toThrow(/Refusing to write/);
  });

  it('passes the would-be value to compute, not the committed one', async () => {
    const seen: string[] = [];
    const gate = writeGate<string>(undefined, 'thing', (value) => {
      seen.push(value);
      return [];
    });
    await gate.precommit('the built value');
    expect(seen).toEqual(['the built value']);
  });
});
