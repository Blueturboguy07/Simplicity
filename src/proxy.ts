import { NextRequest, NextResponse } from 'next/server';
import { evaluateLocalApiGuard } from '@/lib/http/localGuard';

/* Every /api/* request passes through here before its route runs. The guard
 * refuses requests that a hostile web page (or a DNS-rebinding attacker) could
 * forge against the local server; the app's own same-origin calls pass
 * untouched. See src/lib/http/localGuard.ts for the rules and
 * scratchpad/bugfix/simplicity-api-guard/NOTES.md for the attacks it blocks.
 *
 * Proxy files run on the Node.js runtime in Next 16, so process.env is the
 * real server environment: PORT is set for every deployment, and
 * SIMPLICITY_DESKTOP is set only by the Electron shell (desktop/main.mjs),
 * which is what turns on the loopback-Host rule without breaking the web
 * (Docker) deployment served under a real domain.
 */
export default function proxy(req: NextRequest) {
  const verdict = evaluateLocalApiGuard(req, req.nextUrl.pathname, {
    isDesktop: process.env.SIMPLICITY_DESKTOP === '1',
    port: process.env.PORT,
  });

  if (!verdict.ok) {
    return NextResponse.json(
      { message: 'Request refused by the local API guard.' },
      { status: verdict.status, headers: { 'x-local-api-guard': verdict.reason } },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
