import {
  pgEnum,
  pgTable,
  text,
  boolean,
  timestamp,
  uuid,
  integer,
  jsonb,
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

/** Per-family access level (authz). */
export const accessRole = pgEnum('access_role', ['owner', 'contributor', 'viewer']);
/** Global kinship edge types between people. */
export const relationshipType = pgEnum('relationship_type', ['parent', 'spouse']);
export const inputType = pgEnum('input_type', ['text', 'voice', 'chat']);
export const storyStatus = pgEnum('story_status', ['draft', 'processing', 'ready', 'failed']);
export const datePrecision = pgEnum('date_precision', ['day', 'month', 'year', 'circa']);
export const gender = pgEnum('gender', ['male', 'female']);
export const assetKind = pgEnum('asset_kind', ['audio', 'photo']);
export const messageRole = pgEnum('message_role', ['user', 'assistant', 'system', 'tool']);

/* ──────────────────────────────────────────────────────────────────────────
 * Genealogy layer (global, family-agnostic): people + kinship edges
 * ────────────────────────────────────────────────────────────────────────── */

/** A person — a node in the family graph. May or may not have an app account. */
export const people = pgTable(
  'people',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    displayName: text('display_name').notNull(),
    givenName: text('given_name'),
    /** Surname lives on the person, independent of any family. */
    familyName: text('family_name'),
    /** Optional link to an app account (most people never log in). */
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    gender: gender('gender'),
    bornOn: timestamp('born_on'),
    bornPrecision: datePrecision('born_precision'),
    diedOn: timestamp('died_on'),
    diedPrecision: datePrecision('died_precision'),
    avatarS3Key: text('avatar_s3_key'),
    notes: text('notes'),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('people_user_uq').on(t.userId)],
);

/** Global kinship edge. `parent`: from = parent, to = child. `spouse`: symmetric. */
export const relationships = pgTable(
  'relationships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: relationshipType('type').notNull(),
    personFromId: uuid('person_from_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    personToId: uuid('person_to_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('relationships_uq').on(t.type, t.personFromId, t.personToId),
    index('relationships_from_idx').on(t.personFromId),
    index('relationships_to_idx').on(t.personToId),
  ],
);

/* ──────────────────────────────────────────────────────────────────────────
 * Family layer: a named sharing circle + its tree membership
 * ────────────────────────────────────────────────────────────────────────── */

/** A family = a named sharing circle (name is a label, NOT unique). */
export const families = pgTable('families', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  /** Free-text writing-style guide, injected into the styling prompt. */
  styleGuide: text('style_guide'),
  createdBy: text('created_by')
    .notNull()
    .references(() => user.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

/** USER access to a family (authz) — separate from being a tree node. */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessRole: accessRole('access_role').notNull().default('contributor'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('memberships_family_user_uq').on(t.familyId, t.userId)],
);

/** Which PEOPLE are nodes in a family's tree (person↔family, many-to-many). */
export const familyMembers = pgTable(
  'family_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    /** Optional display override; role is normally derived from the tree. */
    roleLabel: text('role_label'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('family_members_uq').on(t.familyId, t.personId),
    index('family_members_family_idx').on(t.familyId),
  ],
);

/** Pending email invitations to join a family (grants a membership). */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    accessRole: accessRole('access_role').notNull().default('contributor'),
    token: text('token').notNull().unique(),
    invitedBy: text('invited_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at').notNull(),
    acceptedAt: timestamp('accepted_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('invitations_family_idx').on(t.familyId)],
);

/* ──────────────────────────────────────────────────────────────────────────
 * Stories — standalone, shareable across many families
 * ────────────────────────────────────────────────────────────────────────── */

export const conversations = pgTable('conversations', {
  id: uuid('id').defaultRandom().primaryKey(),
  /** Family context the chat was started in (nullable = "all"). */
  familyId: uuid('family_id').references(() => families.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  title: text('title'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: messageRole('role').notNull(),
    content: text('content').notNull(),
    /** Structured extras for rendering (e.g. applied-action receipts). */
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId)],
);

/** A single story. No longer bound to one family — see story_families. */
export const stories = pgTable(
  'stories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    submittedBy: text('submitted_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    /** Short "what it's about" abstract. */
    summary: text('summary'),
    /** Raw text or the verbatim transcript. */
    bodyOriginal: text('body_original'),
    /** AI-styled, third-person memoir version. */
    bodyStyled: text('body_styled'),
    inputType: inputType('input_type').notNull(),
    status: storyStatus('status').notNull().default('draft'),
    errorMessage: text('error_message'),
    eventDate: timestamp('event_date'),
    eventDatePrecision: datePrecision('event_date_precision'),
    /** The chat this story came from, if any. */
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [index('stories_event_date_idx').on(t.eventDate)],
);

/** A story is shared into every family linked here (≥1). */
export const storyFamilies = pgTable(
  'story_families',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    sharedBy: text('shared_by').references(() => user.id, { onDelete: 'set null' }),
    sharedAt: timestamp('shared_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('story_families_uq').on(t.storyId, t.familyId),
    index('story_families_family_idx').on(t.familyId),
  ],
);

/** Who/what a story is about. */
export const storyPeople = pgTable(
  'story_people',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('story_people_uq').on(t.storyId, t.personId)],
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

/** In-chat uploads (voice/photos) before a story is accepted. */
export const messageAttachments = pgTable(
  'message_attachments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    kind: assetKind('kind').notNull(),
    s3Key: text('s3_key').notNull(),
    mimeType: text('mime_type').notNull(),
    bytes: integer('bytes'),
    width: integer('width'),
    height: integer('height'),
    durationSec: integer('duration_sec'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('message_attachments_message_idx').on(t.messageId)],
);
