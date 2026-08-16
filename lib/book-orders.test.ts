import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Same "mock `@/lib/env` so the test needs no real environment" trick as
 * `lib/gelato.test.ts` — importing the real env module would validate the whole
 * process.env (DATABASE_URL, S3, OpenRouter, …) just to check an allow-list.
 *
 * Only the pure functions are covered here: everything else in `lib/book-orders.ts`
 * talks to Postgres, S3 and Gelato.
 */
const mockEnv = vi.hoisted(() => ({
  env: {
    BOOK_ORDERING_ALLOWED_EMAILS: [] as string[] | string,
    BETTER_AUTH_SECRET: 'test-secret-at-least-16-chars',
    BETTER_AUTH_URL: 'https://familienwerk.co',
  },
}));
vi.mock('@/lib/env', () => mockEnv);

// The module pulls in `@/db` (a live pg pool) via lib/books.ts — stubbed out so importing
// it doesn't try to connect.
vi.mock('@/db', () => ({ db: {} }));

afterEach(() => {
  mockEnv.env.BOOK_ORDERING_ALLOWED_EMAILS = [];
  mockEnv.env.BETTER_AUTH_SECRET = 'test-secret-at-least-16-chars';
  mockEnv.env.BETTER_AUTH_URL = 'https://familienwerk.co';
});

const validAddress = {
  firstName: 'Anna',
  lastName: 'Müller',
  addressLine1: 'Hauptstrasse 12',
  postCode: '10115',
  city: 'Berlin',
  country: 'DE',
  email: 'anna@example.com',
};

describe('canUserOrderBooks', () => {
  it('is false when the allow-list is empty', async () => {
    const { canUserOrderBooks } = await import('./book-orders');
    expect(canUserOrderBooks('anna@example.com')).toBe(false);
  });

  it('is false for a missing email', async () => {
    mockEnv.env.BOOK_ORDERING_ALLOWED_EMAILS = ['anna@example.com'];
    const { canUserOrderBooks } = await import('./book-orders');
    expect(canUserOrderBooks(null)).toBe(false);
    expect(canUserOrderBooks(undefined)).toBe(false);
    expect(canUserOrderBooks('')).toBe(false);
  });

  it('matches an allow-listed email regardless of case or padding', async () => {
    mockEnv.env.BOOK_ORDERING_ALLOWED_EMAILS = ['anna@example.com', 'bob@example.com'];
    const { canUserOrderBooks } = await import('./book-orders');
    expect(canUserOrderBooks('anna@example.com')).toBe(true);
    expect(canUserOrderBooks('Anna@Example.COM')).toBe(true);
    expect(canUserOrderBooks('  bob@example.com  ')).toBe(true);
  });

  it('rejects an email that is not on the list', async () => {
    mockEnv.env.BOOK_ORDERING_ALLOWED_EMAILS = ['anna@example.com'];
    const { canUserOrderBooks } = await import('./book-orders');
    expect(canUserOrderBooks('carol@example.com')).toBe(false);
  });

  it('also copes with the raw comma-separated string lib/env.ts returns in SKIP_ENV_VALIDATION mode', async () => {
    mockEnv.env.BOOK_ORDERING_ALLOWED_EMAILS = ' Anna@Example.com , bob@example.com ';
    const { canUserOrderBooks } = await import('./book-orders');
    expect(canUserOrderBooks('anna@example.com')).toBe(true);
    expect(canUserOrderBooks('bob@example.com')).toBe(true);
    expect(canUserOrderBooks('carol@example.com')).toBe(false);
  });

  it('is false when the raw value is unset', async () => {
    mockEnv.env.BOOK_ORDERING_ALLOWED_EMAILS = undefined as unknown as string;
    const { canUserOrderBooks } = await import('./book-orders');
    expect(canUserOrderBooks('anna@example.com')).toBe(false);
  });
});

describe('advanceStatus', () => {
  it('only ever moves forward through the happy path', async () => {
    const { advanceStatus } = await import('./book-orders');
    expect(advanceStatus('submitting', 'submitted')).toBe('submitted');
    expect(advanceStatus('submitted', 'in_production')).toBe('in_production');
    expect(advanceStatus('in_production', 'shipped')).toBe('shipped');
    expect(advanceStatus('shipped', 'delivered')).toBe('delivered');
  });

  it('ignores a stale poll that would walk the order backwards', async () => {
    const { advanceStatus } = await import('./book-orders');
    expect(advanceStatus('shipped', 'submitted')).toBe('shipped');
    expect(advanceStatus('delivered', 'in_production')).toBe('delivered');
    expect(advanceStatus('in_production', 'submitting')).toBe('in_production');
  });

  it('keeps the same status when nothing changed', async () => {
    const { advanceStatus } = await import('./book-orders');
    expect(advanceStatus('in_production', 'in_production')).toBe('in_production');
    expect(advanceStatus('delivered', 'delivered')).toBe('delivered');
  });

  it('lets a terminal verdict win from anywhere', async () => {
    const { advanceStatus } = await import('./book-orders');
    for (const current of ['submitting', 'submitted', 'in_production', 'shipped', 'delivered'] as const) {
      expect(advanceStatus(current, 'failed')).toBe('failed');
      expect(advanceStatus(current, 'cancelled')).toBe('cancelled');
    }
  });

  it('never moves back out of a terminal verdict', async () => {
    const { advanceStatus } = await import('./book-orders');
    for (const terminal of ['failed', 'cancelled'] as const) {
      for (const next of ['submitting', 'submitted', 'in_production', 'shipped', 'delivered'] as const) {
        expect(advanceStatus(terminal, next)).toBe(terminal);
      }
    }
  });

  it('lets one terminal verdict replace the other (Gelato cancelling a failed order)', async () => {
    const { advanceStatus } = await import('./book-orders');
    expect(advanceStatus('failed', 'cancelled')).toBe('cancelled');
    expect(advanceStatus('cancelled', 'failed')).toBe('failed');
  });
});

describe('the print-file URL Gelato downloads', () => {
  const orderId = '11111111-2222-3333-4444-555555555555';

  it('points at this order and carries a stable signature', async () => {
    const { printFileUrlFor } = await import('./book-orders');
    const url = printFileUrlFor(orderId);
    expect(url).toBe(printFileUrlFor(orderId));
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://familienwerk.co');
    expect(parsed.pathname).toBe(`/api/book-orders/${orderId}/print-file`);
    expect(parsed.searchParams.get('sig')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not double up the slash when BETTER_AUTH_URL has a trailing one', async () => {
    mockEnv.env.BETTER_AUTH_URL = 'https://familienwerk.co/';
    const { printFileUrlFor } = await import('./book-orders');
    expect(printFileUrlFor(orderId)).toContain('https://familienwerk.co/api/book-orders/');
  });

  it('verifies its own signature', async () => {
    const { printFileUrlFor, verifyPrintFileSig } = await import('./book-orders');
    const sig = new URL(printFileUrlFor(orderId)).searchParams.get('sig');
    expect(verifyPrintFileSig(orderId, sig)).toBe(true);
  });

  it('rejects a tampered, missing, or wrong-order signature', async () => {
    const { printFileUrlFor, verifyPrintFileSig } = await import('./book-orders');
    const sig = new URL(printFileUrlFor(orderId)).searchParams.get('sig')!;
    const flipped = `${sig.slice(0, -1)}${sig.endsWith('a') ? 'b' : 'a'}`;
    expect(verifyPrintFileSig(orderId, flipped)).toBe(false);
    expect(verifyPrintFileSig(orderId, null)).toBe(false);
    expect(verifyPrintFileSig(orderId, undefined)).toBe(false);
    expect(verifyPrintFileSig(orderId, '')).toBe(false);
    expect(verifyPrintFileSig(orderId, sig.slice(0, 32))).toBe(false); // length mismatch
    // A valid signature for one order must not open another one's file.
    const other = '99999999-8888-7777-6666-555555555555';
    expect(verifyPrintFileSig(other, sig)).toBe(false);
  });

  it('changes with the secret, so a leaked link dies with a key rotation', async () => {
    const { printFileUrlFor, verifyPrintFileSig } = await import('./book-orders');
    const sig = new URL(printFileUrlFor(orderId)).searchParams.get('sig')!;
    mockEnv.env.BETTER_AUTH_SECRET = 'a-completely-different-secret';
    expect(verifyPrintFileSig(orderId, sig)).toBe(false);
  });
});

describe('quoteRecipientForCountry', () => {
  it('gives each shipping country its own placeholder address', async () => {
    const { quoteRecipientForCountry, BOOK_SHIPPING_COUNTRIES } = await import('./book-orders');
    for (const country of BOOK_SHIPPING_COUNTRIES) {
      const recipient = quoteRecipientForCountry(country);
      expect(recipient.country).toBe(country);
      expect(recipient.city).toBeTruthy();
      expect(recipient.postCode).toBeTruthy();
    }
    expect(quoteRecipientForCountry('AT').city).toBe('Wien');
    expect(quoteRecipientForCountry('CH').city).toBe('Zürich');
    expect(quoteRecipientForCountry('DE').city).toBe('Berlin');
  });

  it('is a valid Gelato recipient in every case', async () => {
    const { quoteRecipientForCountry, bookShippingAddressSchema, BOOK_SHIPPING_COUNTRIES } =
      await import('./book-orders');
    for (const country of BOOK_SHIPPING_COUNTRIES) {
      expect(bookShippingAddressSchema.safeParse(quoteRecipientForCountry(country)).success).toBe(true);
    }
  });
});

describe('bookShippingAddressSchema', () => {
  it('accepts a complete address', async () => {
    const { bookShippingAddressSchema } = await import('./book-orders');
    const parsed = bookShippingAddressSchema.safeParse(validAddress);
    expect(parsed.success).toBe(true);
  });

  it('trims every field', async () => {
    const { bookShippingAddressSchema } = await import('./book-orders');
    const parsed = bookShippingAddressSchema.parse({
      ...validAddress,
      firstName: '  Anna  ',
      city: ' Berlin ',
      postCode: ' 10115 ',
    });
    expect(parsed.firstName).toBe('Anna');
    expect(parsed.city).toBe('Berlin');
    expect(parsed.postCode).toBe('10115');
  });

  it('allows the optional address line 2 and phone, and works without them', async () => {
    const { bookShippingAddressSchema } = await import('./book-orders');
    expect(bookShippingAddressSchema.safeParse(validAddress).success).toBe(true);
    const parsed = bookShippingAddressSchema.parse({
      ...validAddress,
      addressLine2: 'c/o Schmidt',
      phone: '+49 30 123456',
    });
    expect(parsed.addressLine2).toBe('c/o Schmidt');
    expect(parsed.phone).toBe('+49 30 123456');
  });

  it('only allows the countries we ship to', async () => {
    const { bookShippingAddressSchema, BOOK_SHIPPING_COUNTRIES } = await import('./book-orders');
    for (const country of BOOK_SHIPPING_COUNTRIES) {
      expect(bookShippingAddressSchema.safeParse({ ...validAddress, country }).success).toBe(true);
    }
    expect(bookShippingAddressSchema.safeParse({ ...validAddress, country: 'US' }).success).toBe(false);
    expect(bookShippingAddressSchema.safeParse({ ...validAddress, country: 'de' }).success).toBe(false);
  });

  it("enforces Gelato's field limits", async () => {
    const { bookShippingAddressSchema } = await import('./book-orders');
    const tooLong = (n: number) => 'x'.repeat(n + 1);
    const cases: Array<[string, string]> = [
      ['firstName', tooLong(25)],
      ['lastName', tooLong(25)],
      ['addressLine1', tooLong(35)],
      ['addressLine2', tooLong(35)],
      ['city', tooLong(30)],
      ['postCode', tooLong(15)],
      ['phone', tooLong(25)],
    ];
    for (const [field, value] of cases) {
      const parsed = bookShippingAddressSchema.safeParse({ ...validAddress, [field]: value });
      expect(parsed.success, `${field} should reject ${value.length} chars`).toBe(false);
    }
  });

  it('rejects empty required fields and a malformed email', async () => {
    const { bookShippingAddressSchema } = await import('./book-orders');
    expect(bookShippingAddressSchema.safeParse({ ...validAddress, firstName: '   ' }).success).toBe(false);
    expect(bookShippingAddressSchema.safeParse({ ...validAddress, addressLine1: '' }).success).toBe(false);
    expect(bookShippingAddressSchema.safeParse({ ...validAddress, email: 'not-an-email' }).success).toBe(false);
  });
});
