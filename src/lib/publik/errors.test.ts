import { describe, expect, it } from 'vitest';
import { mapPublikError, PublikCreditError, PublikRevokedError } from './errors';

/* The 402 / 401 mapping (CONTRACT §1). Fake APIError-shaped objects: the
   SDK's APIError carries `status` and the parsed `error` body — that is
   all the mapper reads. */

const apiError = (status: number, error: any) =>
  Object.assign(new Error(`${status} status code`), { status, error });

describe('mapPublikError — 402', () => {
  it('maps insufficient_credit to PublikCreditError with top_up_url as the one link', () => {
    const out = mapPublikError(
      apiError(402, {
        type: 'insufficient_credit',
        message: 'Not enough publik credit for this request.',
        available_micros: 1240,
        required_micros: 41000,
        claim_state: 'anonymous',
        top_up_url: 'https://publikhq.com/claim/HK7F-2QWD',
        claim_url: 'https://publikhq.com/claim/HK7F-2QWD',
        add_credit_url: 'https://publikhq.com/dashboard/api/add',
        plans_url: 'https://publikhq.com/developers#plans',
      }),
    );
    expect(out).toBeInstanceOf(PublikCreditError);
    const e = out as PublikCreditError;
    expect(e.status).toBe(402);
    expect(e.message).toBe('Not enough publik credit for this request.');
    expect(e.topUpUrl).toBe('https://publikhq.com/claim/HK7F-2QWD');
    expect(e.errorType).toBe('insufficient_credit');
  });

  it('once claimed, top_up_url is the add-credit link and is used verbatim', () => {
    const e = mapPublikError(
      apiError(402, {
        type: 'insufficient_credit',
        message: 'm',
        claim_state: 'claimed',
        top_up_url: 'https://publikhq.com/dashboard/api/add',
        claim_url: null,
        add_credit_url: 'https://publikhq.com/dashboard/api/add',
      }),
    ) as PublikCreditError;
    expect(e.topUpUrl).toBe('https://publikhq.com/dashboard/api/add');
  });

  it('maps model_requires_claim (anonymous key asked for publik-smart) the same way', () => {
    const e = mapPublikError(
      apiError(402, {
        type: 'model_requires_claim',
        message: 'Link this computer to use Smart.',
        top_up_url: 'https://publikhq.com/claim/HK7F-2QWD',
      }),
    ) as PublikCreditError;
    expect(e).toBeInstanceOf(PublikCreditError);
    expect(e.errorType).toBe('model_requires_claim');
    expect(e.topUpUrl).toBe('https://publikhq.com/claim/HK7F-2QWD');
  });

  it('falls back to claim_url, then add_credit_url, then null when top_up_url is absent', () => {
    expect(
      (mapPublikError(apiError(402, { claim_url: 'https://publikhq.com/claim/A' })) as PublikCreditError)
        .topUpUrl,
    ).toBe('https://publikhq.com/claim/A');
    expect(
      (mapPublikError(apiError(402, { add_credit_url: 'https://publikhq.com/dashboard/api/add' })) as PublikCreditError)
        .topUpUrl,
    ).toBe('https://publikhq.com/dashboard/api/add');
    const bare = mapPublikError(apiError(402, null)) as PublikCreditError;
    expect(bare.topUpUrl).toBeNull();
    expect(bare.message).toBe('Not enough publik balance for this request.');
  });
});

describe('mapPublikError — 401 key_revoked', () => {
  it('reprovision:true → PublikRevokedError(reprovision=true)', () => {
    const e = mapPublikError(
      apiError(401, { type: 'key_revoked', message: 'revoked', reprovision: true }),
    ) as PublikRevokedError;
    expect(e).toBeInstanceOf(PublikRevokedError);
    expect(e.reprovision).toBe(true);
  });

  it('reprovision:false (or missing) → reprovision=false', () => {
    expect(
      (mapPublikError(apiError(401, { type: 'key_revoked', reprovision: false })) as PublikRevokedError)
        .reprovision,
    ).toBe(false);
    expect(
      (mapPublikError(apiError(401, { type: 'key_revoked' })) as PublikRevokedError).reprovision,
    ).toBe(false);
  });

  it('401 invalid_api_key is NOT a revoke — passes through', () => {
    const err = apiError(401, { type: 'invalid_api_key' });
    expect(mapPublikError(err)).toBe(err);
  });
});

describe('mapPublikError — everything else passes through', () => {
  it('429, 500 and non-API errors are returned unchanged', () => {
    const e429 = apiError(429, { type: 'rate_limit_exceeded' });
    const e500 = apiError(500, { type: 'gateway_unavailable' });
    const plain = new Error('boom');
    expect(mapPublikError(e429)).toBe(e429);
    expect(mapPublikError(e500)).toBe(e500);
    expect(mapPublikError(plain)).toBe(plain);
    expect(mapPublikError('string')).toBe('string');
    expect(mapPublikError(undefined)).toBeUndefined();
  });
});
