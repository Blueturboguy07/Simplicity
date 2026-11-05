import { NextRequest, NextResponse } from 'next/server';
import {
  evaluateLocalApiGuard,
  guardEnvFromProcess,
} from '@/lib/http/localGuard';

/* Every /api/* request passes through here before its route runs. The guard
 * refuses requests that a hostile web page (or a DNS-rebinding attacker) could
 * forge against the server; the app's own same-origin calls pass untouched.
 * See src/lib/http/localGuard.ts for the rules.
 *
 * Proxy files run on the Node.js runtime in Next 16, so process.env is the
 * real server environment, read per request:
 *   SIMPLICITY_DESKTOP=1      set only by the Electron shell (desktop/main.mjs)
 *                             → loopback-only Host on the server's PORT
 *   SIMPLICITY_ALLOWED_HOSTS  web build only → extra domain names to serve
 *                             under (loopback names and IP literals always
 *                             work). See README "Self-hosting the web build".
 *
 * src/proxy.test.ts pins this wiring and the matcher against every route
 * under src/app/api.
 */
export default function proxy(req: NextRequest) {
  const verdict = evaluateLocalApiGuard(
    req,
    req.nextUrl.pathname,
    guardEnvFromProcess(),
  );

  if (!verdict.ok) {
    return NextResponse.json(
      { message: verdict.message },
      {
        status: verdict.status,
        headers: { 'x-local-api-guard': verdict.reason },
      },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
