/* One guard for every /api/* route, against a hostile web page.
 *
 * The desktop app runs this Next server on http://127.0.0.1:<port> and loads
 * it in an Electron window; the web build (Docker / self-hosted) serves the
 * same routes on a LAN or public name. Without a guard, ANY page the user has
 * open in their browser can reach these routes: a no-cors POST with a
 * text/plain body is a CORS "simple request", so it is sent cross-origin with
 * no preflight and no consent, and it can rewrite config, revoke the publik
 * connection, or make the app spend the user's balance. With DNS rebinding the
 * attacker can also READ responses (keys, chat history).
 *
 * The rules, all enforced before any route body runs:
 *   1. Host. Desktop: a loopback name (127.0.0.1 / localhost / [::1]) on the
 *      server's own port, nothing else. Web: every host the request names —
 *      Host and each X-Forwarded-Host entry — must be a loopback name, an IP
 *      literal, or a name listed in SIMPLICITY_ALLOWED_HOSTS. DNS rebinding
 *      needs a domain name, so this is what stops rebinding reads and writes.
 *   2. Sec-Fetch-Site: when the browser sends it, it must be `same-origin` or
 *      `none`.
 *   3. Origin: when the header is present (even empty) it must be exactly the
 *      app's own origin — scheme, host and port. Desktop: http://<Host>. Web:
 *      the public host is X-Forwarded-Host when a reverse proxy rewrote Host
 *      (nginx's default `$proxy_host`, Apache without ProxyPreserveHost), with
 *      the scheme from X-Forwarded-Proto. The browser always attaches Origin to
 *      a cross-origin request, including a no-cors one.
 *   4. Content-Type: any non-GET/HEAD request that has a body
 *      (Content-Length > 0 or any Transfer-Encoding) or declares a type must
 *      declare exactly `application/json` — or `multipart/form-data` on
 *      /api/uploads. This denies the text/plain body-smuggling trick and forces
 *      a preflight that a cross-origin page cannot satisfy (we never send CORS
 *      headers).
 *
 * GET/HEAD never change state in this app; the Host, Sec-Fetch and Origin
 * rules still apply to them.
 *
 * Pure and framework-free: unit-tested directly and wired in by src/proxy.ts.
 */

export const ALLOWED_HOSTS_ENV = 'SIMPLICITY_ALLOWED_HOSTS';

export type AllowedHost = { hostname: string; port: string };

export type GuardEnv = {
  /* true only in the Electron desktop build (set by desktop/main.mjs). */
  isDesktop: boolean;
  /* the server's own port, when known — pins the loopback Host on desktop. */
  port?: string | null;
  /* web build only: extra host names (and optional ports) to serve under. */
  allowedHosts?: AllowedHost[];
};

export type GuardVerdict =
  | { ok: true }
  | { ok: false; status: number; reason: string; message: string };

export type GuardRequestLike = {
  method: string;
  headers: { get(name: string): string | null };
};

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

const DEFAULT_MESSAGE = 'Request refused by the local API guard.';
const HOST_MESSAGE =
  `Request refused by the local API guard: this host name is not allowed. ` +
  `To serve Simplicity under a domain name, add it to ${ALLOWED_HOSTS_ENV} ` +
  `(comma-separated, for example "search.example.com,box.lan:3000").`;

const deny = (
  status: number,
  reason: string,
  message = DEFAULT_MESSAGE,
): GuardVerdict => ({ ok: false, status, reason, message });

/* host = name or IPv4 or [IPv6], optional :port. Anything else (spaces,
   userinfo, paths, trailing junk) is not a host a browser would send. */
const HOST_RE =
  /^(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/i;

/* Split a Host / X-Forwarded-Host value into hostname + port. Returns null
   for anything that is not a well-formed host. Hostname is lowercased. */
export function splitHostHeader(
  host: string | null | undefined,
): { hostname: string; port: string } | null {
  if (host == null) return null;
  const h = host.trim();
  const m = HOST_RE.exec(h);
  if (!m) return null;
  return { hostname: m[1].toLowerCase(), port: m[2] ?? '' };
}

const IPV4_RE =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export const isLoopbackHostname = (hostname: string) =>
  LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());

/* An IP literal can't be rebound — DNS rebinding needs a name to re-resolve. */
export const isIpLiteral = (hostname: string) =>
  IPV4_RE.test(hostname) || /^\[[0-9a-f:.]+\]$/i.test(hostname);

/* SIMPLICITY_ALLOWED_HOSTS="a.example.com, box.lan:3000, https://x.example"
   → [{hostname, port}]. Unparseable entries are dropped. */
export function parseAllowedHosts(raw: string | undefined | null): AllowedHost[] {
  if (!raw) return [];
  const out: AllowedHost[] = [];
  for (let entry of raw.split(',')) {
    entry = entry.trim();
    if (!entry) continue;
    if (entry.includes('://')) {
      try {
        entry = new URL(entry).host;
      } catch {
        continue;
      }
    }
    const parsed = splitHostHeader(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function guardEnvFromProcess(
  env: Record<string, string | undefined> = process.env,
): GuardEnv {
  return {
    isDesktop: env.SIMPLICITY_DESKTOP === '1',
    port: env.PORT ?? null,
    allowedHosts: parseAllowedHosts(env[ALLOWED_HOSTS_ENV]),
  };
}

const webHostAllowed = (
  h: { hostname: string; port: string },
  allowed: AllowedHost[],
) =>
  isLoopbackHostname(h.hostname) ||
  isIpLiteral(h.hostname) ||
  allowed.some(
    (a) => a.hostname === h.hostname && (a.port === '' || a.port === h.port),
  );

/* "a, b" → ["a", "b"]; the first entry is the client-facing value. */
const listHeader = (v: string | null) =>
  v == null
    ? []
    : v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

/* new URL(...).origin canonicalises case and default ports; a browser's
   Origin header is already in that form, so an exact string compare
   against it checks scheme, host and port together. */
const canonicalOrigin = (scheme: string, host: string): string | null => {
  try {
    return new URL(`${scheme}://${host}`).origin;
  } catch {
    return null;
  }
};

/* "application/json; charset=utf-8" → "application/json" */
export const mediaType = (contentType: string | null): string | null => {
  if (contentType == null) return null;
  return contentType.split(';')[0].trim().toLowerCase();
};

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
  const host = splitHostHeader(hostHeader);
  if (!host) return deny(403, 'host-invalid');

  /* ---- 1. Host --------------------------------------------------------- */
  /* Expected origins for rule 3 are built here, per mode. */
  let expectedOrigins: string[];

  if (env.isDesktop) {
    if (!isLoopbackHostname(host.hostname)) {
      return deny(403, 'host-not-loopback');
    }
    if (env.port && host.port && host.port !== String(env.port)) {
      return deny(403, 'host-port-mismatch');
    }
    /* X-Forwarded-* are ignored on desktop: there is no proxy in front of the
       loopback server, so they can only be forged. */
    const own = canonicalOrigin('http', hostHeader!.trim());
    expectedOrigins = own ? [own] : [];
  } else {
    const allowed = env.allowedHosts ?? [];
    if (!webHostAllowed(host, allowed)) {
      return deny(403, 'host-not-allowed', HOST_MESSAGE);
    }
    /* Every X-Forwarded-Host entry must be allowed too: a proxy that appends
       (Apache) keeps a client-supplied first entry, and a rebinding page can
       set this header on a same-origin request. */
    const fwdHosts = listHeader(get('x-forwarded-host'));
    const fwdParsed = fwdHosts.map((v) => splitHostHeader(v));
    if (fwdParsed.some((p) => !p)) {
      return deny(403, 'forwarded-host-invalid');
    }
    if (fwdParsed.some((p) => !webHostAllowed(p!, allowed))) {
      return deny(403, 'host-not-allowed', HOST_MESSAGE);
    }
    const publicHost = fwdHosts[0] ?? hostHeader!.trim();
    const proto = (listHeader(get('x-forwarded-proto'))[0] ?? '').toLowerCase();
    /* No X-Forwarded-Proto: the server itself speaks http, but a TLS proxy
       that keeps Host and sends no proto header is common; the host:port
       must still match exactly. */
    const schemes =
      proto === 'http' || proto === 'https' ? [proto] : ['http', 'https'];
    expectedOrigins = schemes
      .map((s) => canonicalOrigin(s, publicHost))
      .filter((o): o is string => o !== null);
  }

  /* ---- 2. Sec-Fetch-Site ------------------------------------------------ */
  const sfs = get('sec-fetch-site');
  if (sfs !== null && sfs !== 'same-origin' && sfs !== 'none') {
    return deny(403, `sec-fetch-site:${sfs.slice(0, 32)}`);
  }

  /* ---- 3. Origin (present → must be exactly ours) ----------------------- */
  const origin = get('origin');
  if (origin !== null) {
    if (origin === '') return deny(403, 'origin-empty');
    if (origin === 'null') return deny(403, 'origin-null');
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return deny(403, 'origin-unparseable');
    }
    /* An Origin header is exactly scheme://host[:port] — reject anything a
       browser would not send (paths, userinfo, upper case, default ports). */
    if (parsed.origin !== origin) return deny(403, 'origin-unparseable');
    if (!expectedOrigins.includes(origin)) {
      return deny(403, 'origin-mismatch');
    }
  }

  /* ---- 4. Content-Type for anything that can carry a body --------------- */
  if (method !== 'GET' && method !== 'HEAD') {
    const cl = get('content-length');
    const te = get('transfer-encoding');
    const ct = get('content-type');
    const hasBody =
      te !== null || (cl !== null && cl.trim() !== '' && cl.trim() !== '0');
    if (hasBody || ct !== null) {
      const mt = mediaType(ct);
      const wanted = isUploadsPath(pathname)
        ? 'multipart/form-data'
        : 'application/json';
      if (mt !== wanted) {
        return deny(415, `content-type:${(mt || 'none').slice(0, 48)}`);
      }
    }
  }

  return { ok: true };
}
