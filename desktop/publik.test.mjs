// The gate of publik.mjs (ensureSignedIn) against a fake publik on 127.0.0.1: after sign-in the app
// opens at once. There is no pay screen at start: with no stored choice the gate stores "publik" by
// itself; a stored choice stays as it is. The app offers a plan when publik answers 402 (chat error
// card and banner, src/app/api/chat/route.ts and src/components/Publik/PublikBanner.tsx).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ENV_KEYS = [
  'PUBLIK_ORIGIN',
  'PUBLIK_APP_TOKEN',
  'PUBLIK_API_KEY',
  'PUBLIK_SELF_TEST',
  'DO_NOT_TRACK',
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const fake = {
  claimed: false,
  plan: { kind: 'none', label: null },
  balance: 0,
};
let server;
let origin;
let home;
let publik;

const wallet = () => ({
  claim_state: fake.claimed ? 'claimed' : 'anonymous',
  claim_url: `${origin}/claim`,
  top_up_url: `${origin}/wallet`,
  account: fake.claimed ? { handle: 'tester' } : null,
  plan: fake.plan,
  balance_micros: fake.balance,
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    req.resume();
    if (req.method === 'POST' && req.url === '/api/v1/installs') {
      return send(201, {
        key: 'pk_test_new',
        base_url: `${origin}/api/v1`,
        install_id: 'install-1',
        claim_url: `${origin}/claim`,
      });
    }
    if (req.method === 'GET' && req.url === '/api/v1/wallet') {
      return send(200, wallet());
    }
    return send(404, { error: { message: 'not found' } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;

  home = fs.mkdtempSync(path.join(os.tmpdir(), 'simplicity-gate-'));
  process.env.PUBLIK_ORIGIN = origin; // read once, when publik.mjs loads
  process.env.PUBLIK_APP_TOKEN = 'pat_test';
  process.env.DO_NOT_TRACK = '1'; // no usage events from a test
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LOCALAPPDATA = home;
  process.env.XDG_CONFIG_HOME = home;
  delete process.env.PUBLIK_API_KEY;
  delete process.env.PUBLIK_SELF_TEST;
  publik = await import('./publik.mjs');
  // Never touch the real publik folder of the computer that runs the tests.
  if (!publik.credentialPath().startsWith(home)) {
    throw new Error(
      `the credential path is outside the test folder: ${publik.credentialPath()}`,
    );
  }
});

afterEach(() => {
  const dir = path.dirname(path.dirname(publik.credentialPath()));
  if (dir.startsWith(home)) fs.rmSync(dir, { recursive: true, force: true });
  fake.claimed = false;
  fake.plan = { kind: 'none', label: null };
  fake.balance = 0;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(home, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/* A GateUI that records each screen. On Sign in with publik it presses the
   button, and the browser sign-in (openUrl) claims the install. Any other
   screen answers "own_key", so a pay screen would show up in `shown` and in
   the stored choice. */
const recordingUI = () => {
  const ui = {
    shown: [],
    opened: [],
    async show(screen) {
      ui.shown.push(screen.id);
      return screen.id === 'sign_in' ? 'sign_in' : 'own_key';
    },
    openUrl(url) {
      ui.opened.push(url);
      fake.claimed = true;
    },
  };
  return ui;
};

const storeCredential = (choice) => {
  const file = publik.credentialPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const c = {
    key: 'pk_test_stored',
    base_url: `${origin}/api/v1`,
    install_id: 'install-0',
    claim_url: `${origin}/claim`,
  };
  fs.writeFileSync(
    file,
    JSON.stringify(choice === undefined ? c : { ...c, choice }),
  );
};
const storedChoice = () => publik.readCredential()?.choice;

describe('ensureSignedIn: no pay screen at start', () => {
  it('sign-in, then straight in: only the Sign in with publik screen, then the choice "publik"', async () => {
    const ui = recordingUI();
    const gate = await publik.ensureSignedIn(ui);
    expect(ui.shown).toEqual(['sign_in']);
    expect(ui.opened).toEqual([`${origin}/claim`]);
    expect(gate.key).toBe('pk_test_new');
    expect(gate.choice).toBe('publik');
    expect(storedChoice()).toBe('publik');
    expect(publik.resolveProvider(null)).toMatchObject({
      kind: 'publik',
      apiKey: 'pk_test_new',
    });
  });

  it.each([
    ['no plan and no balance', { kind: 'none', label: null }, 0],
    ['a plan', { kind: 'plan', label: 'Pro' }, 0],
    ['a balance', { kind: 'none', label: null }, 5_000_000],
  ])(
    'a signed-in person with %s and no stored choice sees no screen; the gate stores "publik"',
    async (_name, plan, balance) => {
      fake.claimed = true;
      fake.plan = plan;
      fake.balance = balance;
      for (const choice of [undefined, null]) {
        storeCredential(choice);
        const ui = recordingUI();
        const gate = await publik.ensureSignedIn(ui);
        expect(ui.shown).toEqual([]);
        expect(gate.choice).toBe('publik');
        expect(gate.key).toBe('pk_test_stored');
        expect(storedChoice()).toBe('publik');
        expect(publik.readCredential()).toMatchObject({
          key: 'pk_test_stored',
          install_id: 'install-0',
        });
      }
    },
  );

  it('a stored "own_key" choice is kept: no screen, no change to the file', async () => {
    fake.claimed = true;
    storeCredential('own_key');
    const before = fs.readFileSync(publik.credentialPath(), 'utf8');
    const ui = recordingUI();
    const gate = await publik.ensureSignedIn(ui);
    expect(ui.shown).toEqual([]);
    expect(gate.choice).toBe('own_key');
    expect(fs.readFileSync(publik.credentialPath(), 'utf8')).toBe(before);
    expect(publik.resolveProvider(null)).toEqual({ kind: 'needs_own_key' });
  });

  it('a stored "publik" choice is kept', async () => {
    fake.claimed = true;
    storeCredential('publik');
    const ui = recordingUI();
    const gate = await publik.ensureSignedIn(ui);
    expect(ui.shown).toEqual([]);
    expect(gate.choice).toBe('publik');
    expect(storedChoice()).toBe('publik');
  });

  it('keeps the words of the pay screen for a later 402 or a setting', () => {
    expect(publik.gateScreen('choose', null).title).toBe(
      'Choose how to pay for AI',
    );
  });
});
