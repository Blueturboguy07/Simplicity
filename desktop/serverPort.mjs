/* One server port per install, kept across launches.
 *
 * The window loads http://127.0.0.1:<port>, and the browser scopes
 * localStorage to that origin. The renderer keeps the chat model, the
 * embedding model and the user's settings in localStorage. When each launch
 * took a new random port, each launch started with an empty localStorage:
 * the user's model choice was lost, and the embedding default fell to a model
 * that crashed the server (scratchpad/bugfix/simplicity-smoke/NOTES.md).
 *
 * So the first launch picks a free port and saves it in the app data folder;
 * later launches (and health-watch restarts) reuse it while it is free. If
 * another program holds it, we pick a new one and save that instead.
 *
 * No Electron import here, so the logic runs under plain node in tests.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const PORT_FILE = 'server-port.json';
const HOST = '127.0.0.1';

export function readSavedPort(dir) {
  try {
    const { port } = JSON.parse(fs.readFileSync(path.join(dir, PORT_FILE), 'utf8'));
    return Number.isInteger(port) && port > 1024 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

export function savePort(dir, port) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PORT_FILE), JSON.stringify({ port }));
  } catch {
    /* not fatal: the next launch picks a port again */
  }
}

export function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, HOST, () => srv.close(() => resolve(true)));
  });
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/* The saved port may still be held for a moment by the server we just
   stopped (health-watch restart), so wait for it briefly before giving up. */
export async function pickServerPort(dir, { attempts = 10, waitMs = 300 } = {}) {
  const saved = readSavedPort(dir);
  if (saved) {
    for (let i = 0; i < attempts; i++) {
      if (await isPortFree(saved)) return saved;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  const port = await freePort();
  savePort(dir, port);
  return port;
}
