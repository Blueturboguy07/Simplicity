import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';

/* Regression coverage for the Ollama install state machine — the exact code
 * path behind the "click Install, it spins for a second, then reverts to
 * the button with no explanation" bug report.
 *
 * That bug had two causes, only one of which lives in this file:
 *   1. The UI never rendered a <Toaster/> during onboarding, so a rejected
 *      provision() promise had nowhere to surface (fixed in ProviderPicker
 *      and layout.tsx — not testable at this layer, there's no component
 *      test harness in this project).
 *   2. provision() must actually REJECT with a real, actionable message on
 *      failure rather than resolving or throwing something misleading. THAT
 *      is what these tests pin: the state machine's phases, its happy path,
 *      and the exact wording of its most common failure (no auto-download
 *      support outside macOS), which used to reference a "Connect" button
 *      that doesn't exist anywhere in the UI.
 *
 * child_process.execFile is promisified once, at module scope, in the file
 * under test — so the mock below has to carry a working
 * `[promisify.custom]` implementation, or `await execFileP(...)` resolves
 * with the wrong shape and every test relying on "found on PATH" breaks in
 * a way that has nothing to do with the behavior being tested.
 */

/* vi.mock(...) factories are hoisted above every import AND above ordinary
   top-level `const`s in this file — referencing those consts from inside a
   factory throws "Cannot access before initialization". vi.hoisted() is the
   documented escape hatch: it hoists right alongside the mock factories. */
const { execFileState, execFileMock, spawnMock, existsSyncState, fsMockObj } = vi.hoisted(
  () => {
    const execFileState: {
      impl: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
    } = {
      impl: async () => {
        throw Object.assign(new Error('not found'), { code: 1 });
      },
    };

    const execFileMock = vi.fn(
      (cmd: string, args: string[], cb: (err: any, stdout: string, stderr: string) => void) => {
        execFileState.impl(cmd, args).then(
          ({ stdout, stderr }) => cb(null, stdout, stderr),
          (err) => cb(err, '', ''),
        );
      },
    );

    const spawnMock = vi.fn(() => ({ unref: vi.fn(), on: vi.fn() }));

    const existsSyncState: { paths: Set<string> } = { paths: new Set() };
    const fsMockObj = {
      existsSync: vi.fn((p: string) => existsSyncState.paths.has(p)),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      chmodSync: vi.fn(),
      rmSync: vi.fn(),
    };

    return { execFileState, execFileMock, spawnMock, existsSyncState, fsMockObj };
  },
);

(execFileMock as any)[promisify.custom] = (cmd: string, args: string[]) =>
  execFileState.impl(cmd, args);

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: spawnMock,
}));

vi.mock('node:fs', () => ({
  default: fsMockObj,
  ...fsMockObj,
}));

import { OLLAMA_URL, provision, status } from './ollama';

const realPlatform = process.platform;
function setPlatform(platform: 'darwin' | 'win32') {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('Ollama install state machine', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execFileMock.mockClear();
    spawnMock.mockClear();
    fsMockObj.existsSync.mockClear();
    existsSyncState.paths = new Set();
    execFileState.impl = async () => {
      throw Object.assign(new Error('not found'), { code: 1 });
    };

    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/tags')) {
        return {
          ok: true,
          json: async () => ({
            models: [{ name: 'qwen2.5:7b' }, { name: 'nomic-embed-text' }],
          }),
        } as any;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    setPlatform(realPlatform as 'darwin' | 'win32');
    vi.unstubAllGlobals();
  });

  it('finds an already-installed binary on PATH and skips the download phase entirely', async () => {
    setPlatform('darwin');
    execFileState.impl = async () => ({ stdout: '/opt/homebrew/bin/ollama\n', stderr: '' });
    existsSyncState.paths.add('/opt/homebrew/bin/ollama');

    const phases: string[] = [];
    const result = await provision('qwen2.5:7b', (p) => phases.push(p.phase));

    expect(result).toEqual({
      url: OLLAMA_URL,
      chatModel: 'qwen2.5:7b',
      embedModel: 'nomic-embed-text',
    });
    // No 'installing' phase — a binary was already found, so provisioning
    // never touches the network for a download.
    expect(phases).not.toContain('installing');
    expect(phases).toContain('starting');
    // One 'pulling' emit per model at minimum (the chat model and the
    // embedding model) — provision() also emits a sub-progress update from
    // inside pullModel itself, so this is a floor, not an exact count.
    expect(phases.filter((p) => p === 'pulling').length).toBeGreaterThanOrEqual(2);
    expect(phases[phases.length - 1]).toBe('ready');
  });

  it('is idempotent: calling it twice in a row does not re-download or re-pull', async () => {
    setPlatform('darwin');
    execFileState.impl = async () => ({ stdout: '/opt/homebrew/bin/ollama\n', stderr: '' });
    existsSyncState.paths.add('/opt/homebrew/bin/ollama');

    await provision('qwen2.5:7b', () => {});
    await provision('qwen2.5:7b', () => {});

    // hasModel() reports both models already present on every call, so a
    // second provision() is all reads — no /api/pull, no re-download.
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/api/tags'))).toBe(
      true,
    );
  });

  it('rejects with a clear, actionable message when no binary exists on an unsupported auto-download platform — never silently resolves', async () => {
    setPlatform('win32');
    // Neither `where ollama` nor any well-known install path resolves.
    execFileState.impl = async () => {
      throw Object.assign(new Error('not found'), { code: 1 });
    };

    await expect(provision('qwen2.5:7b', () => {})).rejects.toThrow(
      /install ollama yourself.*ollama\.com\/download.*click install again/i,
    );
  });

  it('the unsupported-platform message never references a "Connect" control — the row only ever shows an Install button', async () => {
    setPlatform('win32');
    execFileState.impl = async () => {
      throw Object.assign(new Error('not found'), { code: 1 });
    };

    await expect(provision('qwen2.5:7b', () => {})).rejects.toSatisfy(
      (err: Error) => !/connect/i.test(err.message),
    );
  });

  it('status() reports installed:false, serving:false when nothing is found and nothing answers', async () => {
    setPlatform('darwin');
    execFileState.impl = async () => {
      throw Object.assign(new Error('not found'), { code: 1 });
    };
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });

    expect(await status()).toEqual({ installed: false, serving: false });
  });

  it('status() reports installed:true once a binary is found, independent of whether it is serving', async () => {
    setPlatform('darwin');
    execFileState.impl = async () => ({ stdout: '/opt/homebrew/bin/ollama\n', stderr: '' });
    existsSyncState.paths.add('/opt/homebrew/bin/ollama');
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });

    expect(await status()).toEqual({ installed: true, serving: false });
  });
});
