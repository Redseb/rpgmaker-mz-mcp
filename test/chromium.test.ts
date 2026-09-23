import { describe, expect, it } from 'vitest';
import { join } from 'path';
import {
  CHROMIUM_ENV,
  ChromiumEnvironment,
  chromiumCandidates,
  findChromium,
  playwrightCacheRoots,
} from '../src/playtest/chromium.js';

function env(
  over: Partial<ChromiumEnvironment> & { dirs?: Record<string, string[]> } = {},
): ChromiumEnvironment {
  const dirs = over.dirs ?? {};
  return {
    platform: 'darwin',
    arch: 'arm64',
    home: '/home/u',
    env: {},
    listDir: (d) => {
      if (!(d in dirs)) throw new Error('ENOENT');
      return dirs[d];
    },
    ...over,
  };
}

const MAC_CACHE = join('/home/u', 'Library', 'Caches', 'ms-playwright');

describe('playwrightCacheRoots', () => {
  it('uses the per-platform default cache', () => {
    expect(playwrightCacheRoots(env())).toEqual([MAC_CACHE]);
    expect(playwrightCacheRoots(env({ platform: 'linux' }))).toEqual([
      join('/home/u', '.cache', 'ms-playwright'),
    ]);
    expect(
      playwrightCacheRoots(env({ platform: 'linux', env: { XDG_CACHE_HOME: '/xdg' } })),
    ).toEqual([join('/xdg', 'ms-playwright')]);
    expect(
      playwrightCacheRoots(env({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' } })),
    ).toEqual([join('C:\\L', 'ms-playwright')]);
  });

  it('puts PLAYWRIGHT_BROWSERS_PATH first, ignoring the "0" sentinel', () => {
    expect(playwrightCacheRoots(env({ env: { PLAYWRIGHT_BROWSERS_PATH: '/pw' } }))[0]).toBe('/pw');
    expect(playwrightCacheRoots(env({ env: { PLAYWRIGHT_BROWSERS_PATH: '0' } }))).toEqual([
      MAC_CACHE,
    ]);
  });
});

describe('chromiumCandidates', () => {
  it('prefers the newest headless shell, then full Chromium', () => {
    const e = env({
      dirs: {
        [MAC_CACHE]: [
          'chromium-1200',
          'chromium_headless_shell-1100',
          'chromium_headless_shell-1223',
          'ffmpeg-1011',
        ],
      },
    });
    const c = chromiumCandidates(e);
    expect(c[0]).toBe(
      join(
        MAC_CACHE,
        'chromium_headless_shell-1223',
        'chrome-headless-shell-mac-arm64',
        'chrome-headless-shell',
      ),
    );
    const firstOld = c.findIndex((p) => p.includes('chromium_headless_shell-1100'));
    const firstFull = c.findIndex((p) => p.includes('chromium-1200'));
    expect(firstOld).toBeGreaterThan(0);
    expect(firstFull).toBeGreaterThan(firstOld);
    expect(c.some((p) => p.includes('ffmpeg'))).toBe(false);
    expect(c.some((p) => p.endsWith('Google Chrome for Testing'))).toBe(true);
  });

  it('uses platform-specific executable layouts', () => {
    const linuxCache = join('/home/u', '.cache', 'ms-playwright');
    const linux = chromiumCandidates(
      env({
        platform: 'linux',
        arch: 'x64',
        dirs: { [linuxCache]: ['chromium_headless_shell-9'] },
      }),
    );
    expect(linux[0]).toBe(
      join(
        linuxCache,
        'chromium_headless_shell-9',
        'chrome-headless-shell-linux64',
        'chrome-headless-shell',
      ),
    );
    const winCache = join('C:\\L', 'ms-playwright');
    const win = chromiumCandidates(
      env({
        platform: 'win32',
        arch: 'x64',
        env: { LOCALAPPDATA: 'C:\\L' },
        dirs: { [winCache]: ['chromium_headless_shell-9'] },
      }),
    );
    expect(win[0].endsWith('chrome-headless-shell.exe')).toBe(true);
  });

  it('puts the env override first and tolerates a missing cache', () => {
    const c = chromiumCandidates(env({ env: { [CHROMIUM_ENV]: '/opt/chrome' } }));
    expect(c).toEqual(['/opt/chrome']);
  });
});

describe('findChromium', () => {
  it('returns the first existing candidate', () => {
    const e = env({
      dirs: { [MAC_CACHE]: ['chromium_headless_shell-2', 'chromium_headless_shell-1'] },
    });
    const old = join(
      MAC_CACHE,
      'chromium_headless_shell-1',
      'chrome-headless-shell-mac-arm64',
      'chrome-headless-shell',
    );
    expect(findChromium(e, (p) => p === old)).toBe(old);
  });

  it('throws a how-to-fix message when nothing is found', () => {
    expect(() => findChromium(env(), () => false)).toThrow(
      /playwright install chromium-headless-shell/,
    );
  });

  it('is loud about an env override that does not exist', () => {
    expect(() => findChromium(env({ env: { [CHROMIUM_ENV]: '/nope' } }), () => false)).toThrow(
      /RPGMAKER_MCP_CHROMIUM is set to "\/nope"/,
    );
  });
});
