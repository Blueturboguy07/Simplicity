import { describe, expect, it } from 'vitest';
import {
  evaluateLocalApiGuard,
  guardEnvFromProcess,
  isIpLiteral,
  mediaType,
  parseAllowedHosts,
  splitHostHeader,
  GuardEnv,
  GuardRequestLike,
} from './localGuard';

/* The /api guard as a pure function, pinned against the attacks proved in
 * scratchpad/bugfix/simplicity-api-guard and the verifier's raw matrix
 * (verify-simplicity-guard/harness/raw-matrix.mjs), and against the app's own
 * same-origin calls. The wiring into Next (src/proxy.ts, its matcher, the
 * env switch) is pinned separately in src/proxy.test.ts. */

const PORT = '8790';
const APP_HOST = `127.0.0.1:${PORT}`;
const APP_ORIGIN = `http://127.0.0.1:${PORT}`;
const ATTACKER = 'http://evil.example';

const DESKTOP: GuardEnv = { isDesktop: true, port: PORT };
const WEB: GuardEnv = { isDesktop: false, port: '3000', allowedHosts: [] };
const WEB_SITE: GuardEnv = {
  isDesktop: false,
  port: '3000',
  allowedHosts: parseAllowedHosts('site.example.com'),
};

const req = (
  method: string,
  headers: Record<string, string | undefined>,
): GuardRequestLike => ({
  method,
  headers: {
    get: (n: string) => {
      const v = headers[n.toLowerCase()];
      return v === undefined ? null : v;
    },
  },
});

const verdict = (
  method: string,
  headers: Record<string, string | undefined>,
  path = '/api/config',
  env: GuardEnv = DESKTOP,
) => evaluateLocalApiGuard(req(method, headers), path, env);

const reason = (v: ReturnType<typeof evaluateLocalApiGuard>) =>
  v.ok ? 'ok' : v.reason;

/* same-origin JSON POST, the shape the app's renderer sends */
const ownPost = (extra: Record<string, string | undefined> = {}) => ({
  host: APP_HOST,
  origin: APP_ORIGIN,
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
  'content-length': '20',
  ...extra,
});

describe('splitHostHeader', () => {
  it('splits host:port and lowercases the name', () => {
    expect(splitHostHeader('LOCALHOST:8790')).toEqual({
      hostname: 'localhost',
      port: '8790',
    });
  });
  it('splits bracketed ipv6 with port', () => {
    expect(splitHostHeader('[::1]:8790')).toEqual({
      hostname: '[::1]',
      port: '8790',
    });
  });
  it.each([
    '',
    '::1',
    '127.0.0.1:8790@rebind.test',
    '127.0.0.1:8790:8790',
    'a b',
    'evil.example/x',
    '-bad.example',
  ])('refuses malformed host %j', (h) => {
    expect(splitHostHeader(h)).toBeNull();
  });
});

describe('helpers', () => {
  it('isIpLiteral: dotted quads and bracketed ipv6 only', () => {
    expect(isIpLiteral('192.168.1.20')).toBe(true);
    expect(isIpLiteral('[fe80::1]')).toBe(true);
    expect(isIpLiteral('127.1')).toBe(false);
    expect(isIpLiteral('2130706433')).toBe(false);
    expect(isIpLiteral('256.1.1.1')).toBe(false);
    expect(isIpLiteral('example.com')).toBe(false);
  });
  it('mediaType parses exactly', () => {
    expect(mediaType('application/json; charset=utf-8')).toBe(
      'application/json',
    );
    expect(mediaType('APPLICATION/JSON')).toBe('application/json');
    expect(mediaType('application/jsonx')).toBe('application/jsonx');
    expect(mediaType(null)).toBeNull();
  });
  it('parseAllowedHosts accepts names, name:port and URLs', () => {
    expect(
      parseAllowedHosts(' a.example.com , box.lan:3000,https://X.example ,,'),
    ).toEqual([
      { hostname: 'a.example.com', port: '' },
      { hostname: 'box.lan', port: '3000' },
      { hostname: 'x.example', port: '' },
    ]);
  });
  it('guardEnvFromProcess reads the three variables', () => {
    expect(
      guardEnvFromProcess({
        SIMPLICITY_DESKTOP: '1',
        PORT: '8790',
        SIMPLICITY_ALLOWED_HOSTS: 'a.example',
      }),
    ).toEqual({
      isDesktop: true,
      port: '8790',
      allowedHosts: [{ hostname: 'a.example', port: '' }],
    });
    expect(guardEnvFromProcess({}).isDesktop).toBe(false);
  });
});

describe('DESKTOP — attacks refused', () => {
  it.each([
    ['A2 cross-site text/plain POST /api/config', 'POST', { host: APP_HOST, origin: ATTACKER, 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain;charset=UTF-8', 'content-length': '72' }, '/api/config'],
    ['A4 cross-site text/plain POST /api/publik (revoke)', 'POST', { host: APP_HOST, origin: ATTACKER, 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain', 'content-length': '22' }, '/api/publik'],
    ['A5 cross-site bodyless POST setup-complete', 'POST', { host: APP_HOST, origin: ATTACKER, 'sec-fetch-site': 'cross-site' }, '/api/config/setup-complete'],
    ['A3 cross-site <img> GET /api/publik', 'GET', { host: APP_HOST, 'sec-fetch-site': 'cross-site' }, '/api/publik'],
    ['A7 rebinding read /api/config', 'GET', { host: `rebind.test:${PORT}` }, '/api/config'],
    ['rebinding with matching Origin', 'GET', { host: `rebind.test:${PORT}`, origin: `http://rebind.test:${PORT}` }, '/api/config'],
    ['rebinding + forged X-Forwarded-Host loopback (H17)', 'GET', { host: `rebind.test:${PORT}`, 'x-forwarded-host': APP_HOST }, '/api/config'],
    ['other port (H10)', 'GET', { host: '127.0.0.1:1234' }, '/api/config'],
    ['leading-zero port (H11)', 'GET', { host: `127.0.0.1:0${PORT}` }, '/api/config'],
    ['127.1 (H05)', 'GET', { host: `127.1:${PORT}` }, '/api/config'],
    ['0.0.0.0 (H06)', 'GET', { host: `0.0.0.0:${PORT}` }, '/api/config'],
    ['trailing dot (H07)', 'GET', { host: `localhost.:${PORT}` }, '/api/config'],
    ['userinfo-ish (H13)', 'GET', { host: `127.0.0.1:${PORT}@rebind.test` }, '/api/config'],
    ['no Host (H21)', 'GET', {}, '/api/config'],
    ['public name even if allow-listed on web', 'GET', { host: 'site.example.com' }, '/api/config'],
    ['cross-site POST, no Sec-Fetch (old WebKit)', 'POST', { host: APP_HOST, origin: ATTACKER, 'content-type': 'text/plain', 'content-length': '10' }, '/api/publik'],
    ['form POST', 'POST', { host: APP_HOST, origin: ATTACKER, 'content-type': 'application/x-www-form-urlencoded', 'content-length': '20' }, '/api/config'],
    ['null Origin (O02)', 'POST', ownPost({ origin: 'null' }), '/api/chat'],
    ['cross-site multipart to uploads', 'POST', { host: APP_HOST, origin: ATTACKER, 'content-type': 'multipart/form-data; boundary=x', 'content-length': '100' }, '/api/uploads'],
    ['same-site Sec-Fetch (S04)', 'POST', ownPost({ 'sec-fetch-site': 'same-site' }), '/api/config'],
    ['attacker Origin + forged SFS same-origin (O13)', 'POST', ownPost({ origin: ATTACKER }), '/api/config'],
    ['localhost Origin vs 127.0.0.1 Host (O08)', 'POST', ownPost({ origin: `http://localhost:${PORT}` }), '/api/config'],
  ] as const)('%s', (_name, method, headers, path) => {
    expect(verdict(method, headers as any, path).ok).toBe(false);
  });
});

describe('round 2 tightening (each was accepted by 52eea5b)', () => {
  it('O06: https Origin for the http server is refused (scheme compared)', () => {
    expect(reason(verdict('POST', ownPost({ origin: `https://127.0.0.1:${PORT}` })))).toBe('origin-mismatch');
  });
  it('O12: empty Origin header is refused', () => {
    expect(reason(verdict('POST', ownPost({ origin: '' })))).toBe('origin-empty');
  });
  it('Origin with a trailing slash or path is refused', () => {
    expect(verdict('POST', ownPost({ origin: `${APP_ORIGIN}/` })).ok).toBe(false);
    expect(verdict('POST', ownPost({ origin: `${APP_ORIGIN}/x` })).ok).toBe(false);
  });
  it('C02: application/jsonx is refused', () => {
    expect(reason(verdict('POST', ownPost({ 'content-type': 'application/jsonx' })))).toBe('content-type:application/jsonx');
  });
  it('C03: text/plain;application/json is refused', () => {
    expect(verdict('POST', ownPost({ 'content-type': 'text/plain;application/json' })).ok).toBe(false);
  });
  it('C09: chunked body with no Content-Type is refused', () => {
    expect(
      reason(verdict('POST', { host: APP_HOST, origin: APP_ORIGIN, 'transfer-encoding': 'chunked' })),
    ).toBe('content-type:none');
  });
  it('chunked body with text/plain is refused', () => {
    expect(
      verdict('POST', { host: APP_HOST, origin: APP_ORIGIN, 'transfer-encoding': 'chunked', 'content-type': 'text/plain' }).ok,
    ).toBe(false);
  });
  it('a declared non-JSON Content-Type without a body is refused', () => {
    expect(verdict('DELETE', { host: APP_HOST, origin: APP_ORIGIN, 'content-type': 'text/plain' }, '/api/chats/x').ok).toBe(false);
  });
  it('multipart is refused off /api/uploads (C06)', () => {
    expect(verdict('POST', ownPost({ 'content-type': 'multipart/form-data; boundary=x' })).ok).toBe(false);
  });
});

describe('DESKTOP — app own calls allowed', () => {
  it.each([
    ['JSON POST /api/chat', 'POST', ownPost(), '/api/chat'],
    ['JSON POST with charset (C01)', 'POST', ownPost({ 'content-type': 'application/json; charset=utf-8' }), '/api/config'],
    ['APPLICATION/JSON (C08)', 'POST', ownPost({ 'content-type': 'APPLICATION/JSON' }), '/api/config'],
    ['GET /api/config', 'GET', { host: APP_HOST, 'sec-fetch-site': 'same-origin' }, '/api/config'],
    ['navigation GET (SFS none)', 'GET', { host: APP_HOST, 'sec-fetch-site': 'none' }, '/api/discover'],
    ['bodyless POST setup-complete', 'POST', { host: APP_HOST, origin: APP_ORIGIN, 'sec-fetch-site': 'same-origin', 'content-length': '0' }, '/api/config/setup-complete'],
    ['bodyless POST reconnect', 'POST', { host: APP_HOST, origin: APP_ORIGIN }, '/api/reconnect/abc'],
    ['multipart POST /api/uploads', 'POST', ownPost({ 'content-type': 'multipart/form-data; boundary=----x', 'content-length': '5000' }), '/api/uploads'],
    ['DELETE with JSON type, no body', 'DELETE', { host: APP_HOST, origin: APP_ORIGIN, 'content-type': 'application/json', 'content-length': '0' }, '/api/chats/abc'],
    ['DELETE with no headers', 'DELETE', { host: APP_HOST, origin: APP_ORIGIN }, '/api/providers/abc'],
    ['localhost Host + localhost Origin', 'POST', ownPost({ host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` }), '/api/config'],
    ['[::1] Host + Origin', 'POST', ownPost({ host: `[::1]:${PORT}`, origin: `http://[::1]:${PORT}` }), '/api/config'],
    ['LOCALHOST Host (H03)', 'GET', { host: `LOCALHOST:${PORT}` }, '/api/config'],
    ['loopback + forged X-Forwarded-Host is ignored (H18)', 'GET', { host: APP_HOST, 'x-forwarded-host': 'rebind.test' }, '/api/config'],
  ] as const)('%s', (_name, method, headers, path) => {
    expect(reason(verdict(method, headers as any, path))).toBe('ok');
  });
});

describe('WEB — host allow rule', () => {
  it.each([
    ['localhost:3000', 'localhost:3000'],
    ['127.0.0.1:3000', '127.0.0.1:3000'],
    ['LAN IP', '192.168.1.20:3000'],
    ['ipv6 literal', '[fe80::1]:3000'],
  ])('allows %s with no configuration', (_n, host) => {
    expect(reason(verdict('GET', { host }, '/api/config', WEB))).toBe('ok');
  });

  it('refuses a rebinding name and names the env var', () => {
    const v = verdict('GET', { host: 'rebind.test:3000' }, '/api/config', WEB);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe('host-not-allowed');
      expect(v.message).toContain('SIMPLICITY_ALLOWED_HOSTS');
    }
  });

  it('refuses a rebinding write too', () => {
    expect(
      verdict('POST', { host: 'rebind.test:3000', origin: 'http://rebind.test:3000', 'content-type': 'application/json', 'content-length': '10' }, '/api/config', WEB).ok,
    ).toBe(false);
  });

  it('allows a name listed in SIMPLICITY_ALLOWED_HOSTS (any port)', () => {
    expect(
      reason(verdict('POST', { host: 'site.example.com', origin: 'https://site.example.com', 'content-type': 'application/json', 'content-length': '10' }, '/api/config', WEB_SITE)),
    ).toBe('ok');
  });

  it('honours a port pinned in SIMPLICITY_ALLOWED_HOSTS', () => {
    const env: GuardEnv = { isDesktop: false, allowedHosts: parseAllowedHosts('box.lan:3000') };
    expect(verdict('GET', { host: 'box.lan:3000' }, '/api/config', env).ok).toBe(true);
    expect(verdict('GET', { host: 'box.lan:4000' }, '/api/config', env).ok).toBe(false);
  });

  it('cross-site POST to an allowed name is still refused', () => {
    expect(
      verdict('POST', { host: 'site.example.com', origin: ATTACKER, 'content-type': 'text/plain', 'content-length': '10' }, '/api/config', WEB_SITE).ok,
    ).toBe(false);
  });
});

describe('WEB — behind a Host-rewriting reverse proxy', () => {
  const behindProxy = (extra: Record<string, string | undefined> = {}) => ({
    host: '127.0.0.1:3000',
    'x-forwarded-host': 'site.example.com',
    'x-forwarded-proto': 'https',
    origin: 'https://site.example.com',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    'content-length': '10',
    ...extra,
  });

  it('same-origin POST is compared with X-Forwarded-Host/Proto and allowed', () => {
    expect(reason(verdict('POST', behindProxy(), '/api/config', WEB_SITE))).toBe('ok');
  });

  it('scheme comes from X-Forwarded-Proto exactly', () => {
    expect(reason(verdict('POST', behindProxy({ origin: 'http://site.example.com' }), '/api/config', WEB_SITE))).toBe('origin-mismatch');
  });

  it('no X-Forwarded-Proto: http or https on the exact host:port', () => {
    const h = behindProxy({ 'x-forwarded-proto': undefined, 'x-forwarded-host': 'site.example.com:8798' });
    expect(verdict('POST', { ...h, origin: 'http://site.example.com:8798' }, '/api/config', WEB_SITE).ok).toBe(true);
    expect(verdict('POST', { ...h, origin: 'https://site.example.com:8798' }, '/api/config', WEB_SITE).ok).toBe(true);
    expect(verdict('POST', { ...h, origin: 'http://site.example.com:9999' }, '/api/config', WEB_SITE).ok).toBe(false);
  });

  it('forwarded host not in the allow list is refused', () => {
    expect(reason(verdict('GET', behindProxy({ origin: undefined, 'x-forwarded-host': 'rebind.test' }), '/api/config', WEB_SITE))).toBe('host-not-allowed');
  });

  it('every X-Forwarded-Host entry must be allowed (appending proxies)', () => {
    expect(
      verdict('GET', behindProxy({ origin: undefined, 'x-forwarded-host': 'localhost, rebind.test' }), '/api/config', WEB_SITE).ok,
    ).toBe(false);
  });

  it('cross-site POST through the proxy is refused', () => {
    expect(verdict('POST', behindProxy({ origin: ATTACKER, 'sec-fetch-site': 'cross-site' }), '/api/config', WEB_SITE).ok).toBe(false);
  });

  it('Host-preserving proxy (Caddy/Traefik) keeps working', () => {
    expect(
      reason(verdict('POST', { host: 'site.example.com', 'x-forwarded-proto': 'https', origin: 'https://site.example.com', 'content-type': 'application/json', 'content-length': '10' }, '/api/config', WEB_SITE)),
    ).toBe('ok');
  });
});
