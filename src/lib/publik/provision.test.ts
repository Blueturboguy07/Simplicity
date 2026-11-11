import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashObj } from '@/lib/utils/hash';

/* The file-based publik connection. The desktop shell's module
 * (desktop/publik.mjs) mints the install key and writes the credential
 * file; this server only reads it. The config store is an in-memory
 * stand-in with the real ConfigManager semantics the code relies on
 * (getConfig / updateConfig / addModelProvider / removeModelProvider).
 * Global fetch is stubbed to throw: nothing here may make a request.
 *
 * The rules pinned here, in order of how expensive they'd be to get wrong:
 *   1. never overwrite a user-entered key (byte-identical fixture)
 *   2. consent precedes the connection — nothing is added before
 *      acceptDisclosure()
 *   3. the key lands in modelProviders[] and NEVER in config.publik
 *   4. the file's key and base_url are honoured; the choice is written back
 *   5. decline → provider removed, choice own_key; reconnect → pending;
 *      revoked → disconnected, no re-mint here
 */

const { store } = vi.hoisted(() => {
  const store: { config: any } = { config: null };
  return { store };
});

vi.mock('@/lib/config', async () => {
  const crypto = await import('node:crypto');
  const { hashObj } = await import('@/lib/utils/hash');
  const fresh = () => ({
    version: 1,
    setupComplete: false,
    preferences: {},
    personalization: {},
    modelProviders: [],
    search: { searxngURL: '' },
  });
  store.config = fresh();
  const mgr = {
    reset: () => {
      store.config = fresh();
    },
    getConfig: (key: string, defaultValue?: any) => {
      let obj: any = store.config;
      for (const part of key.split('.')) {
        if (obj == null) return defaultValue;
        obj = obj[part];
      }
      return obj === undefined ? defaultValue : obj;
    },
    updateConfig: (key: string, val: any) => {
      const parts = key.split('.');
      let target: any = store.config;
      for (let i = 0; i < parts.length - 1; i++) {
        if (target[parts[i]] === null || typeof target[parts[i]] !== 'object')
          target[parts[i]] = {};
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = val;
    },
    addModelProvider: (type: string, name: string, config: any) => {
      const p = {
        id: crypto.randomUUID(),
        name,
        type,
        config,
        chatModels: [],
        embeddingModels: [],
        hash: hashObj(config),
      };
      store.config.modelProviders.push(p);
      return p;
    },
    removeModelProvider: (id: string) => {
      store.config.modelProviders = store.config.modelProviders.filter(
        (p: any) => p.id !== id,
      );
    },
    getCurrentConfig: () => JSON.parse(JSON.stringify(store.config)),
  };
  return { default: mgr };
});

import configManager from '@/lib/config';
import {
  acceptDisclosure,
  declinePublik,
  ensureProvisioned,
  handleKeyRevoked,
  hasInstallCredential,
  PUBLIK_PROVIDER_TYPE,
  readInstallCredential,
  resetPublik,
  retryPublik,
  writeChoice,
} from './provision';
import { DISCLOSURE_VERSION, PUBLIK_BASE_URL_DEFAULT } from './types';
import { publikBalance } from './balance';

const KEY = 'pk_live_abcdefghijkl_0123456789abcdef0123456789abcdef';
const KEY2 = 'pk_live_mnopqrstuvwx_fedcba9876543210fedcba9876543210';
const INSTALL_ID = '11111111-2222-4333-8444-555555555555';

let dir: string;
let file: string;
const env = () =>
  ({ PUBLIK_CREDENTIAL_FILE: file }) as unknown as NodeJS.ProcessEnv;

const writeFile = (
  overrides: Record<string, unknown> = {},
  base: Record<string, unknown> | null = {
    key: KEY,
    base_url: 'http://publik.test/api/v1',
    install_id: INSTALL_ID,
    claim_url: 'http://publik.test/claim/x',
    choice: null,
  },
) => {
  fs.writeFileSync(file, JSON.stringify({ ...(base ?? {}), ...overrides }), {
    mode: 0o600,
  });
};
const readFile = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const providers = () => configManager.getConfig('modelProviders', []) as any[];
const mine = () => providers().filter((p) => p.type === PUBLIK_PROVIDER_TYPE);
const state = () => configManager.getConfig('publik', undefined) as any;
const consent = () =>
  configManager.updateConfig('publik', { disclosureVersion: DISCLOSURE_VERSION });

const realFetch = globalThis.fetch;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simplicity-publik-'));
  file = path.join(dir, 'simplicity.json');
  globalThis.fetch = (() => {
    throw new Error('provision.ts must never fetch');
  }) as any;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  (configManager as any).reset();
  publikBalance.reset();
  try {
    fs.unlinkSync(file);
  } catch {}
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readInstallCredential', () => {
  it('reads the module file and normalises base_url', () => {
    writeFile({ base_url: 'http://publik.test/api/v1/' });
    const c = readInstallCredential(env());
    expect(c).toMatchObject({
      key: KEY,
      base_url: 'http://publik.test/api/v1',
      install_id: INSTALL_ID,
      claim_url: 'http://publik.test/claim/x',
      choice: null,
    });
    expect(hasInstallCredential(env())).toBe(true);
  });

  it('is null without the env, without the file, or without a pk_ key', () => {
    expect(readInstallCredential({} as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(readInstallCredential(env())).toBeNull();
    writeFile({ key: 'sk-not-a-publik-key' });
    expect(readInstallCredential(env())).toBeNull();
    writeFile({ key: KEY, base_url: 'not a url' });
    expect(readInstallCredential(env())?.base_url).toBe(PUBLIK_BASE_URL_DEFAULT);
    expect(hasInstallCredential({} as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it('writeChoice keeps every other field and the file mode', () => {
    writeFile();
    writeChoice('own_key', env());
    expect(readFile()).toEqual({
      key: KEY,
      base_url: 'http://publik.test/api/v1',
      install_id: INSTALL_ID,
      claim_url: 'http://publik.test/claim/x',
      choice: 'own_key',
    });
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    writeChoice('publik', {} as unknown as NodeJS.ProcessEnv);
    expect(readFile().choice).toBe('own_key');
  });
});

describe('ensureProvisioned', () => {
  it('is a no-op without a credential file', async () => {
    expect(await ensureProvisioned({ env: env() })).toBe('no-token');
    expect(providers()).toEqual([]);
    expect(state()).toBeUndefined();
  });

  it('never overwrites a user-entered key', async () => {
    const user = configManager.addModelProvider(
      PUBLIK_PROVIDER_TYPE,
      'publik API',
      { apiKey: 'pk_live_usertyped00_user000000000000000000000000000', baseURL: 'http://mine.test/v1' },
    );
    const before = JSON.stringify(user);
    writeFile();
    consent();
    expect(await ensureProvisioned({ env: env() })).toBe('active');
    // The module's file wins over a stale stored key only when one credential
    // exists: the stored provider follows the file's key and base_url.
    expect(mine()).toHaveLength(1);
    expect(mine()[0].id).toBe(user.id);
    expect(mine()[0].config).toEqual({
      apiKey: KEY,
      baseURL: 'http://publik.test/api/v1',
    });
    expect(mine()[0].hash).toBe(hashObj(mine()[0].config));
    expect(before).not.toBe(JSON.stringify(mine()[0]));
    // A provider of another type is untouched byte for byte.
    const other = configManager.addModelProvider('openai', 'OpenAI', {
      apiKey: 'sk-user',
    });
    const otherBefore = JSON.stringify(other);
    expect(await ensureProvisioned({ env: env() })).toBe('active');
    expect(JSON.stringify(providers().find((p) => p.id === other.id))).toBe(
      otherBefore,
    );
    expect(providers()).toHaveLength(2);
  });

  it('requires consent before anything is connected', async () => {
    writeFile();
    expect(await ensureProvisioned({ env: env() })).toBe('consent-required');
    expect(providers()).toEqual([]);
    expect(state()?.state).toBeUndefined();
    expect(readFile().choice).toBeNull();
  });

  it('accept → provider from the file, state active, choice publik', async () => {
    writeFile();
    const now = () => new Date('2026-11-10T12:00:00Z');
    expect(await acceptDisclosure({ env: env(), now })).toBe('active');
    expect(mine()).toHaveLength(1);
    expect(mine()[0].config).toEqual({
      apiKey: KEY,
      baseURL: 'http://publik.test/api/v1',
    });
    expect(mine()[0].hash).toBe(hashObj(mine()[0].config));
    const s = state();
    expect(s.state).toBe('active');
    expect(s.installId).toBe(INSTALL_ID);
    expect(s.claimUrl).toBe('http://publik.test/claim/x');
    expect(s.mintedAt).toBe('2026-11-10T12:00:00.000Z');
    expect(s.disclosureVersion).toBe(DISCLOSURE_VERSION);
    expect(JSON.stringify(s)).not.toContain(KEY);
    expect(readFile().choice).toBe('publik');
    // Idempotent.
    expect(await ensureProvisioned({ env: env() })).toBe('active');
    expect(mine()).toHaveLength(1);
  });

  it('follows a key the module minted again and folds a duplicate', async () => {
    writeFile();
    await acceptDisclosure({ env: env() });
    const id = mine()[0].id;
    writeFile({ key: KEY2 });
    // The config manager adds a second entry from PUBLIK_API_KEY when the
    // key changed; the sync folds it into the first.
    configManager.addModelProvider(PUBLIK_PROVIDER_TYPE, 'publik API', {
      apiKey: KEY2,
      baseURL: 'http://publik.test/api/v1',
    });
    configManager.updateConfig('publik', {
      ...state(),
      state: 'disconnected',
      lastError: 'old',
    });
    expect(await ensureProvisioned({ env: env() })).toBe('active');
    expect(mine()).toHaveLength(1);
    expect(mine()[0].id).toBe(id);
    expect(mine()[0].config.apiKey).toBe(KEY2);
    expect(state().state).toBe('active');
    expect(state().lastError).toBeUndefined();
  });

  it('decline → provider removed, state declined, choice own_key', async () => {
    writeFile();
    await acceptDisclosure({ env: env() });
    expect(mine()).toHaveLength(1);
    declinePublik({ env: env() });
    expect(mine()).toEqual([]);
    expect(state().state).toBe('declined');
    expect(readFile().choice).toBe('own_key');
    // A declined install stays declined.
    expect(await ensureProvisioned({ env: env() })).toBe('declined');
    expect(await retryPublik({ env: env() })).toBe('declined');
    expect(mine()).toEqual([]);
    expect(readFile().choice).toBe('own_key');
  });

  it('reconnect → pending with the module install id, consent again', async () => {
    writeFile();
    await acceptDisclosure({ env: env() });
    declinePublik({ env: env() });
    resetPublik({ env: env() });
    expect(state()).toEqual({ installId: INSTALL_ID, state: 'pending' });
    expect(readFile().choice).toBe('own_key');
    expect(await retryPublik({ env: env() })).toBe('consent-required');
    expect(mine()).toEqual([]);
    expect(await acceptDisclosure({ env: env() })).toBe('active');
    expect(mine()).toHaveLength(1);
    expect(readFile().choice).toBe('publik');
  });

  it('revoked → disconnected, no re-mint here, next start reconnects', async () => {
    writeFile();
    await acceptDisclosure({ env: env() });
    expect(await handleKeyRevoked(true, { env: env() })).toBe('disconnected');
    expect(mine()).toEqual([]);
    expect(state().state).toBe('disconnected');
    expect(state().lastError).toMatch(/Restart Simplicity/);
    expect(await ensureProvisioned({ env: env() })).toBe('disconnected');
    expect(mine()).toEqual([]);
    // The choice in the file is the person's: a revoke does not change it.
    expect(readFile().choice).toBe('publik');
  });

  it('never calls fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    writeFile();
    await acceptDisclosure({ env: env() });
    declinePublik({ env: env() });
    resetPublik({ env: env() });
    await retryPublik({ env: env() });
    await handleKeyRevoked(true, { env: env() });
    expect(spy).not.toHaveBeenCalled();
  });
});
