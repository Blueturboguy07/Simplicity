/* Ollama lifecycle manager — the "just works" free engine.
 *
 * A non-technical user should never install or start Ollama by hand. When they
 * pick a local model in onboarding, the server provisions it:
 *   1. find an existing `ollama` binary, else download the official standalone
 *      build into the app's data dir
 *   2. start `ollama serve` if nothing is already answering on the port
 *   3. pull the chosen chat model plus the embedding model, streaming progress
 *
 * This runs inside Vane's own Next server rather than the Electron shell — the
 * server is already a full Node process, so the browser can drive the whole
 * flow over a normal API route with no IPC layer in between.
 */

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const HOST = '127.0.0.1';
const PORT = 11434;
export const OLLAMA_URL = `http://${HOST}:${PORT}`;

export const EMBED_MODEL = 'nomic-embed-text';

/* The chat models we offer, smallest first. Sizes are the download, which is
   the number the user actually waits on — and the reason we ask rather than
   silently pulling nine gigabytes. */
export const MODEL_TIERS = [
  {
    key: 'fast',
    model: 'qwen2.5:3b',
    label: 'Fast',
    size: '~2 GB',
    blurb: 'Quickest to download and run. Good for everyday search.',
  },
  {
    key: 'balanced',
    model: 'qwen2.5:7b',
    label: 'Balanced',
    size: '~4.7 GB',
    blurb: 'Noticeably better answers. The best default on most machines.',
  },
  {
    key: 'quality',
    model: 'qwen2.5:14b',
    label: 'Best quality',
    size: '~9 GB',
    blurb: 'Strongest answers. Wants 16 GB of memory or more.',
  },
] as const;

export type Progress = {
  phase: 'installing' | 'starting' | 'pulling' | 'ready' | 'error';
  message: string;
  percent?: number;
};

const binDir = () => path.join(process.env.DATA_DIR || process.cwd(), 'bin');

/* The official standalone macOS archive: the `ollama` binary plus its runtime
   libraries. We extract the whole thing so the binary finds its libs. */
const DARWIN_TGZ =
  'https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz';

/* Locate an ollama binary: PATH first (Homebrew / official installer), then our
   own downloaded copy. A packaged app gets a minimal PATH, so the well-known
   install locations are checked explicitly rather than trusting `which`. */
async function findBinary(): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      process.platform === 'win32' ? 'where' : 'which',
      ['ollama'],
    );
    const p = stdout.split('\n')[0].trim();
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* not on PATH */
  }

  const candidates =
    process.platform === 'win32'
      ? [
          path.join(binDir(), 'ollama.exe'),
          /* The official Windows installer is a per-user install under
             LOCALAPPDATA; a system-wide install under Program Files also
             happens (e.g. via winget), so both are worth checking. */
          `${process.env.LOCALAPPDATA}\\Programs\\Ollama\\ollama.exe`,
          `${process.env.ProgramFiles}\\Ollama\\ollama.exe`,
        ]
      : [
          path.join(binDir(), 'ollama'),
          '/usr/local/bin/ollama',
          '/opt/homebrew/bin/ollama',
          `${process.env.HOME}/.local/bin/ollama`,
          '/Applications/Ollama.app/Contents/Resources/ollama',
        ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

async function downloadBinary(onLog: (m: string) => void): Promise<string> {
  const dir = binDir();
  fs.mkdirSync(dir, { recursive: true });

  if (process.platform !== 'darwin') {
    /* Real gap, not a bug to paper over: we only know how to unpack the
       macOS build here (see DARWIN_TGZ below). The button above this error
       is always labeled "Install" — never "Connect" — so the message has to
       say to click that, or a careful reader ends up looking for a control
       that doesn't exist. Once Ollama is on this machine, findBinary() above
       picks it up on the very next call, so re-clicking Install is genuinely
       enough to finish setup — this isn't a dead end. */
    throw new Error(
      "Automatic download isn't available on this platform yet. Install Ollama yourself from https://ollama.com/download, then click Install again — Simplicity will detect it and finish setup from there.",
    );
  }

  onLog('Downloading the local engine — a one-time download of about 150 MB.');
  const res = await fetch(DARWIN_TGZ, { headers: { 'user-agent': 'Simplicity' } });
  if (!res.ok) throw new Error(`Couldn't download Ollama (${res.status})`);

  const tgz = path.join(dir, 'ollama-darwin.tgz');
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));

  onLog('Unpacking the local engine…');
  /* Absolute path: a Finder-launched app may not resolve a bare `tar`. */
  await execFileP('/usr/bin/tar', ['xzf', tgz, '-C', dir]);
  fs.rmSync(tgz, { force: true });

  const bin = path.join(dir, 'ollama');
  if (!fs.existsSync(bin)) {
    throw new Error("The download didn't contain the expected files. Try again.");
  }
  fs.chmodSync(bin, 0o755);
  return bin;
}

export async function isServing(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* Start `ollama serve` if nothing is already answering. An instance the user
   started themselves is just as good — we don't replace it. */
async function ensureServing(bin: string, onLog: (m: string) => void) {
  if (await isServing()) return;

  onLog('Starting the local engine…');
  const proc = spawn(bin, ['serve'], {
    env: { ...process.env, OLLAMA_HOST: `${HOST}:${PORT}` },
    stdio: 'ignore',
    detached: false,
  });
  proc.unref();

  const start = Date.now();
  while (Date.now() - start < 20_000) {
    if (await isServing()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("The local engine started but isn't responding.");
}

async function hasModel(name: string): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    const body = await res.json();
    return (body.models ?? []).some(
      (m: any) => m.name === name || m.name === `${name}:latest`,
    );
  } catch {
    return false;
  }
}

/* Pull a model, forwarding Ollama's streamed progress as a percentage. */
async function pullModel(
  name: string,
  onProgress: (percent: number | undefined, status: string) => void,
) {
  if (await hasModel(name)) {
    onProgress(100, 'already installed');
    return;
  }

  const res = await fetch(`${OLLAMA_URL}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`Couldn't download ${name} (${res.status})`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });

    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j.error) throw new Error(j.error);
      const percent = j.total
        ? Math.round(((j.completed ?? 0) / j.total) * 100)
        : undefined;
      onProgress(percent, j.status ?? 'downloading');
    }
  }
}

/* Full provisioning. Idempotent — safe to call again; it no-ops on anything
   already present, so a retry after a failed download is cheap. */
export async function provision(
  chatModel: string,
  emit: (p: Progress) => void,
): Promise<{ url: string; chatModel: string; embedModel: string }> {
  let bin = await findBinary();

  if (!bin) {
    emit({ phase: 'installing', message: 'Setting up the local engine…' });
    bin = await downloadBinary((message) => emit({ phase: 'installing', message }));
  }

  emit({ phase: 'starting', message: 'Starting the local engine…' });
  await ensureServing(bin, (message) => emit({ phase: 'starting', message }));

  for (const model of [chatModel, EMBED_MODEL]) {
    emit({ phase: 'pulling', message: `Downloading ${model}…`, percent: 0 });
    await pullModel(model, (percent, status) =>
      emit({ phase: 'pulling', message: `${model}: ${status}`, percent }),
    );
  }

  emit({ phase: 'ready', message: 'Local AI is ready.' });
  return { url: OLLAMA_URL, chatModel, embedModel: EMBED_MODEL };
}

/* Report state without changing anything, so the UI can decide whether to
   offer "Install" or just "Connect". */
export async function status() {
  return { installed: !!(await findBinary()), serving: await isServing() };
}
