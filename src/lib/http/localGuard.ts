/* One guard for every /api/* route, against a hostile web page.
 *
 * The desktop app runs this Next server on http://127.0.0.1:<port> and loads
 * it in an Electron window. Without a guard, ANY page the user has open in
 * their normal browser can reach these routes: a no-cors POST with a
 * text/plain body is a CORS "simple request", so it is sent cross-origin with
 * no preflight and no consent, and it can rewrite config, revoke the publik
 * connection, or make the app spend the user's balance. With DNS rebinding the
 * attacker can also READ responses (keys, chat history). See
 * scratchpad/bugfix/simplicity-api-guard/NOTES.md.
 *
 * The rules, all enforced before any route body runs:
 *   1. Host (desktop only): must be a loopback host (127.0.0.1 / localhost /
 *      [::1]) on the server's own port. A rebinding attacker's page is served
 *      from a public name, so the browser sends that name as Host — this is
 *      what stops rebinding reads. Not applied on the web deployment, which is
 *      served under a real domain.
 *   2. Sec-Fetch-Site: when the browser sends it, it must be `same-origin` or
 *      `none`. `cross-site` / `same-site` are refused.
 *   3. Origin: when present it must equal the app's own origin (same host as
 *      the Host header). This is the deployment-independent CSRF check and
 *      rejects every cross-origin POST in every browser (the browser always
 *      attaches Origin to a cross-origin request, including a no-cors one).
 *   4. Content-Type: a request that carries a body must declare
 *      `application/json` — except /api/uploads, which is multipart. This
 *      denies the text/plain body-smuggling trick and forces a preflight that
 *      a cross-origin page cannot satisfy (we never send CORS headers).
 *
 * GET/HEAD never change state in this app, so they are not subject to the
 * body rule; the Host + Sec-Fetch + Origin checks still apply to them.
 *
 * The function is pure and framework-free so it can be unit-tested directly
 * and reused by src/proxy.ts.
 */

export type GuardEnv = {
  /* true only in the Electron desktop build (set by desktop/main.mjs). */
  isDesktop: boolean;
  /* the server's own port, when known — used to pin the loopback Host. */
  port?: string | null;
};

export type GuardVerdict =
  | { ok: true }
  | { ok: false; status: number; reason: string };

export type GuardRequestLike = {
  method: string;
  headers: { get(name: string): string | null };
};

const LOOPBACK_HOSTNAMES = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
]);

/* Split a Host/authority into hostname + port, handling bracketed IPv6. */
export function splitHostHeader(
  host: string | null,
): { hostname: string; port: string } | null {
  if (!host) return null;
  const h = host.trim();
  if (!h) return null;
  if (h.startsWith('[')) {
    const close = h.indexOf(']');
    if (close === -1) return null;
    const hostname = h.slice(0, close + 1);
    const rest = h.slice(close + 1);
    const port = rest.startsWith(':') ? rest.slice(1) : '';
    return { hostname, port };
  }
  const colon = h.lastIndexOf(':');
  if (colon === -1) return { hostname: h, port: '' };
  /* A bare IPv6 with no brackets has multiple colons — treat the whole thing
     as the hostname (no port). */
  if (h.indexOf(':') !== colon) return { hostname: h, port: '' };
  return { hostname: h.slice(0, colon), port: h.slice(colon + 1) };
}

const isLoopbackHostname = (hostname: string) =>
  LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());

const isUploadsPath = (pathname: string) =>
  pathname === '/api/uploads' || pathname.startsWith('/api/uploads/');

export function evaluateLocalApiGuard(
  req: GuardRequestLike,
  pathname: string,
  env: GuardEnv,
): GuardVerdict {
  const method = req.method.toUpperCase();
  const get = (n: string) => req.headers.get(n);

  const hostHeader = get('host');
  const parsedHost = splitHostHeader(hostHeader);

  /* 1. Loopback-only Host on the desktop app (anti DNS-rebinding). */
  if (env.isDesktop) {
    if (!parsedHost || !isLoopbackHostname(parsedHost.hostname)) {
      return { ok: false, status: 403, reason: 'host-not-loopback' };
    }
    if (env.port && parsedHost.port && parsedHost.port !== String(env.port)) {
      return { ok: false, status: 403, reason: 'host-port-mismatch' };
    }
  }

  /* 2. Sec-Fetch-Site, when the browser provides it. */
  const sfs = get('sec-fetch-site');
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') {
    return { ok: false, status: 403, reason: `sec-fetch-site:${sfs}` };
  }

  /* 3. Origin must be same-origin as the Host when present. */
  const origin = get('origin');
  if (origin && origin !== 'null') {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { ok: false, status: 403, reason: 'origin-unparseable' };
    }
    if (!hostHeader || originHost.toLowerCase() !== hostHeader.toLowerCase()) {
      return { ok: false, status: 403, reason: 'origin-mismatch' };
    }
  } else if (origin === 'null') {
    /* An opaque origin (sandboxed iframe, data: document) is never the app. */
    return { ok: false, status: 403, reason: 'origin-null' };
  }

  /* 4. Body content-type. */
  const writeMethod =
    method === 'POST' ||
    method === 'PUT' ||
    method === 'PATCH' ||
    method === 'DELETE';
  const ct = (get('content-type') || '').toLowerCase();
  const cl = get('content-length');
  const hasBody =
    (cl != null && cl !== '' && cl !== '0') ||
    (ct !== '' && method !== 'GET' && method !== 'HEAD');
  if (writeMethod && hasBody) {
    const okCt = isUploadsPath(pathname)
      ? ct.startsWith('multipart/form-data')
      : ct.startsWith('application/json');
    if (!okCt) {
      return { ok: false, status: 415, reason: `content-type:${ct || 'none'}` };
    }
  }

  return { ok: true };
}
