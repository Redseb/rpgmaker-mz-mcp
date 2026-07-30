import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  DEFAULT_TEXT_METRICS,
  TextMetrics,
  displayText,
  getActiveTextMetrics,
  lineBudget,
  measureLine,
  parseTextMetrics,
  setActiveTextMetrics,
} from '../src/validation/textMetrics.js';
import { textLineWidthWarnings } from '../src/validation/eventCommands.js';
import {
  clearProjectConfigCache,
  loadProjectTextMetrics,
  PROJECT_CONFIG_FILE,
} from '../src/tools/projectConfig.js';
import { EventCommand } from '../src/utils/types.js';

/**
 * A deliberately lopsided fixture font: capitals are 2.7x the width of a full stop,
 * the same spread measured on a real 8-bit project. That spread is the whole reason
 * a character count cannot be made correct — it is what lets a 40-char line of
 * capitals overflow while a 55-char line of lowercase fits.
 */
const FONT: TextMetrics = {
  unit: 'px',
  budget: { noFace: 784, withFace: 616 },
  charWidths: { _default: 13, a: 11.38, '.': 4.88, ' ': 8.12 },
  nameBudgetChars: 8,
};

function text(lines: string[], face = ''): EventCommand[] {
  return [
    { code: 101, indent: 0, parameters: [face, 0, 0, 2, ''] },
    ...lines.map((l) => ({ code: 401, indent: 0, parameters: [l] })),
  ];
}

describe('parseTextMetrics', () => {
  it('reads a pixel budget with a width table', () => {
    const m = parseTextMetrics({
      text: {
        lineBudget: { noFace: 784, withFace: 616 },
        nameBudgetChars: 8,
        charWidths: { _default: 13, a: 11.38 },
      },
    });
    expect(m).toEqual({
      unit: 'px',
      budget: { noFace: 784, withFace: 616 },
      charWidths: { _default: 13, a: 11.38 },
      nameBudgetChars: 8,
    });
  });

  it('treats a budget with no width table as a character-count override', () => {
    const m = parseTextMetrics({ text: { lineBudget: { noFace: 60, withFace: 47 } } });
    expect(m?.unit).toBe('chars');
    expect(m?.budget).toEqual({ noFace: 60, withFace: 47 });
  });

  it('drops width keys that are not a single character or _default', () => {
    const m = parseTextMetrics({
      text: {
        lineBudget: { noFace: 10, withFace: 10 },
        charWidths: { _default: 1, a: 2, abc: 99, '': 5 },
      },
    });
    expect(m?.charWidths).toEqual({ _default: 1, a: 2 });
  });

  // Fail-soft is the point: a bad config must be no worse than no config, or the
  // feature reintroduces exactly the untrustworthy-warnings problem it exists to fix.
  it.each([
    ['not an object', 42],
    ['no text section', { other: {} }],
    ['no lineBudget', { text: {} }],
    ['non-numeric budget', { text: { lineBudget: { noFace: 'wide', withFace: 1 } } }],
    ['non-positive budget', { text: { lineBudget: { noFace: 0, withFace: 10 } } }],
    [
      'width table with no _default',
      { text: { lineBudget: { noFace: 10, withFace: 10 }, charWidths: { a: 1 } } },
    ],
  ])('returns null for %s', (_label, raw) => {
    expect(parseTextMetrics(raw)).toBeNull();
  });
});

describe('measureLine', () => {
  it('sums per-character advances in pixel mode', () => {
    // 'a' 11.38 + '.' 4.88 = 16.26
    expect(measureLine('a.', FONT)).toBeCloseTo(16.26, 5);
  });

  it('bills unlisted characters at _default', () => {
    expect(measureLine('QQ', FONT)).toBe(26);
  });

  it('counts characters in chars mode', () => {
    expect(measureLine('abcde', DEFAULT_TEXT_METRICS)).toBe(5);
  });

  it('budgets a name escape at nameBudgetChars of _default width, not the default name', () => {
    // \N[1] renders as a player-typed name, so it must cost 8 * 13, not 0.
    expect(measureLine('\\N[1]', FONT)).toBe(8 * 13);
  });

  it('still bills real spaces at their own width, not the name placeholder width', () => {
    // Regression: an early version substituted spaces for the name escape and then
    // billed every space at _default, silently over-measuring ordinary prose.
    expect(measureLine('a a', FONT)).toBeCloseTo(11.38 + 8.12 + 11.38, 5);
  });

  it('ignores escapes that draw nothing', () => {
    expect(measureLine('\\C[3]a\\.', FONT)).toBeCloseTo(11.38, 5);
    expect(displayText('\\C[3]a', FONT)).toBe('a');
  });

  it('keeps the historical behaviour of ignoring names when nameBudgetChars is 0', () => {
    expect(measureLine('\\N[1]', DEFAULT_TEXT_METRICS)).toBe(0);
  });
});

describe('lineBudget', () => {
  it('shrinks when a face is shown', () => {
    expect(lineBudget(FONT, false)).toBe(784);
    expect(lineBudget(FONT, true)).toBe(616);
  });
});

describe('textLineWidthWarnings', () => {
  it('uses the character estimate by default, unchanged from before', () => {
    const long = 'x'.repeat(56);
    const warnings = textLineWidthWarnings(text([long]), 'p', DEFAULT_TEXT_METRICS);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('56 visible chars');
    expect(warnings[0].message).toContain('~55');
    expect(warnings[0].severity).toBe('warning');
  });

  it('is quiet on a long-but-narrow line that the character estimate would flag', () => {
    // 55 lowercase 'a' = 626px, well inside the 784px no-face budget, but over the
    // 55-char default limit at 56 chars. This is the retro-rpg false positive.
    const line = 'a'.repeat(56);
    expect(textLineWidthWarnings(text([line]), 'p', DEFAULT_TEXT_METRICS)).toHaveLength(1);
    expect(textLineWidthWarnings(text([line]), 'p', FONT)).toHaveLength(0);
  });

  it('reports the overflow in pixels, naming the real budget', () => {
    const line = 'M'.repeat(50); // 650px against the 616px with-face budget
    const warnings = textLineWidthWarnings(text([line], 'Face'), 'p', FONT);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('650px');
    expect(warnings[0].message).toContain('616px with a face shown');
    // No '~': a measured budget is exact, and the message should not hedge.
    expect(warnings[0].message).not.toContain('~');
  });

  it('catches a short-but-wide line that the character estimate misses', () => {
    // The under-warning direction needs a font WIDER than the default assumes: 30
    // chars is inside the 38-char face limit, but at 24px each that is 720px against
    // a 616px window. A narrow font like FONT can only ever make the default
    // over-warn; a large one makes it stay silent on a genuine overflow.
    const wide: TextMetrics = {
      unit: 'px',
      budget: { noFace: 784, withFace: 616 },
      charWidths: { _default: 24 },
      nameBudgetChars: 0,
    };
    const line = 'M'.repeat(30);
    expect(textLineWidthWarnings(text([line], 'Face'), 'p', DEFAULT_TEXT_METRICS)).toHaveLength(0);
    expect(textLineWidthWarnings(text([line], 'Face'), 'p', wide)).toHaveLength(1);
  });

  it('applies the face budget only after a 101 that carries a face', () => {
    const line = 'M'.repeat(50); // 650px: over 616 with a face, under 784 without
    expect(textLineWidthWarnings(text([line]), 'p', FONT)).toHaveLength(0);
    expect(textLineWidthWarnings(text([line], 'Face'), 'p', FONT)).toHaveLength(1);
  });

  it('falls back to the ambient metrics when none are passed', () => {
    const line = 'a'.repeat(56);
    expect(textLineWidthWarnings(text([line]), 'p')).toHaveLength(1);
    setActiveTextMetrics(FONT);
    try {
      expect(getActiveTextMetrics()).toBe(FONT);
      expect(textLineWidthWarnings(text([line]), 'p')).toHaveLength(0);
    } finally {
      setActiveTextMetrics(null);
    }
    expect(getActiveTextMetrics()).toBe(DEFAULT_TEXT_METRICS);
  });
});

describe('loadProjectTextMetrics', () => {
  let dir: string;

  beforeEach(async () => {
    clearProjectConfigCache();
    dir = await mkdtemp(join(tmpdir(), 'rpgmz-cfg-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    setActiveTextMetrics(null);
  });

  it('returns null when the project has no config file', async () => {
    expect(await loadProjectTextMetrics(dir)).toBeNull();
  });

  it('reads a config file', async () => {
    await writeFile(
      join(dir, PROJECT_CONFIG_FILE),
      JSON.stringify({
        text: { lineBudget: { noFace: 784, withFace: 616 }, charWidths: { _default: 13 } },
      }),
    );
    const m = await loadProjectTextMetrics(dir);
    expect(m?.unit).toBe('px');
    expect(m?.budget.withFace).toBe(616);
  });

  it('fails soft on unparseable JSON rather than throwing', async () => {
    await writeFile(join(dir, PROJECT_CONFIG_FILE), '{ not json');
    expect(await loadProjectTextMetrics(dir)).toBeNull();
  });

  it('fails soft on a malformed text section', async () => {
    await writeFile(join(dir, PROJECT_CONFIG_FILE), JSON.stringify({ text: { lineBudget: {} } }));
    expect(await loadProjectTextMetrics(dir)).toBeNull();
  });

  it('re-reads after the file changes', async () => {
    const file = join(dir, PROJECT_CONFIG_FILE);
    await writeFile(
      file,
      JSON.stringify({ text: { lineBudget: { noFace: 100, withFace: 50 } } }),
    );
    expect((await loadProjectTextMetrics(dir))?.budget.noFace).toBe(100);

    // mtime has 1ms resolution on some filesystems; make the change unambiguous.
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(
      file,
      JSON.stringify({ text: { lineBudget: { noFace: 200, withFace: 50 } } }),
    );
    expect((await loadProjectTextMetrics(dir))?.budget.noFace).toBe(200);
  });

  it('returns null for an empty project path', async () => {
    expect(await loadProjectTextMetrics('')).toBeNull();
  });
});
