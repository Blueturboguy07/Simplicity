import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import * as pageStaticInfo from 'next/dist/build/analysis/get-page-static-info';
import { getMiddlewareRouteMatcher } from 'next/dist/shared/lib/router/utils/middleware-route-matcher';
import { parseUrl } from 'next/dist/shared/lib/router/utils/parse-url';
import { normalizeRepeatedSlashes } from 'next/dist/shared/lib/utils';
import proxy, { config } from '@/proxy';

/* The guard's WIRING into Next, not the rules themselves (those are in
 * src/lib/http/localGuard.test.ts):
 *   - src/proxy.ts exists, is the default export Next calls, and refuses /
 *     passes requests end to end;
 *   - its matcher, evaluated with Next's own matcher code exactly as the
 *     router does (raw pathname OR its decodeURIComponent form, see
 *     next/dist/server/lib/router-utils/resolve-routes.js), covers every
 *     route under src/app/api and the encoded / dot-segment paths the blind
 *     verifier tried;
 *   - SIMPLICITY_DESKTOP switches between the desktop and web host rules.
 * Deleting src/proxy.ts or narrowing its matcher fails this file. */

const ROOT = path.resolve(__dirname, '..');
const API_DIR = path.join(ROOT, 'src', 'app', 'api');
const PORT = '8790';
const APP = `http://127.0.0.1:${PORT}`;

/* ---- the routes, from the file system ---------------------------------- */
type Route = { file: string; url: string; methods: string[] };

const routes: Route[] = (() => {
  const out: Route[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^route\.(ts|tsx|js|mjs)$/.test(e.name)) {
        const rel = path.relative(path.join(ROOT, 'src', 'app'), dir);
        const url =
          '/' +
          rel
            .split(path.sep)
            .map((seg) =>
              seg.startsWith('[...') || seg.startsWith('[[...')
                ? 'a/b'
                : seg.startsWith('[')
                  ? 'sample-id'
                  : seg,
            )
            .join('/');
        const src = fs.readFileSync(p, 'utf8');
        const methods = [
          ...src.matchAll(
            /export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g,
          ),
        ].map((m) => m[1]);
        out.push({ file: path.relative(ROOT, p), url, methods });
      }
    }
  };
  walk(API_DIR);
  return out;
})();

/* ---- Next's own matcher, exactly as the router applies it -------------- */
/* exported at runtime but missing from Next's .d.ts */
const getMiddlewareMatchers = (
  pageStaticInfo as unknown as {
    getMiddlewareMatchers: (matcher: unknown, nextConfig: unknown) => any[];
  }
).getMiddlewareMatchers;
const nextConfigSource = fs.readFileSync(path.join(ROOT, 'next.config.mjs'), 'utf8');
const matcher = getMiddlewareRouteMatcher(
  getMiddlewareMatchers(config.matcher, {}),
);
const proxyRunsFor = (url: string) => {
  const pathname = parseUrl(url).pathname || '/';
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    /* Next: can't decode, can't match the decoded form */
  }
  const r = { headers: {} } as any;
  return matcher(pathname, r, {}) || matcher(decoded, r, {});
};

const call = (
  url: string,
  method: string,
  headers: Record<string, string>,
) => proxy(new NextRequest(new URL(url, APP), { method, headers }));

const passed = (res: Response) => res.headers.get('x-middleware-next') === '1';

/* ---- env handling ----------------------------------------------------- */
const ENV_KEYS = ['SIMPLICITY_DESKTOP', 'PORT', 'SIMPLICITY_ALLOWED_HOSTS'];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const desktopMode = () => {
  process.env.SIMPLICITY_DESKTOP = '1';
  process.env.PORT = PORT;
};
const webMode = (allowed?: string) => {
  delete process.env.SIMPLICITY_DESKTOP;
  process.env.PORT = '3000';
  if (allowed) process.env.SIMPLICITY_ALLOWED_HOSTS = allowed;
  else delete process.env.SIMPLICITY_ALLOWED_HOSTS;
};

describe('route inventory', () => {
  it('finds every route file under src/app/api', () => {
    /* 19 at the time of writing; a drop means the walk broke, not that
       routes went away — update the floor if routes are really removed. */
    expect(routes.length).toBeGreaterThanOrEqual(19);
    expect(routes.every((r) => r.methods.length > 0)).toBe(true);
  });

  it('next.config.mjs sets no basePath or i18n (the matcher is evaluated without them)', () => {
    expect(nextConfigSource).not.toMatch(/\bbasePath\b|\bi18n\b/);
  });
});

describe('matcher covers every API route', () => {
  it.each(routes.map((r) => [r.url, r.file]))('%s (%s)', (url) => {
    expect(proxyRunsFor(url)).toBe(true);
    expect(proxyRunsFor(`${url}/`)).toBe(true);
    expect(proxyRunsFor(`${url}?x=1`)).toBe(true);
  });
});

describe('matcher covers the verifier’s odd paths', () => {
  /* raw-matrix.mjs P01–P26. Rule: whenever the path Next would match on
     (raw or decoded) is under /api, the proxy must run. */
  const odd = [
    '/api/config',
    '/%61pi/config',
    '/api/%63onfig',
    '/api%2Fconfig',
    '//api/config',
    '/API/config',
    '/api/config/',
    '/api/./config',
    '/api/../api/config',
    '/api/config%2F',
    '/api/config;x',
    '/api/config?x=1',
    '/api/config.json',
    '/api//config',
    '/api\\config',
    '/%2561pi/config',
    '/api/config%00',
    '/api/%2e/config',
    '/_next/data/build-id/api/config',
    '/Api/Config',
    '/%2F/api/config',
    '/./api/config',
    '/api/config%20',
    '/api/config/.',
    '/api;/config',
    '/%41PI/config',
  ];
  it.each(odd)('%s', (url) => {
    /* Next answers a path with `//` or `\\` with a 308 to the normalized
       URL before the proxy or any route runs (resolve-routes.js); the
       browser then requests that URL, which must be guarded. */
    if (/(\\|\/\/)/.test(url.split('?', 1)[0])) {
      url = normalizeRepeatedSlashes(url);
    }
    const pathname = parseUrl(url).pathname || '/';
    let decoded = pathname;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {}
    const underApi = [pathname, decoded].some(
      (p) => p === '/api' || p.startsWith('/api/'),
    );
    if (underApi) expect(proxyRunsFor(url)).toBe(true);
  });

  it.each([
    /* the dot-segment / query forms the UNGUARDED server routed to a real
       handler (raw-base.json: 200 with the BYO key) */
    '/api/./config',
    '/api/../api/config',
    '/api/config?x=1',
    '/api/%2e/config',
    '/./api/config',
  ])('base-routed form %s is guarded', (url) => {
    expect(proxyRunsFor(url)).toBe(true);
  });
});

describe('proxy wiring — desktop mode (SIMPLICITY_DESKTOP=1)', () => {
  it.each(routes.flatMap((r) => r.methods.map((m) => [m, r.url])))(
    'rebinding %s %s is refused',
    async (method, url) => {
      desktopMode();
      const res = await call(url, method, { host: `rebind.test:${PORT}` });
      expect(res.status).toBe(403);
      expect(res.headers.get('x-local-api-guard')).toBe('host-not-loopback');
    },
  );

  it.each(
    routes.flatMap((r) =>
      r.methods.filter((m) => m !== 'GET').map((m) => [m, r.url]),
    ),
  )('cross-site text/plain %s %s is refused', async (method, url) => {
    desktopMode();
    const res = await call(url, method, {
      host: `127.0.0.1:${PORT}`,
      origin: 'http://evil.example',
      'sec-fetch-site': 'cross-site',
      'content-type': 'text/plain',
    });
    expect(res.status).toBe(403);
  });

  it('the app’s own JSON POST passes through to the route', async () => {
    desktopMode();
    const res = await call('/api/config', 'POST', {
      host: `127.0.0.1:${PORT}`,
      origin: APP,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    });
    expect(passed(res)).toBe(true);
  });

  it('an allow-listed domain is still refused on desktop', async () => {
    desktopMode();
    process.env.SIMPLICITY_ALLOWED_HOSTS = 'site.example.com';
    const res = await call('/api/config', 'GET', { host: 'site.example.com' });
    expect(res.status).toBe(403);
  });

  it('a refusal says why in JSON', async () => {
    desktopMode();
    const res = await call('/api/config', 'GET', { host: `rebind.test:${PORT}` });
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect((await res.json()).message).toMatch(/local API guard/);
  });
});

describe('proxy wiring — web mode (no SIMPLICITY_DESKTOP)', () => {
  it('rebinding name is refused with a message naming SIMPLICITY_ALLOWED_HOSTS', async () => {
    webMode();
    const res = await call('/api/config', 'GET', { host: 'rebind.test:3000' });
    expect(res.status).toBe(403);
    expect(res.headers.get('x-local-api-guard')).toBe('host-not-allowed');
    expect((await res.json()).message).toContain('SIMPLICITY_ALLOWED_HOSTS');
  });

  it('an allow-listed domain passes', async () => {
    webMode('site.example.com');
    const res = await call('/api/config', 'GET', { host: 'site.example.com' });
    expect(passed(res)).toBe(true);
  });

  it('a LAN IP passes without configuration', async () => {
    webMode();
    const res = await call('/api/config', 'GET', { host: '192.168.1.20:3000' });
    expect(passed(res)).toBe(true);
  });

  it('same-origin POST behind a Host-rewriting proxy passes', async () => {
    webMode('site.example.com');
    const res = await call('/api/config', 'POST', {
      host: '127.0.0.1:3000',
      'x-forwarded-host': 'site.example.com',
      'x-forwarded-proto': 'https',
      origin: 'https://site.example.com',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    });
    expect(passed(res)).toBe(true);
  });
});

describe('round 2 tightening, end to end through the proxy (desktop)', () => {
  const own = {
    host: `127.0.0.1:${PORT}`,
    origin: APP,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  };
  const refused = async (headers: Record<string, string>, status = 403) => {
    desktopMode();
    const res = await call('/api/config', 'POST', headers);
    expect(passed(res)).toBe(false);
    expect(res.status).toBe(status);
  };

  it('O06: https Origin for the http loopback server', () =>
    refused({ ...own, origin: `https://127.0.0.1:${PORT}` }));
  it('O12: empty Origin header', () => refused({ ...own, origin: '' }));
  it('C02: application/jsonx', () =>
    refused({ ...own, 'content-type': 'application/jsonx' }, 415));
  it('C09: chunked body with no Content-Type', () => {
    const { 'content-type': _ct, ...noCt } = own;
    return refused({ ...noCt, 'transfer-encoding': 'chunked' }, 415);
  });
});

describe('web mode: rebinding write is refused too', () => {
  it('POST from a rebinding page (Origin matches its own Host)', async () => {
    webMode();
    const res = await call('/api/config', 'POST', {
      host: 'rebind.test:3000',
      origin: 'http://rebind.test:3000',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    });
    expect(res.status).toBe(403);
  });
});
