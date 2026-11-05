import { describe, expect, it } from 'vitest';
import {
  evaluateLocalApiGuard,
  splitHostHeader,
  GuardEnv,
  GuardRequestLike,
} from './localGuard';

/* The /api guard, pinned against the attacks proved in
 * scratchpad/bugfix/simplicity-api-guard (a hostile page in the user's normal
 * browser reaching the local server) and against the app's own same-origin
 * calls. Each attack case FAILS on origin/desktop (no guard) and is refused
 * here; each positive case is the shape the app actually sends. */

const PORT = '8790';
const APP_HOST = `127.0.0.1:${PORT}`;
const APP_ORIGIN = `http://127.0.0.1:${PORT}`;
const ATTACKER = 'http://evil.example';

const DESKTOP: GuardEnv = { isDesktop: true, port: PORT };
const WEB: GuardEnv = { isDesktop: false, port: '3000' };

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

const allow = (v: ReturnType<typeof evaluateLocalApiGuard>) => v.ok === true;
const deny = (v: ReturnType<typeof evaluateLocalApiGuard>) => v.ok === false;

describe('splitHostHeader', () => {
  it('splits host:port', () => {
    expect(splitHostHeader('127.0.0.1:8790')).toEqual({
      hostname: '127.0.0.1',
      port: '8790',
    });
  });
  it('splits bracketed ipv6 with port', () => {
    expect(splitHostHeader('[::1]:8790')).toEqual({
      hostname: '[::1]',
      port: '8790',
    });
  });
  it('treats a bare ipv6 as hostname only', () => {
    expect(splitHostHeader('::1')).toEqual({ hostname: '::1', port: '' });
  });
  it('returns null for empty', () => {
    expect(splitHostHeader('')).toBeNull();
    expect(splitHostHeader(null)).toBeNull();
  });
});

describe('ATTACKS — refused on the desktop build', () => {
  it('A2: cross-site no-cors POST text/plain to /api/config (rewrite baseURL)', () => {
    const v = evaluateLocalApiGuard(
      req('POST', {
        host: APP_HOST,
        origin: ATTACKER,
        'sec-fetch-site': 'cross-site',
        'content-type': 'text/plain;charset=UTF-8',
        'content-length': '72',
      }),
      '/api/config',
      DESKTOP,
    );
    expect(deny(v)).toBe(true);
  });

  it('A4: cross-site no-cors POST text/plain to /api/publik (revoke)', () => {
    const v = evaluateLocalApiGuard(
      req('POST', {
        host: APP_HOST,
        origin: ATTACKER,
        'sec-fetch-site': 'cross-site',
        'content-type': 'text/plain;charset=UTF-8',
        'content-length': '22',
      }),
      '/api/publik',
      DESKTOP,
    );
    expect(deny(v)).toBe(true);
  });

  it('A5: cross-site bodyless POST to /api/config/setup-complete', () => {
    const v = evaluateLocalApiGuard(
      req('POST', {
        host: APP_HOST,
        origin: ATTACKER,
        'sec-fetch-site': 'cross-site',
      }),
      '/api/config/setup-complete',
      DESKTOP,
    );
    expect(deny(v)).toBe(true);
  });

  it('A6: cross-site no-cors POST text/plain to /api/providers (add rogue)', () => {
    const v = evaluateLocalApiGuard(
      req('POST', {
        host: APP_HOST,
        origin: ATTACKER,
        'sec-fetch-site': 'cross-site',
        'content-type': 'text/plain',
        'content-length': '50',
      }),
      '/api/providers',
      DESKTOP,
    );
    expect(deny(v)).toBe(true);
  });

  it('A3: cross-site GET /api/publik via <img> (Sec-Fetch-Site: cross-site, no Origin)', () => {
    const v = evaluateLocalApiGuard(
      req('GET', { host: APP_HOST, 'sec-fetch-site': 'cross-site' }),
      '/api/publik',
      DESKTOP,
    );
    expect(deny(v)).toBe(true);
  });

  it('A7: DNS-rebinding READ of /api/config (foreign Host, no Origin)', () => {
    const v = evaluateLocalApiGuard(
      req('GET', { host: `evil.example:${PORT}` }),
      '/api/config',
      DESKTOP,
    );
    expect(deny(v)).toBe(true);
  });

  it('A8: DNS-rebinding READ of /api/chats', () => {
    const v = evaluateLocalApiGuard(
      req('GET', { host: `evil.example:${PORT}` }),
      '/api/chats',
      DESKTOP,
    );
    expect(deny(v)).toBe(true);
  });

  it('A9: prototype-pollution POST to /api/config (text/plain)', () => {
    const v = evaluateLocalApiGuard(
      req('POST', {
        host: APP_HOST,
        origin: ATTACKER,
        'content-type': 'text/plain',
        'content-length': '40',
      }),
      '/api/config',
      DESKTOP,
    );
    expect(deny(v)).toBe(true);
  });

  it('A10: cross-site POST to /api/local-runtime/claude', () => {
    const v = evaluateLocalApiGuard(
      req('POST', {
        host: APP_HOST,
        origin: ATTACKER,
        'sec-fetch-site': 'cross-site',
      }),
      '/api/local-runtime/claude',
      DESKTOP,
    );
    expect(deny(v)).toBe(true);
  });

  it('rebinding READ where Origin matches the foreign Host still fails on loopback rule', () => {
    const v = evaluateLocalApiGuard(
      req('GET', {
        host: `evil.example:${PORT}`,
        origin: `http://evil.example:${PORT}`,
      }),
      '/api/config',
      DESKTOP,
    );
    expect(deny(v)).toBe(true);
  });

  it('cross-site POST with no Sec-Fetch header (e.g. older WebKit) still fails on Origin', () => {
    const v = evaluateLocalApiGuard(
      req('POST', {
        host: APP_HOST,
        origin: ATTACKER,
        'content-type': 'text/plain',
        'content-length': '10',
      }),
      '/api/publik',
      DESKTOP,
    );
    expect(deny(v)).toBe(true);
  });

  it('form POST (urlencoded) cross-site is refused', () => {
    const v = evaluateLocalApiGuard(
      req('POST', {
        host: APP_HOST,
        origin: ATTACKER,
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': '20',
      }),
      '/api/config',
      DESKTOP,
    );
    expect(deny(v)).toBe(true);
  });

  it('opaque (null) Origin is refused', () => {
    const v = evaluateLocalApiGuard(
      req('POST', {
        host: APP_HOST,
        origin: 'null',
        'content-type': 'application/json',
        'content-length': '10',
      }),
      '/api/chat',
      DESKTOP,
    );
    expect(deny(v)).toBe(true);
  });

  it('same-origin-shaped JSON POST but with a smuggled text/plain body on uploads is refused', () => {
    const v = evaluateLocalApiGuard(
      req('POST', {
        host: APP_HOST,
        origin: ATTACKER,
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': '100',
      }),
      '/api/uploads',
      DESKTOP,
    );
    /* cross-site origin still rejects it even though the content-type is the
       one uploads allows. */
    expect(deny(v)).toBe(true);
  });
});

describe('APP OWN CALLS — allowed on the desktop build', () => {
  it('P: same-origin JSON POST /api/chat', () => {
    const v = evaluateLocalApiGuard(
      req('POST', {
        host: APP_HOST,
        origin: APP_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'content-length': '200',
      }),
      '/api/chat',
      DESKTOP,
    );
    expect(allow(v)).toBe(true);
  });

  it('P: same-origin GET /api/config', () => {
    const v = evaluateLocalApiGuard(
      req('GET', { host: APP_HOST, 'sec-fetch-site': 'same-origin' }),
      '/api/config',
      DESKTOP,
    );
    expect(allow(v)).toBe(true);
  });

  it('P: same-origin GET /api/publik with no Origin', () => {
    const v = evaluateLocalApiGuard(
      req('GET', { host: APP_HOST, 'sec-fetch-site': 'same-origin' }),
      '/api/publik',
      DESKTOP,
    );
    expect(allow(v)).toBe(true);
  });

  it('P: top-level navigation GET (Sec-Fetch-Site: none, no Origin)', () => {
    const v = evaluateLocalApiGuard(
      req('GET', { host: APP_HOST, 'sec-fetch-site': 'none' }),
      '/api/discover',
      DESKTOP,
    );
    expect(allow(v)).toBe(true);
  });

  it('P: bodyless same-origin POST /api/config/setup-complete (no content-type)', () => {
    const v = evaluateLocalApiGuard(
      req('POST', {
        host: APP_HOST,
        origin: APP_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'content-length': '0',
      }),
      '/api/config/setup-complete',
      DESKTOP,
    );
    expect(allow(v)).toBe(true);
  });

  it('P: bodyless same-origin POST /api/reconnect/<id> (no headers beyond host)', () => {
    const v = evaluateLocalApiGuard(
      req('POST', { host: APP_HOST, origin: APP_ORIGIN }),
      '/api/reconnect/abc',
      DESKTOP,
    );
    expect(allow(v)).toBe(true);
  });

  it('P: same-origin multipart POST /api/uploads', () => {
    const v = evaluateLocalApiGuard(
      req('POST', {
        host: APP_HOST,
        origin: APP_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'content-type': 'multipart/form-data; boundary=----x',
        'content-length': '5000',
      }),
      '/api/uploads',
      DESKTOP,
    );
    expect(allow(v)).toBe(true);
  });

  it('P: same-origin DELETE /api/chats/<id> with json content-type', () => {
    const v = evaluateLocalApiGuard(
      req('DELETE', {
        host: APP_HOST,
        origin: APP_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'content-length': '0',
      }),
      '/api/chats/abc',
      DESKTOP,
    );
    expect(allow(v)).toBe(true);
  });

  it('P: localhost host (not 127.0.0.1) is a valid loopback origin', () => {
    const v = evaluateLocalApiGuard(
      req('POST', {
        host: `localhost:${PORT}`,
        origin: `http://localhost:${PORT}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'content-length': '10',
      }),
      '/api/config',
      DESKTOP,
    );
    expect(allow(v)).toBe(true);
  });
});

describe('WEB deployment — Host allowlist relaxed, CSRF still enforced', () => {
  const SITE = 'simplicity.example.com';
  it('same-origin JSON POST under a real domain is allowed', () => {
    const v = evaluateLocalApiGuard(
      req('POST', {
        host: SITE,
        origin: `https://${SITE}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'content-length': '10',
      }),
      '/api/config',
      WEB,
    );
    expect(allow(v)).toBe(true);
  });

  it('cross-site POST to the web deployment is still refused', () => {
    const v = evaluateLocalApiGuard(
      req('POST', {
        host: SITE,
        origin: ATTACKER,
        'content-type': 'text/plain',
        'content-length': '10',
      }),
      '/api/config',
      WEB,
    );
    expect(deny(v)).toBe(true);
  });

  it('a foreign Host is NOT rejected on web (no loopback rule), but needs same-origin', () => {
    const v = evaluateLocalApiGuard(
      req('GET', { host: SITE, 'sec-fetch-site': 'same-origin' }),
      '/api/chats',
      WEB,
    );
    expect(allow(v)).toBe(true);
  });
});
