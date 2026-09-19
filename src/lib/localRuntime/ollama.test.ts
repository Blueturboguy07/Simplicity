import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';
import nodePath from 'node:path';
import { Writable } from 'node:stream';

/* Regression coverage for the Ollama install state machine — the exact code
 * path behind the "click Install, it spins for a second, then reverts to
 * the button with no explanation" bug report, AND behind the separate
 * "you said it was free but i cant continue the app without an api key"
 * report (break ee8a15fb / cluster simplicity-free-tier-api-key-confusion-
 * mac-win): on Windows, downloadBinary() used to unconditionally refuse to
 * install ANYTHING — the "Free" row's only control led to a dead end on
 * every Windows machine, guide-installer or release build alike.
 *
 * Earlier causes, only one of which lives in this file:
 *   1. The UI never rendered a <Toaster/> during onboarding, so a rejected
 *      provision() promise had nowhere to surface (fixed in ProviderPicker
 *      and layout.tsx — not testable at this layer, there's no component
 *      test harness in this project).
 *   2. provision() must actually REJECT with a real, actionable message on
 *      failure rather than resolving or throwing something misleading. THAT
 *      is what these tests pin: the state machine's phases, its happy path,
 *      the Windows download+unpack path, and the exact wording of the
 *      failure that remains for a platform with no known archive at all
 *      (never referencing a "Connect" button that doesn't exist anywhere in
 *      the UI).
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
      /* The Windows branch streams the 1.4 GB archive to disk instead of
         buffering it; the sink is filled in inside beforeEach, where
         node:stream is importable. */
      createWriteStream: vi.fn(),
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
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('Ollama install state machine', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  /* Everything the code under test streamed into createWriteStream(), so a
     test can prove the archive really reached disk rather than the pipeline
     silently writing nothing. */
  const written: Buffer[] = [];

  beforeEach(() => {
    execFileMock.mockClear();
    spawnMock.mockClear();
    fsMockObj.existsSync.mockClear();
    existsSyncState.paths = new Set();
    written.length = 0;
    fsMockObj.createWriteStream.mockImplementation(
      () =>
        new Writable({
          write(chunk: Buffer, _enc: unknown, cb: () => void) {
            written.push(Buffer.from(chunk));
            cb();
          },
        }),
    );
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
    setPlatform(realPlatform);
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

  it('rejects with a clear, actionable message when no binary exists on a platform with no known archive at all — never silently resolves', async () => {
    // darwin and win32 both have a real download+unpack path (covered by
    // dedicated tests below); this exercises what's left — a platform this
    // app genuinely does not know how to fetch an archive for.
    setPlatform('linux');
    // Neither `which ollama` nor any well-known install path resolves.
    execFileState.impl = async () => {
      throw Object.assign(new Error('not found'), { code: 1 });
    };

    await expect(provision('qwen2.5:7b', () => {})).rejects.toThrow(
      /install ollama yourself.*ollama\.com\/download.*click install again/i,
    );
  });

  it('the unsupported-platform message never references a "Connect" control — the row only ever shows an Install button', async () => {
    setPlatform('linux');
    execFileState.impl = async () => {
      throw Object.assign(new Error('not found'), { code: 1 });
    };

    await expect(provision('qwen2.5:7b', () => {})).rejects.toSatisfy(
      (err: Error) => !/connect/i.test(err.message),
    );
  });

  it('on Windows, downloads and unpacks the official Windows package via tar when no binary exists — this is the free-tier/API-key-confusion bug (break ee8a15fb): the Install button used to always fail here', async () => {
    setPlatform('win32');

    // findBinary(): neither `where ollama` nor any well-known install path
    // resolves yet — a genuinely fresh machine. Once downloadBinary() has
    // "unpacked" (the tar.exe call below), the binary exists.
    execFileState.impl = async (cmd, args) => {
      if (/tar\.exe$/i.test(cmd)) {
        const dirArg = args[args.indexOf('-C') + 1];
        existsSyncState.paths.add(nodePath.join(dirArg, 'ollama.exe'));
        return { stdout: '', stderr: '' };
      }
      // `where ollama` and every candidate-path probe: not found.
      throw Object.assign(new Error('not found'), { code: 1 });
    };

    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('ollama-windows-amd64.zip')) {
        /* A body, not an arrayBuffer(): the Windows branch must stream. If it
           ever regresses to buffering the whole 1.4 GB archive in memory this
           mock has no arrayBuffer() to call and the test fails loudly. */
        return {
          ok: true,
          body: new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new Uint8Array(8));
              c.close();
            },
          }),
        } as any;
      }
      if (String(url).includes('/api/tags')) {
        // Both models already present -> pullModel() no-ops (no /api/pull
        // needed); this test is about the download+unpack path, not the
        // pull-streaming path, which the pre-existing darwin tests cover.
        return {
          ok: true,
          json: async () => ({
            models: [{ name: 'qwen2.5:7b' }, { name: 'nomic-embed-text' }],
          }),
        } as any;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const phases: string[] = [];
    const result = await provision('qwen2.5:7b', (p) => phases.push(p.phase));

    expect(result).toEqual({
      url: OLLAMA_URL,
      chatModel: 'qwen2.5:7b',
      embedModel: 'nomic-embed-text',
    });
    expect(phases).toContain('installing');
    expect(phases[phases.length - 1]).toBe('ready');

    // Fetched the Windows archive, not the darwin one.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('ollama-windows-amd64.zip')))
      .toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('ollama-darwin.tgz'))).toBe(
      false,
    );

    // Unpacked with tar (bsdtar ships on Windows since the 1803 update and
    // extracts .zip the same way it extracts .tgz), not a hardcoded
    // Unix-only tool.
    const tarCall = execFileMock.mock.calls.find(([cmd]) => /tar\.exe$/i.test(cmd));
    expect(tarCall).toBeTruthy();
    expect(tarCall![1]).toEqual(expect.arrayContaining(['xf']));

    // Streamed to disk (one chunk here), never buffered whole: a 1.4 GB
    // arrayBuffer() is the allocation that would fail on a small machine.
    expect(fsMockObj.createWriteStream).toHaveBeenCalledWith(
      nodePath.join(process.env.DATA_DIR || process.cwd(), 'bin', 'ollama-windows-amd64.zip'),
    );
    expect(Buffer.concat(written).length).toBe(8);
    expect(fsMockObj.writeFileSync).not.toHaveBeenCalled();
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
