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
    BOOK_ORDERING_ALLOWED_EMAILS: [] as string[],
  },
}));
vi.mock('@/lib/env', () => mockEnv);

// The module pulls in `@/db` (a live pg pool) via lib/books.ts — stubbed out so importing
// it doesn't try to connect.
vi.mock('@/db', () => ({ db: {} }));

afterEach(() => {
  mockEnv.env.BOOK_ORDERING_ALLOWED_EMAILS = [];
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
