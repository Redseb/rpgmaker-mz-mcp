import { dirname, join } from 'path';
import { EngineSession, openSession } from './session.js';
import { resolvePngPath, safeName, stamp } from './output.js';
import { checkSteps, DIRECTION_CODE, LoadStep, PlaytestStep } from './steps.js';

/**
 * `run_playtest`: execute a scripted play session headless and report what
 * happened step by step — the text the game showed, where the player ended up,
 * battle outcomes, screenshots — plus every console/page/HTTP problem.
 */

export interface StepResult {
  index: number;
  action: PlaytestStep['action'];
  ok: boolean;
  [detail: string]: unknown;
}

export interface PlaytestResult {
  ok: boolean;
  /** Index of the step that failed, when one did. Later steps were not run. */
  failedStep?: number;
  error?: string;
  steps: StepResult[];
  screenshots: string[];
  /** Where the game stood after the last step that ran. */
  finalState?: unknown;
  problems: string[];
}

interface TextLog {
  lines: string[];
  choices: string[] | null;
}

type StepFn<S extends PlaytestStep> = (
  s: EngineSession,
  step: S,
  ctx: { index: number; outDir: string; runId: string; screenshots: string[] },
) => Promise<Record<string, unknown>>;

const doLoad: StepFn<LoadStep> = async (s, step) => {
  // Calling setupNewGame under a live Scene_Map nulls the tileset beneath the
  // spriteset — go back to the title first.
  await s.call('leaveMap');
  await s.waitFor('the title screen', 'idleOffMap');
  await s.call('load', {
    ...step,
    direction: step.direction ? DIRECTION_CODE[step.direction] : 2,
  });
  await s.waitFor(`map ${step.mapId} to load`, 'mapReady');
  return { state: await s.call('state') };
};

/**
 * Refuse to start something while an event/message is still running — the
 * engine would silently queue it behind the running event (a new battle scene
 * never opens while a message window is up), and the step would time out with
 * no clue why. Typically a map's autorun cutscene is still going after `load`.
 */
async function assertIdle(s: EngineSession, what: string): Promise<void> {
  if (await s.call<boolean>('busy')) {
    const text = await s.call<TextLog>('peekText');
    const last = text.lines.slice(-2).join(' / ');
    throw new Error(
      `Can't ${what}: an event or message is still running${last ? ` (last text: "${last}")` : ''}. ` +
        'Add an advanceText step first (a map autorun event may be playing after load).',
    );
  }
}

async function advanceText(s: EngineSession, maxMs: number): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  let stoppedAt: 'idle' | 'choice' | 'battle' | 'title' | 'timeout' = 'timeout';
  while (Date.now() - t0 < maxMs) {
    if (await s.call<boolean>('choiceOpen')) {
      stoppedAt = 'choice';
      break;
    }
    const scene = await s.call<string>('sceneName');
    if (scene === 'Scene_Battle') {
      stoppedAt = 'battle';
      break;
    }
    if (scene === 'Scene_Title' || scene === 'Scene_Gameover') {
      stoppedAt = 'title';
      break;
    }
    if (!(await s.call<boolean>('busy'))) {
      // One more look after a beat: an event may be between commands.
      await s.page.waitForTimeout(250);
      if (!(await s.call<boolean>('busy'))) {
        stoppedAt = 'idle';
        break;
      }
    }
    await s.press('ok');
    await s.page.waitForTimeout(90);
  }
  const text = await s.call<TextLog>('takeText');
  return { stoppedAt, lines: text.lines, ...(text.choices ? { choices: text.choices } : {}) };
}

async function choose(s: EngineSession, index: number): Promise<Record<string, unknown>> {
  await s.waitFor('a choice list to open', 'choiceOpen', [], 10000);
  const count = await s.call<number>('choiceCount');
  if (index >= count) throw new Error(`Choice ${index} is out of range — the list has ${count}.`);
  await s.call('selectChoice', index);
  await s.page.waitForTimeout(60);
  await s.press('ok');
  await s.page.waitForTimeout(150);
  return { chosen: index };
}

interface Pos {
  mapId: number;
  x: number;
  y: number;
  moving: boolean;
}

/**
 * Walk tile by tile: hold the direction until the player leaves the tile (or a
 * timeout says it's blocked), then release and let the move finish. Reports
 * where it stopped and how many steps were blocked — the invisible-wall check.
 */
async function walk(
  s: EngineSession,
  dir: keyof typeof DIRECTION_CODE,
  steps: number,
): Promise<Record<string, unknown>> {
  const start = await s.call<Pos>('playerPos');
  let walked = 0;
  let blockedAt: { x: number; y: number } | undefined;
  for (let i = 0; i < steps; i++) {
    const before = await s.call<Pos>('playerPos');
    await s.page.evaluate(`Input._currentState[${JSON.stringify(dir)}] = true`);
    let moved = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 600) {
      const p = await s.call<Pos>('playerPos');
      if (p.moving || p.x !== before.x || p.y !== before.y || p.mapId !== before.mapId) {
        moved = true;
        break;
      }
      await s.page.waitForTimeout(30);
    }
    await s.page.evaluate(`Input._currentState[${JSON.stringify(dir)}] = false`);
    if (!moved) {
      blockedAt = { x: before.x, y: before.y };
      break;
    }
    // Let the step (and any touch-triggered transfer/event) settle.
    const t1 = Date.now();
    while (Date.now() - t1 < 2000) {
      const p = await s.call<Pos>('playerPos');
      if (!p.moving) break;
      await s.page.waitForTimeout(30);
    }
    walked++;
    if (await s.call<boolean>('busy')) break; // an event fired — stop and let the script handle it
  }
  const end = await s.call<Pos>('playerPos');
  return {
    requested: steps,
    walked,
    from: { mapId: start.mapId, x: start.x, y: start.y },
    to: { mapId: end.mapId, x: end.x, y: end.y },
    ...(blockedAt ? { blockedAt } : {}),
    ...((await s.call<boolean>('busy')) ? { eventRunning: true } : {}),
  };
}

async function autoBattle(
  s: EngineSession,
  step: Extract<PlaytestStep, { action: 'autoBattle' }>,
): Promise<Record<string, unknown>> {
  if (step.troopId !== undefined) {
    await assertIdle(s, 'start a battle');
    await s.call('startBattle', step.troopId, step.canEscape ?? false, step.canLose ?? false);
  }
  await s.waitFor('a battle to start', 'sceneIs', ['Scene_Battle'], 15000);
  await s.call('setAutoBattle');
  const t0 = Date.now();
  let last: unknown;
  let ended = false;
  while (Date.now() - t0 < (step.maxMs ?? 120000)) {
    if ((await s.call<string>('sceneName')) !== 'Scene_Battle') {
      ended = true;
      break;
    }
    last = await s.call('battleSnapshot');
    await s.press('ok');
    await s.page.waitForTimeout(200);
  }
  if (!ended) throw new Error(`Battle still running after ${step.maxMs ?? 120000}ms.`);
  // Let the victory/defeat transition settle before reading the result.
  await s.page.waitForTimeout(300);
  return {
    outcome: await s.call('battleOutcome'),
    final: await s.call('battleSnapshot'),
    turnsSeen: (last as { turn?: number } | undefined)?.turn ?? 0,
    scene: await s.call('sceneName'),
  };
}

async function runStep(
  s: EngineSession,
  step: PlaytestStep,
  ctx: { index: number; outDir: string; runId: string; screenshots: string[] },
): Promise<Record<string, unknown>> {
  switch (step.action) {
    case 'load':
      return doLoad(s, step, ctx);
    case 'startEvent':
      await assertIdle(s, `start event ${step.eventId}`);
      return { event: await s.call('startEvent', step.eventId) };
    case 'advanceText':
      return advanceText(s, step.maxMs ?? 15000);
    case 'choose':
      return choose(s, step.index);
    case 'walk':
      return walk(s, step.direction, step.steps ?? 1);
    case 'press':
      for (let i = 0; i < (step.times ?? 1); i++) await s.press(step.button);
      return {};
    case 'wait':
      await s.page.waitForTimeout(step.ms);
      return {};
    case 'autoBattle':
      return autoBattle(s, step);
    case 'screenshot': {
      const name = safeName(step.name ?? `step${ctx.index}`);
      const path = join(ctx.outDir, `${ctx.runId}_${name}.png`);
      await s.page.screenshot({ path });
      ctx.screenshots.push(path);
      return { path };
    }
    case 'eval': {
      const value = await s.page.evaluate(step.script);
      return { value: value === undefined ? null : value };
    }
  }
}

export async function runPlaytest(
  projectPath: string,
  steps: PlaytestStep[],
  opts: { out?: string } = {},
): Promise<PlaytestResult> {
  const preflight = checkSteps(steps);
  if (preflight.length) throw new Error(`Invalid playtest script: ${preflight.join(' ')}`);

  const runId = `playtest_${stamp()}`;
  // resolvePngPath creates the directory; screenshots go next to its file name.
  const outDir = dirname(await resolvePngPath(opts.out, `${runId}.png`));
  const screenshots: string[] = [];
  const results: StepResult[] = [];

  const session = await openSession(projectPath);
  try {
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      try {
        const detail = await runStep(session, step, { index, outDir, runId, screenshots });
        results.push({ index, action: step.action, ok: true, ...detail });
      } catch (e) {
        const error = e instanceof Error ? e.message.split('\n')[0] : String(e);
        results.push({ index, action: step.action, ok: false, error });
        return {
          ok: false,
          failedStep: index,
          error,
          steps: results,
          screenshots,
          finalState: await session.call('state').catch(() => undefined),
          problems: [...session.problems],
        };
      }
    }
    return {
      ok: true,
      steps: results,
      screenshots,
      finalState: await session.call('state'),
      problems: [...session.problems],
    };
  } finally {
    await session.close();
  }
}
