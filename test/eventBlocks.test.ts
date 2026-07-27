import { describe, it, expect } from 'vitest';
import { blockStructureWarnings } from '../src/validation/eventBlocks.js';
import { validateCommandList } from '../src/validation/eventCommands.js';
import {
  showChoices,
  conditionalBranch,
  showText,
  controlSelfSwitch,
} from '../src/events/commandBuilders.js';
import { EventCommand } from '../src/utils/types.js';

const cmd = (code: number, parameters: unknown[] = [], indent = 0): EventCommand => ({
  code,
  indent,
  parameters,
});

/** A page list: the built commands plus the page's own code-0 terminator. */
const page = (commands: EventCommand[]): EventCommand[] => [...commands, cmd(0)];

const errors = (warnings: { severity?: string }[]) =>
  warnings.filter((w) => w.severity === 'error');

describe('blockStructureWarnings — the builders round-trip clean', () => {
  it('accepts a Show Choices block with branches and a cancel branch', () => {
    const list = page(
      showChoices(['Yes', 'No'], {
        branches: [showText(['Great.']), showText(['Shame.'])],
        cancelBranch: [controlSelfSwitch('A', 'on')],
      }),
    );
    expect(blockStructureWarnings(list, 'p')).toEqual([]);
    expect(validateCommandList(list, 'p')).toEqual([]);
  });

  it('accepts a Show Choices block with no cancel branch', () => {
    const list = page(showChoices(['Buy', 'Sell', 'Leave']));
    expect(blockStructureWarnings(list, 'p')).toEqual([]);
  });

  it('accepts a Conditional Branch with and without an Else', () => {
    const withElse = page(
      conditionalBranch(
        { type: 'switch', switchId: 3 },
        { thenBranch: showText(['on']), elseBranch: showText(['off']) },
      ),
    );
    const withoutElse = page(
      conditionalBranch({ type: 'self_switch', name: 'A' }, { thenBranch: showText(['once']) }),
    );
    expect(blockStructureWarnings(withElse, 'p')).toEqual([]);
    expect(blockStructureWarnings(withoutElse, 'p')).toEqual([]);
  });

  it('accepts blocks nested inside blocks', () => {
    const list = page(
      showChoices(['Fight', 'Flee'], {
        branches: [
          conditionalBranch(
            { type: 'variable', variableId: 1, comparison: '>=', constant: 10 },
            { thenBranch: showText(['You win.']), elseBranch: showText(['You lose.']) },
          ),
          showText(['You run.']),
        ],
      }),
    );
    expect(blockStructureWarnings(list, 'p')).toEqual([]);
    expect(validateCommandList(list, 'p')).toEqual([]);
  });
});

describe('blockStructureWarnings — unclosed blocks', () => {
  it('flags a Show Choices with no End Choices (404)', () => {
    const list = [cmd(102, [['Yes'], -1, 0, 2, 0]), cmd(402, [0, 'Yes']), cmd(0, [], 1), cmd(0)];
    const warnings = blockStructureWarnings(list, 'p');
    expect(errors(warnings)).toHaveLength(1);
    expect(warnings[0].message).toMatch(/never closed by 404/);
  });

  it('flags a Conditional Branch with no End (412)', () => {
    const list = [cmd(111, [0, 1, 0]), cmd(0, [], 1), cmd(0)];
    expect(blockStructureWarnings(list, 'p')[0].message).toMatch(/never closed by 412/);
  });

  it('flags a Loop with no Repeat Above (413)', () => {
    const list = [cmd(112), cmd(113, [], 1), cmd(0)];
    expect(blockStructureWarnings(list, 'p')[0].message).toMatch(/never closed by 413/);
  });

  it('flags an inner block left open when its enclosing block closes', () => {
    const list = [
      cmd(111, [0, 1, 0]),
      cmd(112, [], 1), // loop opened inside the branch, never closed
      cmd(0, [], 1),
      cmd(412),
      cmd(0),
    ];
    const messages = blockStructureWarnings(list, 'p').map((w) => w.message);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/Loop \(112\) opened at command 1 is not closed by 413/);
  });
});

describe('blockStructureWarnings — orphaned marker rows', () => {
  it('flags an End Conditional Branch with no opener', () => {
    const warnings = blockStructureWarnings([cmd(412), cmd(0)], 'p');
    expect(errors(warnings)).toHaveLength(1);
    expect(warnings[0].message).toMatch(/End Conditional Branch \(412\) has no matching/);
  });

  it('flags a closer written at a different indent than its opener', () => {
    const list = [cmd(111, [0, 1, 0]), cmd(0, [], 1), cmd(412, [], 1), cmd(0)];
    const messages = blockStructureWarnings(list, 'p').map((w) => w.message);
    expect(messages.some((m) => /412.*no matching.*indent 1/.test(m))).toBe(true);
    expect(messages.some((m) => /never closed by 412/.test(m))).toBe(true);
  });

  it('flags a When [choice] row outside any Show Choices block', () => {
    const warnings = blockStructureWarnings([cmd(402, [0, 'Yes']), cmd(0)], 'p');
    expect(warnings[0].message).toMatch(/When \[choice\] \(402\) has no matching/);
  });

  it('flags a second Else on one Conditional Branch', () => {
    const list = [
      cmd(111, [0, 1, 0]),
      cmd(0, [], 1),
      cmd(411),
      cmd(0, [], 1),
      cmd(411),
      cmd(0, [], 1),
      cmd(412),
      cmd(0),
    ];
    const warnings = blockStructureWarnings(list, 'p');
    expect(errors(warnings)).toHaveLength(1);
    expect(warnings[0].message).toMatch(/has 2 Else \(411\) rows/);
  });
});

describe('blockStructureWarnings — choice branches vs. choices', () => {
  it('flags a choice with no When branch', () => {
    const list = [
      cmd(102, [['Yes', 'No'], -1, 0, 2, 0]),
      cmd(402, [0, 'Yes']),
      cmd(0, [], 1),
      cmd(404),
      cmd(0),
    ];
    const warnings = blockStructureWarnings(list, 'p');
    expect(errors(warnings)).toHaveLength(1);
    expect(warnings[0].message).toMatch(/no When branch for choice 1/);
  });

  it('flags When branches whose indices are out of order', () => {
    const list = [
      cmd(102, [['Yes', 'No'], -1, 0, 2, 0]),
      cmd(402, [1, 'No']),
      cmd(0, [], 1),
      cmd(402, [0, 'Yes']),
      cmd(0, [], 1),
      cmd(404),
      cmd(0),
    ];
    const warnings = blockStructureWarnings(list, 'p');
    expect(errors(warnings)).toHaveLength(1);
    expect(warnings[0].message).toMatch(/do not match choices 0\.\.1 in order/);
  });

  it('flags an extra When branch beyond the choice list', () => {
    const list = [
      cmd(102, [['Yes'], -1, 0, 2, 0]),
      cmd(402, [0, 'Yes']),
      cmd(0, [], 1),
      cmd(402, [1, 'Ghost']),
      cmd(0, [], 1),
      cmd(404),
      cmd(0),
    ];
    expect(errors(blockStructureWarnings(list, 'p'))).toHaveLength(1);
  });

  it('reports an unreachable cancel branch as advisory, not an error', () => {
    // cancelType -1 (Disallow) with a When Cancel branch present: never runs.
    const list = [
      cmd(102, [['Yes'], -1, 0, 2, 0]),
      cmd(402, [0, 'Yes']),
      cmd(0, [], 1),
      cmd(403),
      cmd(0, [], 1),
      cmd(404),
      cmd(0),
    ];
    const warnings = blockStructureWarnings(list, 'p');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe('warning');
    expect(warnings[0].message).toMatch(/dead code/);
  });

  it('reports cancel routed to a missing branch as advisory', () => {
    const list = [
      cmd(102, [['Yes'], 1, 0, 2, 0]), // cancelType 1 === choices.length → branch
      cmd(402, [0, 'Yes']),
      cmd(0, [], 1),
      cmd(404),
      cmd(0),
    ];
    const warnings = blockStructureWarnings(list, 'p');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe('warning');
    expect(warnings[0].message).toMatch(/no When Cancel \(403\) branch/);
  });

  it('flags more than one When Cancel row', () => {
    const list = [
      cmd(102, [['Yes'], 1, 0, 2, 0]),
      cmd(402, [0, 'Yes']),
      cmd(0, [], 1),
      cmd(403),
      cmd(0, [], 1),
      cmd(403),
      cmd(0, [], 1),
      cmd(404),
      cmd(0),
    ];
    const warnings = blockStructureWarnings(list, 'p');
    expect(errors(warnings)).toHaveLength(1);
    expect(warnings[0].message).toMatch(/more than one When Cancel/);
  });
});

describe('blockStructureWarnings — non-block lists', () => {
  it('returns nothing for a list with no blocks at all', () => {
    expect(blockStructureWarnings(page(showText(['Hello.'])), 'p')).toEqual([]);
  });

  it('ignores malformed rows rather than throwing', () => {
    const list = [{ indent: 0 } as unknown as EventCommand, cmd(0)];
    expect(blockStructureWarnings(list, 'p')).toEqual([]);
  });
});
