import { NextRequest } from 'next/server';
import {
  acceptDisclosure,
  acknowledgeCta,
  declinePublik,
  resetPublik,
  retryPublik,
} from '@/lib/publik/provision';
import { getPublikStatus } from '@/lib/publik/status';

/* GET  → the publik connection's state and balance line (never the key).
   POST → { action: 'accept' | 'decline' | 'retry' | 'reconnect' | 'later' }
     accept:    the disclosure's "Continue with publik API" — records the
                acceptance and is the ONLY thing that mints [S4]
     decline:   "Use my own key instead" — removes the connection, pins it
     retry:     after an offline / rate-limited mint; same install id
     reconnect: after a decline or a disconnect; fresh install id, the
                disclosure shows again before anything is sent
     later:     the plan CTA's "Later" — keeps the key and the free
                starter, only records that the card was shown (§12.4) */
export const GET = async () => {
  return Response.json(await getPublikStatus());
};

export const POST = async (req: NextRequest) => {
  let action: string | undefined;
  try {
    action = (await req.json())?.action;
  } catch {
    action = undefined;
  }

  switch (action) {
    case 'accept':
      await acceptDisclosure();
      break;
    case 'decline':
      declinePublik();
      break;
    case 'retry':
      await retryPublik();
      break;
    case 'reconnect':
      resetPublik();
      break;
    case 'later':
      acknowledgeCta();
      break;
    default:
      return Response.json({ message: 'Unknown action.' }, { status: 400 });
  }

  return Response.json(await getPublikStatus({ refreshBalance: false }));
};
