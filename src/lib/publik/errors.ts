/* Typed errors for the two gateway answers the app must act on, and the
   mapper that recognises them on an OpenAI-SDK APIError (CONTRACT §1):

     402 insufficient_credit / model_requires_claim → PublikCreditError
         rendered as the message plus exactly one link, `top_up_url`
     401 key_revoked {reprovision}                 → PublikRevokedError
         reprovision:true  → silently mint again (idle sweep)
         reprovision:false → "disconnected"; never re-mint on our own

   Everything else passes through untouched. */

export class PublikCreditError extends Error {
  readonly status = 402;
  constructor(
    message: string,
    public readonly topUpUrl: string | null,
    public readonly errorType: string = 'insufficient_credit',
  ) {
    super(message);
    this.name = 'PublikCreditError';
  }
}

export class PublikRevokedError extends Error {
  readonly status = 401;
  constructor(
    message: string,
    public readonly reprovision: boolean,
  ) {
    super(message);
    this.name = 'PublikRevokedError';
  }
}

/* Structural, not instanceof: the SDK's APIError is what arrives in
   practice, but the test suite and any future client only need an object
   with `status` and the parsed `error` body. */
type ApiErrorLike = {
  status?: number;
  error?: { type?: string; message?: string; [k: string]: unknown } | null;
  message?: string;
};

const isApiErrorLike = (err: unknown): err is ApiErrorLike =>
  typeof err === 'object' && err !== null && 'status' in err;

export const mapPublikError = (err: unknown): unknown => {
  if (!isApiErrorLike(err)) return err;
  const body = err.error ?? {};
  const type = typeof body.type === 'string' ? body.type : '';

  if (err.status === 402) {
    const topUp =
      (typeof body.top_up_url === 'string' && body.top_up_url) ||
      (typeof body.claim_url === 'string' && body.claim_url) ||
      (typeof body.add_credit_url === 'string' && body.add_credit_url) ||
      null;
    return new PublikCreditError(
      typeof body.message === 'string' && body.message
        ? body.message
        : 'Not enough publik balance for this request.',
      topUp,
      type || 'insufficient_credit',
    );
  }

  if (err.status === 401 && type === 'key_revoked') {
    return new PublikRevokedError(
      typeof body.message === 'string' && body.message
        ? body.message
        : 'This computer is no longer connected to publik API.',
      body.reprovision === true,
    );
  }

  return err;
};
