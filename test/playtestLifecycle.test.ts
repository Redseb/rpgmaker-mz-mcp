import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSession, stopHeadlessSessions } from '../src/playtest/session.js';
import { linkAbortSignals } from '../src/utils/abort.js';

const mocks = vi.hoisted(() => {
  const page = {
    on: vi.fn(),
    addInitScript: vi.fn(),
    evaluate: vi.fn(),
    waitForFunction: vi.fn(),
    waitForTimeout: vi.fn(),
    goto: vi.fn(),
  };
  const browser = { newPage: vi.fn(), close: vi.fn() };
  const server = { origin: 'http://127.0.0.1:1234', close: vi.fn() };
  return { page, browser, server, launch: vi.fn(), start: vi.fn() };
});

vi.mock('playwright-core', () => ({ chromium: { launch: mocks.launch } }));
vi.mock('../src/playtest/chromium.js', () => ({ findChromium: () => 'chromium' }));
vi.mock('../src/playtest/staticServer.js', () => ({ startStaticServer: mocks.start }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.start.mockResolvedValue(mocks.server);
  mocks.launch.mockResolvedValue(mocks.browser);
  mocks.browser.newPage.mockResolvedValue(mocks.page);
  mocks.browser.close.mockResolvedValue(undefined);
  mocks.server.close.mockResolvedValue(undefined);
  mocks.page.evaluate.mockResolvedValue('result');
});
afterEach(async () => {
  await stopHeadlessSessions();
});

describe('owned headless sessions', () => {
  it('closes its browser and server once, including repeated shutdown', async () => {
    const session = await openSession('/project');
    expect(await session.call('state')).toBe('result');
    await Promise.all([session.close(), session.close(), stopHeadlessSessions()]);
    expect(mocks.browser.close).toHaveBeenCalledTimes(1);
    expect(mocks.server.close).toHaveBeenCalledTimes(1);
  });

  it('cancels a never-resolving eval and closes resources', async () => {
    const controller = new AbortController();
    const session = await openSession('/project', { signal: controller.signal });
    mocks.page.evaluate.mockReturnValue(new Promise(() => undefined));
    const evaluation = expect(session.evaluate('new Promise(() => {})')).rejects.toThrow(
      'cancelled',
    );
    controller.abort();
    await evaluation;
    await session.close();
    expect(mocks.browser.close).toHaveBeenCalledTimes(1);
    expect(mocks.server.close).toHaveBeenCalledTimes(1);
  });

  it('shuts down all owned sessions even while polling never resolves', async () => {
    const session = await openSession('/project');
    mocks.page.waitForFunction.mockReturnValue(new Promise(() => undefined));
    const polling = expect(session.waitFor('map', 'mapReady')).rejects.toThrow('cancelled');
    await stopHeadlessSessions();
    await polling;
    expect(mocks.browser.close).toHaveBeenCalledTimes(1);
  });

  it('cancels only the requested session', async () => {
    const firstController = new AbortController();
    const first = await openSession('/first', { signal: firstController.signal });
    const second = await openSession('/second');
    firstController.abort();
    await first.close();
    expect(await second.evaluate('1 + 1')).toBe('result');
    expect(mocks.browser.close).toHaveBeenCalledTimes(1);
    await second.close();
    expect(mocks.browser.close).toHaveBeenCalledTimes(2);
  });

  it('closes a browser that finishes launching after cancellation', async () => {
    const launch = deferred<typeof mocks.browser>();
    mocks.launch.mockReturnValue(launch.promise);
    const controller = new AbortController();
    const opened = expect(openSession('/project', { signal: controller.signal })).rejects.toThrow(
      'cancelled',
    );
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalled());
    controller.abort();
    launch.resolve(mocks.browser);
    await opened;
    expect(mocks.browser.newPage).not.toHaveBeenCalled();
    expect(mocks.browser.close).toHaveBeenCalledTimes(1);
    expect(mocks.server.close).toHaveBeenCalledTimes(1);
  });

  it('closes a static server that finishes starting after cancellation', async () => {
    const start = deferred<typeof mocks.server>();
    mocks.start.mockReturnValue(start.promise);
    const controller = new AbortController();
    const opened = expect(openSession('/project', { signal: controller.signal })).rejects.toThrow(
      'cancelled',
    );
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled());
    controller.abort();
    start.resolve(mocks.server);
    await opened;
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.server.close).toHaveBeenCalledTimes(1);
  });

  it('cleans up after a failed boot', async () => {
    mocks.page.goto.mockRejectedValue(new Error('boot failed'));
    await expect(openSession('/project')).rejects.toThrow('boot failed');
    expect(mocks.browser.close).toHaveBeenCalledTimes(1);
    expect(mocks.server.close).toHaveBeenCalledTimes(1);
  });

  it('refuses an already cancelled call before starting resources', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(openSession('/project', { signal: controller.signal })).rejects.toThrow(
      'cancelled',
    );
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});

describe('combined request/server cancellation', () => {
  it('aborts on either source and removes listeners after a call', () => {
    const request = new AbortController();
    const shutdown = new AbortController();
    const linked = linkAbortSignals([request.signal, shutdown.signal]);
    shutdown.abort();
    expect(linked.signal.aborted).toBe(true);
    linked.dispose();
    const done = linkAbortSignals([request.signal, undefined]);
    done.dispose();
    request.abort();
    expect(done.signal.aborted).toBe(false);
  });

  it('preserves cancellation that arrived before linking', () => {
    const request = new AbortController();
    request.abort();
    const linked = linkAbortSignals([request.signal]);
    expect(linked.signal.aborted).toBe(true);
    linked.dispose();
  });
});
