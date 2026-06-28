import {
  pgEnum,
  pgTable,
  text,
  boolean,
  timestamp,
  uuid,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/* ──────────────────────────────────────────────────────────────────────────
 * Auth tables (managed by better-auth's Drizzle adapter)
 * Column/table names follow better-auth defaults — keep them in sync.
 * ────────────────────────────────────────────────────────────────────────── */

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

/* ──────────────────────────────────────────────────────────────────────────
 * Domain enums
 * ────────────────────────────────────────────────────────────────────────── */

export const membershipRole = pgEnum('membership_role', ['owner', 'editor', 'viewer']);
export const inputType = pgEnum('input_type', ['text', 'voice']);
export const storyStatus = pgEnum('story_status', ['draft', 'processing', 'ready', 'failed']);
export const datePrecision = pgEnum('date_precision', ['day', 'month', 'year', 'circa']);
export const assetKind = pgEnum('asset_kind', ['audio', 'photo']);

/* ──────────────────────────────────────────────────────────────────────────
 * Domain tables
 * ────────────────────────────────────────────────────────────────────────── */

/** A family vault. */
export const chronicles = pgTable('chronicles', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  /** Free-text style guide the family writes; injected into the styling prompt. */
  styleGuide: text('style_guide'),
  createdBy: text('created_by')
    .notNull()
    .references(() => user.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

/** Which users belong to which chronicle, and their role. */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    chronicleId: uuid('chronicle_id')
      .notNull()
      .references(() => chronicles.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: membershipRole('role').notNull().default('editor'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('memberships_chronicle_user_uq').on(t.chronicleId, t.userId)],
);

/** Pending email invitations to join a chronicle. */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    chronicleId: uuid('chronicle_id')
      .notNull()
      .references(() => chronicles.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: membershipRole('role').notNull().default('editor'),
    token: text('token').notNull().unique(),
    invitedBy: text('invited_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at').notNull(),
    acceptedAt: timestamp('accepted_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('invitations_chronicle_idx').on(t.chronicleId)],
);

/** Optional grouping so several members' tellings of one occurrence link together. */
export const events = pgTable(
  'events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    chronicleId: uuid('chronicle_id')
      .notNull()
      .references(() => chronicles.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    approxDate: timestamp('approx_date'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('events_chronicle_idx').on(t.chronicleId)],
);

/** A single story in a chronicle. */
export const stories = pgTable(
  'stories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    chronicleId: uuid('chronicle_id')
      .notNull()
      .references(() => chronicles.id, { onDelete: 'cascade' }),
    submittedBy: text('submitted_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    /** Raw text or the verbatim transcript. */
    bodyOriginal: text('body_original'),
    /** AI-styled, third-person memoir version. */
    bodyStyled: text('body_styled'),
    inputType: inputType('input_type').notNull(),
    status: storyStatus('status').notNull().default('draft'),
    /** Error detail when status = 'failed'. */
    errorMessage: text('error_message'),
    /** When the events of the story took place (nullable for unknown). */
    eventDate: timestamp('event_date'),
    eventDatePrecision: datePrecision('event_date_precision'),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('stories_chronicle_idx').on(t.chronicleId),
    index('stories_event_date_idx').on(t.eventDate),
  ],
);

/** Raw inputs kept for traceability: original voice messages and photos. */
export const assets = pgTable(
  'assets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    kind: assetKind('kind').notNull(),
    s3Key: text('s3_key').notNull(),
    mimeType: text('mime_type').notNull(),
    bytes: integer('bytes'),
    caption: text('caption'),
    width: integer('width'),
    height: integer('height'),
    durationSec: integer('duration_sec'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('assets_story_idx').on(t.storyId)],
);
