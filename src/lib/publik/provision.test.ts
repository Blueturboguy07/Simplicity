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
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { hashObj } from '@/lib/utils/hash';

/* Provisioning against a local fake gateway (CONTRACT §3.2). The config
 * store is an in-memory stand-in with the real ConfigManager semantics the
 * code relies on (getConfig / updateConfig / addModelProvider /
 * removeModelProvider). Everything else is real: global fetch, node:http.
 *
 * The rules pinned here, in order of how expensive they'd be to get wrong:
 *   1. never overwrite a user-entered key (byte-identical fixture)
 *   2. consent precedes mint — no request before acceptDisclosure() [S4]
 *   3. the key lands in modelProviders[] and NEVER in config.publik
 *   4. base_url and models from the response are honoured
 *   5. replay 200 {key:null} with no credential → one fresh install_id [B1]
 *   6. 401 key_revoked: reprovision:true re-mints with the same install_id;
 *      reprovision:false disconnects and never re-mints on its own [B2]
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
  acknowledgeCta,
  declinePublik,
  ensureProvisioned,
  handleKeyRevoked,
  publikModels,
  resetPublik,
  retryPublik,
} from './provision';
import {
  DISCLOSURE_VERSION,
  PUBLIK_BASE_URL_DEFAULT,
  PUBLIK_KEY_RE,
} from './types';
import { publikBalance } from './balance';

/* ---- fake gateway ------------------------------------------------------ */

type Received = { headers: http.IncomingHttpHeaders; body: any; url: string };

const KEY = 'pk_live_a8k2m9x4q7v1_h3n6r9t2w5y8z1b4c7d0f3g6j9k2m5p8';
const KEY2 = 'pk_live_b7j1n8w3p6u0_g2m5q8s1v4y7z0a3c6e9h2k5n8r1t4w7';

const okBody = (overrides: Record<string, any> = {}) => ({
  install_id: 'server-echo',
  key: KEY,
  key_id: 'a8k2m9x4q7v1',
  base_url: null,
  models: {
    fast: 'publik-fast',
    balanced: 'publik-balanced',
    smart: 'publik-smart',
  },
  claim_code: 'HK7F-2QWD',
  claim_url: 'https://publikhq.com/claim/HK7F-2QWD',
  claim_state: 'anonymous',
  starter_micros: 250000,
  balance_micros: 250000,
  starting_credit_micros: 250000,
  ...overrides,
});

let server: http.Server;
let baseURL: string;
let received: Received[] = [];
let respond: (req: Received) => {
  status: number;
  body?: any;
  headers?: Record<string, string>;
} = () => ({
  status: 201,
  body: okBody(),
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const r: Received = {
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
        url: req.url ?? '',
      };
      received.push(r);
      const out = respond(r);
      res.writeHead(out.status, {
        'content-type': 'application/json',
        ...(out.headers ?? {}),
      });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const env = (extra: Record<string, string | undefined> = {}) =>
  ({
    PUBLIK_APP_TOKEN: 'pat_simplicity_k3m9x2q7v5n8r4t6w1y0z2b5c8d1f4g7',
    PUBLIK_API_BASE_URL: baseURL,
    PUBLIK_APP_VERSION: '0.1.2',
    ...extra,
  }) as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  (configManager as any).reset();
  publikBalance.reset();
  received = [];
  respond = () => ({ status: 201, body: okBody() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const providers = () => configManager.getConfig('modelProviders', []) as any[];
const publikEntry = () => providers().find((p) => p.type === 'publik');
const state = () => configManager.getConfig('publik', undefined);

/* ---- tests ------------------------------------------------------------- */

describe('ensureProvisioned — guards', () => {
  it('is a no-op without PUBLIK_APP_TOKEN (dev, Docker, source builds)', async () => {
    const before = JSON.stringify(configManager.getCurrentConfig());
    expect(
      await ensureProvisioned({ env: env({ PUBLIK_APP_TOKEN: undefined }) }),
    ).toBe('no-token');
    expect(JSON.stringify(configManager.getCurrentConfig())).toBe(before);
    expect(received).toHaveLength(0);
  });

  it('sends nothing before the disclosure is accepted [S4]', async () => {
    expect(await ensureProvisioned({ env: env() })).toBe('consent-required');
    expect(received).toHaveLength(0);
    expect(publikEntry()).toBeUndefined();
    /* nothing minted, nothing written: the install id is born at consent */
    expect(state()?.state).not.toBe('active');
    expect(JSON.stringify(configManager.getCurrentConfig())).not.toContain(
      'pk_live_',
    );
  });

  it('declined stays declined, even with a token and consent', async () => {
    configManager.updateConfig('publik', {
      installId: 'x',
      state: 'declined',
      disclosureVersion: DISCLOSURE_VERSION,
    });
    expect(await ensureProvisioned({ env: env() })).toBe('declined');
    expect(received).toHaveLength(0);
  });
});

describe('acceptDisclosure — the mint', () => {
  it('happy path: one POST /installs, key in modelProviders[] only', async () => {
    expect(await acceptDisclosure({ env: env() })).toBe('active');

    expect(received).toHaveLength(1);
    const [req] = received;
    expect(req.url).toBe('/api/v1/installs');
    expect(req.headers.authorization).toBe(`Bearer ${env().PUBLIK_APP_TOKEN}`);
    expect(req.body.app_token).toBe(env().PUBLIK_APP_TOKEN);
    expect(req.body.app_slug).toBe('simplicity');
    expect(req.body.app_version).toBe('0.1.2');
    expect(['macos', 'windows', 'linux']).toContain(req.body.os);
    expect(req.body.install_id).toBe(state().installId);
    expect(req.body.disclosure_version).toBe(DISCLOSURE_VERSION);
    expect(req.body.dialects).toEqual(['chat_completions']);

    const entry = publikEntry();
    expect(entry).toBeDefined();
    expect(entry.name).toBe('publik API');
    expect(entry.config).toEqual({ apiKey: KEY, baseURL: baseURL });
    expect(providers().filter((p) => p.type === 'publik')).toHaveLength(1);

    const s = state();
    expect(s.state).toBe('active');
    expect(s.claimUrl).toBe('https://publikhq.com/claim/HK7F-2QWD');
    expect(s.claimCode).toBe('HK7F-2QWD');
    expect(s.starterMicros).toBe(250000);
    expect(JSON.stringify(s)).not.toContain('pk_live_');
    expect(publikBalance.peek().balanceMicros).toBe(250000);
  });

  it('is idempotent: a second call makes zero requests', async () => {
    await acceptDisclosure({ env: env() });
    expect(await ensureProvisioned({ env: env() })).toBe('active');
    expect(await acceptDisclosure({ env: env() })).toBe('active');
    expect(received).toHaveLength(1);
    expect(providers().filter((p) => p.type === 'publik')).toHaveLength(1);
  });

  it('honours base_url and models from the response over the compiled defaults', async () => {
    respond = () => ({
      status: 201,
      body: okBody({
        base_url: 'https://api.publikhq.com/v1/',
        models: {
          fast: 'publik-fast-2',
          balanced: 'publik-balanced-2',
          smart: 'publik-smart',
        },
      }),
    });
    await acceptDisclosure({ env: env() });
    expect(publikEntry().config.baseURL).toBe('https://api.publikhq.com/v1');
    expect(publikModels()).toEqual({
      fast: 'publik-fast-2',
      balanced: 'publik-balanced-2',
      smart: 'publik-smart',
    });
  });

  it('falls back to the compiled base URL when the response omits it', async () => {
    respond = () => ({
      status: 201,
      body: okBody({ base_url: undefined, models: undefined }),
    });
    await acceptDisclosure({ env: env() });
    expect(publikEntry().config.baseURL).toBe(baseURL);
    expect(publikModels()).toEqual({
      fast: 'publik-fast',
      balanced: 'publik-balanced',
      smart: 'publik-smart',
    });
  });

  it('uses the production base URL when no override is set', () => {
    expect(PUBLIK_BASE_URL_DEFAULT).toBe('https://publikhq.com/api/v1');
  });

  it('never overwrites a user-entered key (byte-identical fixture, still first)', async () => {
    const byo = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'My OpenAI',
      type: 'openai',
      chatModels: [{ name: 'GPT 5.1', key: 'gpt-5.1' }],
      embeddingModels: [],
      config: {
        apiKey: 'sk-user-entered-secret',
        baseURL: 'https://api.openai.com/v1',
      },
      hash: hashObj({
        apiKey: 'sk-user-entered-secret',
        baseURL: 'https://api.openai.com/v1',
      }),
    };
    configManager.updateConfig('modelProviders', [byo]);
    const before = JSON.stringify(byo);

    expect(await acceptDisclosure({ env: env() })).toBe('active');

    expect(providers()).toHaveLength(2);
    expect(JSON.stringify(providers()[0])).toBe(before);
    expect(providers()[1].type).toBe('publik');
  });

  it('replay 200 {key:null} with no credential → mints once more with a fresh install_id [B1]', async () => {
    let n = 0;
    respond = () =>
      n++ === 0
        ? {
            status: 200,
            body: okBody({
              key: null,
              starter_micros: 0,
              claim_state: 'anonymous',
            }),
          }
        : { status: 201, body: okBody({ key: KEY2, starter_micros: 0 }) };

    expect(await acceptDisclosure({ env: env() })).toBe('active');
    expect(received).toHaveLength(2);
    expect(received[0].body.install_id).not.toBe(received[1].body.install_id);
    expect(received[1].body.install_id).toBe(state().installId);
    expect(publikEntry().config.apiKey).toBe(KEY2);
  });

  it('a second replay does not loop', async () => {
    respond = () => ({ status: 200, body: okBody({ key: null }) });
    expect(await acceptDisclosure({ env: env() })).toBe('failed');
    expect(received).toHaveLength(2);
    expect(publikEntry()).toBeUndefined();
  });

  it('401 app token → failed, no provider, never a throw', async () => {
    respond = () => ({
      status: 401,
      body: { error: { type: 'invalid_app_token', message: 'nope' } },
    });
    expect(await acceptDisclosure({ env: env() })).toBe('failed');
    expect(publikEntry()).toBeUndefined();
    expect(state().state).toBe('pending');
    expect(state().lastError).toBe('app token rejected');
  });

  it('429 → failed with Retry-After noted', async () => {
    respond = () => ({
      status: 429,
      body: { error: { type: 'rate_limited' } },
      headers: { 'retry-after': '3600' },
    });
    expect(await acceptDisclosure({ env: env() })).toBe('failed');
    expect(state().retryAfter).toBe('3600');
    expect(publikEntry()).toBeUndefined();
  });

  it('malformed key → failed, nothing stored', async () => {
    respond = () => ({
      status: 201,
      body: okBody({ key: 'sk-not-a-publik-key' }),
    });
    expect(await acceptDisclosure({ env: env() })).toBe('failed');
    expect(publikEntry()).toBeUndefined();
    expect(JSON.stringify(configManager.getCurrentConfig())).not.toContain(
      'sk-not-a-publik-key',
    );
  });

  it('offline → failed, state pending, lastError set, no throw; retry reuses the install id', async () => {
    const deadEnv = env({ PUBLIK_API_BASE_URL: 'http://127.0.0.1:1/api/v1' });
    expect(await acceptDisclosure({ env: deadEnv, timeoutMs: 500 })).toBe(
      'failed',
    );
    expect(state().state).toBe('pending');
    expect(state().lastError).toBeTruthy();
    expect(publikEntry()).toBeUndefined();
    const id = state().installId;

    expect(await retryPublik({ env: env() })).toBe('active');
    expect(received[0].body.install_id).toBe(id);
    expect(state().lastError).toBeUndefined();
  });

  it('the key format the app accepts is exactly the contract format', () => {
    expect(PUBLIK_KEY_RE.test(KEY)).toBe(true);
    expect(
      PUBLIK_KEY_RE.test(
        'pk_test_a8k2m9x4q7v1_h3n6r9t2w5y8z1b4c7d0f3g6j9k2m5p8',
      ),
    ).toBe(true);
    expect(PUBLIK_KEY_RE.test('pk_live_short_h3n6')).toBe(false);
    expect(PUBLIK_KEY_RE.test('sk-proj-abcdef')).toBe(false);
  });
});

describe('decline / reset', () => {
  it('declinePublik removes the entry and pins declined; ensureProvisioned then does nothing', async () => {
    await acceptDisclosure({ env: env() });
    declinePublik();
    expect(publikEntry()).toBeUndefined();
    expect(state().state).toBe('declined');
    expect(await ensureProvisioned({ env: env() })).toBe('declined');
    expect(received).toHaveLength(1);
  });

  it('resetPublik after a decline re-shows the disclosure with a fresh install id', async () => {
    await acceptDisclosure({ env: env() });
    const firstId = state().installId;
    declinePublik();
    resetPublik();
    expect(state().state).toBe('pending');
    expect(state().installId).not.toBe(firstId);
    expect(state().disclosureVersion).toBeUndefined();
    expect(await ensureProvisioned({ env: env() })).toBe('consent-required');
    expect(await acceptDisclosure({ env: env() })).toBe('active');
    expect(received).toHaveLength(2);
  });
});

describe('the plan CTA (CONTRACT §12)', () => {
  it('the mint seeds the balance line from the response: starter and claim_url, never a constant', async () => {
    respond = () => ({
      status: 201,
      body: okBody({ starter_micros: 500000, balance_micros: 500000 }),
    });
    await acceptDisclosure({ env: env() });
    const snap = publikBalance.peek();
    expect(snap.starterRemainingMicros).toBe(500000);
    expect(snap.balanceMicros).toBe(500000);
    expect(snap.claimUrl).toBe('https://publikhq.com/claim/HK7F-2QWD');
    expect(snap.claimState).toBe('anonymous');
    expect(state().starterMicros).toBe(500000);
    expect(state().claimUrl).toBe('https://publikhq.com/claim/HK7F-2QWD');
  });

  it('"Later" keeps the key and the free starter; only ctaSeenAt is recorded', async () => {
    await acceptDisclosure({ env: env() });
    const before = JSON.stringify(publikEntry());
    const balanceBefore = publikBalance.peek().balanceMicros;

    acknowledgeCta({ now: () => new Date('2026-09-19T12:00:00Z') });

    expect(JSON.stringify(publikEntry())).toBe(before);
    expect(publikEntry().config.apiKey).toBe(KEY);
    expect(state().state).toBe('active');
    expect(state().ctaSeenAt).toBe('2026-09-19T12:00:00.000Z');
    expect(publikBalance.peek().balanceMicros).toBe(balanceBefore);
    /* and nothing was sent — no second mint, no claim on the user's behalf */
    expect(received).toHaveLength(1);
    expect(await ensureProvisioned({ env: env() })).toBe('active');
    expect(received).toHaveLength(1);
  });

  it('"Later" before any state exists is a no-op', () => {
    acknowledgeCta();
    expect(state()).toBeUndefined();
  });

  it('a 402 is noted for the banner and cleared by the next metered response', async () => {
    await acceptDisclosure({ env: env() });
    publikBalance.noteCreditError(
      'Not enough publik credit for this request.',
      'https://publikhq.com/claim/HK7F-2QWD',
    );
    expect(publikBalance.peek().creditError).toEqual({
      message: 'Not enough publik credit for this request.',
      topUpUrl: 'https://publikhq.com/claim/HK7F-2QWD',
    });
    publikBalance.observe(
      new Headers({ 'x-publik-balance': '1000', 'x-publik-claim-state': 'anonymous' }),
    );
    expect(publikBalance.peek().creditError).toBeNull();
  });
});

describe('handleKeyRevoked [B2]', () => {
  it('reprovision:true re-mints silently with the SAME install_id', async () => {
    await acceptDisclosure({ env: env() });
    const id = state().installId;
    respond = () => ({
      status: 201,
      body: okBody({ key: KEY2, starter_micros: 0 }),
    });

    expect(await handleKeyRevoked(true, { env: env() })).toBe('active');
    expect(received).toHaveLength(2);
    expect(received[1].body.install_id).toBe(id);
    expect(publikEntry().config.apiKey).toBe(KEY2);
    expect(providers().filter((p) => p.type === 'publik')).toHaveLength(1);
  });

  it('reprovision:false drops the key, marks disconnected, and never re-mints on its own', async () => {
    await acceptDisclosure({ env: env() });
    expect(await handleKeyRevoked(false, { env: env() })).toBe('disconnected');
    expect(publikEntry()).toBeUndefined();
    expect(state().state).toBe('disconnected');
    expect(await ensureProvisioned({ env: env() })).toBe('disconnected');
    expect(await retryPublik({ env: env() })).toBe('disconnected');
    expect(received).toHaveLength(1);
  });

  it('a user-entered key is untouched by a revoke', async () => {
    const byo = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Anthropic',
      type: 'anthropic',
      chatModels: [],
      embeddingModels: [],
      config: { apiKey: 'sk-ant-user' },
      hash: hashObj({ apiKey: 'sk-ant-user' }),
    };
    configManager.updateConfig('modelProviders', [byo]);
    const before = JSON.stringify(byo);
    await acceptDisclosure({ env: env() });
    await handleKeyRevoked(false, { env: env() });
    expect(JSON.stringify(providers()[0])).toBe(before);
    expect(providers()).toHaveLength(1);
  });
});
