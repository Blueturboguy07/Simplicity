import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  PORT_FILE,
  isPortFree,
  pickServerPort,
  readSavedPort,
} from './serverPort.mjs';

const dirs = [];
const servers = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'simplicity-port-'));
  dirs.push(d);
  return d;
};
const hold = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer();
    servers.push(srv);
    srv.listen(port, '127.0.0.1', () => resolve(srv.address().port));
  });

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('pickServerPort', () => {
  it('first launch picks a free port and saves it', async () => {
    const dir = tmp();
    const port = await pickServerPort(dir);
    expect(port).toBeGreaterThan(1024);
    expect(readSavedPort(dir)).toBe(port);
    expect(await isPortFree(port)).toBe(true);
  });

  it('the next launch reuses the same port, so the window origin and its localStorage stay the same', async () => {
    const dir = tmp();
    const first = await pickServerPort(dir);
    const second = await pickServerPort(dir);
    const third = await pickServerPort(dir);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('waits for the old server to let go of the port (health-watch restart)', async () => {
    const dir = tmp();
    const port = await pickServerPort(dir);
    const srv = net.createServer();
    await new Promise((r) => srv.listen(port, '127.0.0.1', r));
    setTimeout(() => srv.close(), 250);
    expect(await pickServerPort(dir, { attempts: 10, waitMs: 100 })).toBe(port);
  });

  it('picks and saves a new port when another program keeps the saved one', async () => {
    const dir = tmp();
    const taken = await hold(0);
    fs.writeFileSync(path.join(dir, PORT_FILE), JSON.stringify({ port: taken }));

    const port = await pickServerPort(dir, { attempts: 2, waitMs: 10 });
    expect(port).not.toBe(taken);
    expect(readSavedPort(dir)).toBe(port);
  });

  it('ignores a damaged port file', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, PORT_FILE), '{not json');
    expect(readSavedPort(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, PORT_FILE), JSON.stringify({ port: 80 }));
    expect(readSavedPort(dir)).toBeNull();
    const port = await pickServerPort(dir);
    expect(readSavedPort(dir)).toBe(port);
  });
});
