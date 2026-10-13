import { describe, expect, it } from 'vitest';
import { evaluateFormula } from '../src/analysis/formulaEval.js';
import { astToOutline, parseEventCommands } from '../src/analysis/eventOutline.js';

describe('safe formula syntax and outline semantics', () => {
  it.each(['__proto__()', '__defineGetter__()', 'constructor()', 'toString()'])(
    'rejects inherited names without throwing: %s',
    (formula) => {
      expect(() => evaluateFormula(formula)).not.toThrow();
      expect(evaluateFormula(formula).ok).toBe(false);
    },
  );
  it.each([
    '1 2 +',
    'Math.max(1 2)',
    '1(2)+',
    'Math.max(1,)',
    'Math.max(,1)',
    '(1,2)',
    '1--2',
    '--1',
    'v[]',
    'Math.random(1)',
    'Math.max(1)',
    'Math.min(1,2,3)',
  ])('refuses malformed or unsupported grammar: %s', (formula) => {
    expect(evaluateFormula(formula).ok).toBe(false);
  });
  it.each([
    ['Math.max(a.atk * 4 - b.def * 2, 0)', 60],
    ['Math.min(5, Math.max(2,3)) + Math.floor(4.8)', 7],
    ['- -1 + 1- -2', 4],
    ['-(2 + 3) * 4', -20],
    ['Math.random() * 100', 50],
  ])('retains supported arithmetic %s', (formula, value) => {
    expect(evaluateFormula(formula as string)).toEqual({ ok: true, value });
  });
  it.each([
    [[3, 10, 0], 'If Timer >= 10s'],
    [[3, 10, 1], 'If Timer <= 10s'],
    [[7, 100, 0], 'If Gold >= 100'],
    [[7, 100, 1], 'If Gold <= 100'],
    [[7, 100, 2], 'If Gold < 100'],
  ])('uses engine-specific conditional comparison semantics %j', (parameters, expected) => {
    const commands = [
      { code: 111, indent: 0, parameters: parameters as number[] },
      { code: 0, indent: 1, parameters: [] },
      { code: 412, indent: 0, parameters: [] },
      { code: 0, indent: 0, parameters: [] },
    ];
    expect(astToOutline(parseEventCommands(commands)).split('\n')[0]).toBe(expected);
  });
});
