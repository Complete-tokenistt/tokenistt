/**
 * tokenistt — Drizzle ORM schema (PostgreSQL).
 *
 * This is the typed model. The authoritative DDL (partitioning, BRIN, partial
 * indexes, materialized views, the partition-maintenance function) lives in
 * `0000_init.sql` / `views.sql` and should be applied with `drizzle-kit` or
 * psql. Run `drizzle-kit generate` only after reviewing that the generated SQL
 * matches `0000_init.sql` (Drizzle cannot express declarative partitioning /
 * BRIN / partial indexes, so those are owned by the hand-written migration).
 */
import {
  bigint,
  boolean,
  char,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  sql,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// 1. organizations
// ---------------------------------------------------------------------------
export const organizations = pgTable('organizations', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: text('plan').notNull().default('free'),
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// 2. users
// ---------------------------------------------------------------------------
export const users = pgTable('users', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  organizationId: bigint('organization_id', { mode: 'number' })
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  email: text('email'),
  displayName: text('display_name'),
  externalRef: text('external_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgExternalUniq: uniqueIndex('uq_users_org_ext').on(t.organizationId, t.externalRef),
}));

// ---------------------------------------------------------------------------
// 3. workspaces (teams / cost centers)
// ---------------------------------------------------------------------------
export const workspaces = pgTable('workspaces', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  organizationId: bigint('organization_id', { mode: 'number' })
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  costCenter: text('cost_center').notNull(), // "CC-4401-Support"
  budgetCapUsd: numeric('budget_cap_usd', { precision: 18, scale: 2 }),
  billingEmail: text('billing_email'),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgCcUniq: uniqueIndex('uq_ws_org_cc').on(t.organizationId, t.costCenter),
}));

// ---------------------------------------------------------------------------
// 4. virtual_keys
// ---------------------------------------------------------------------------
export const virtualKeys = pgTable('virtual_keys', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  organizationId: bigint('organization_id', { mode: 'number' })
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  workspaceId: bigint('workspace_id', { mode: 'number' }).references(() => workspaces.id, {
    onDelete: 'set null',
  }),
  ownerUserId: bigint('owner_user_id', { mode: 'number' }).references(() => users.id, {
    onDelete: 'set null',
  }),
  createdBy: bigint('created_by', { mode: 'number' }).references(() => users.id, {
    onDelete: 'set null',
  }),
  name: text('name').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  keyHash: text('key_hash').notNull(),
  budgetCapUsd: numeric('budget_cap_usd', { precision: 18, scale: 2 }),
  budgetPeriod: text('budget_period').notNull().default('monthly'),
  allowedProviders: text('allowed_providers').array(),
  status: text('status').notNull().default('active'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb('metadata').notNull().default({}),
}, (t) => ({
  orgStatusIdx: index('ix_vk_org_status').on(t.organizationId, t.status),
}));

// ---------------------------------------------------------------------------
// 5. transactions (the ledger)
// ---------------------------------------------------------------------------
export const transactions = pgTable('transactions', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid('public_id').notNull().defaultRandom(),
  organizationId: bigint('organization_id', { mode: 'number' })
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  workspaceId: bigint('workspace_id', { mode: 'number' }).references(() => workspaces.id, {
    onDelete: 'set null',
  }),
  virtualKeyId: bigint('virtual_key_id', { mode: 'number' }).references(() => virtualKeys.id, {
    onDelete: 'set null',
  }),
  userId: bigint('user_id', { mode: 'number' }).references(() => users.id, {
    onDelete: 'set null',
  }),
  actor: text('actor'),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  endpoint: text('endpoint').notNull().default('/chat/completions'),
  requestId: text('request_id'),
  costCenter: text('cost_center').notNull(),
  projectTag: text('project_tag'),
  currency: char('currency', { length: 3 }).notNull().default('USD'),

  costUsd: numeric('cost_usd', { precision: 18, scale: 6 }).notNull(),
  amortizedCostUsd: numeric('amortized_cost_usd', { precision: 18, scale: 6 })
    .notNull()
    .default(sql`0`),
  inputCostUsd: numeric('input_cost_usd', { precision: 18, scale: 6 }).notNull().default(sql`0`),
  outputCostUsd: numeric('output_cost_usd', { precision: 18, scale: 6 }).notNull().default(sql`0`),

  promptTokens: integer('prompt_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),

  status: text('status').notNull().default('success'),
  errorCode: text('error_code'),
  shadowAiFlag: boolean('shadow_ai_flag').notNull().default(false),
  durationMs: integer('duration_ms'),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Headline query: "Sarah in Support, last week"
  costCenterActorCreated: index('ix_txn_costcenter_actor_created').on(
    t.costCenter,
    t.actor,
    t.createdAt.desc(),
  ),
  workspaceCreated: index('ix_txn_workspace_created').on(t.workspaceId, t.createdAt.desc()),
  actorCreated: index('ix_txn_actor_created').on(t.actor, t.createdAt.desc()),
  providerCreated: index('ix_txn_provider_created').on(t.provider, t.createdAt.desc()),
  // Partial indexes (BRIN for time-range scans is applied in 0000_init.sql)
  shadowCreated: index('ix_txn_shadow_created').on(t.createdAt.desc())
    .where(sql`shadow_ai_flag = true`),
  projectCreated: index('ix_txn_project_created').on(t.projectTag, t.createdAt.desc())
    .where(sql`project_tag IS NOT NULL`),
  publicIdIdx: index('ix_txn_public_id').on(t.publicId),
}));

// ---------------------------------------------------------------------------
// 6. provider_invoices
// ---------------------------------------------------------------------------
export const providerInvoices = pgTable('provider_invoices', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  organizationId: bigint('organization_id', { mode: 'number' })
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  invoiceNumber: text('invoice_number'),
  invoiceDate: timestamp('invoice_date', { withTimezone: true }).notNull(),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  billedAmountUsd: numeric('billed_amount_usd', { precision: 18, scale: 2 }).notNull(),
  taxUsd: numeric('tax_usd', { precision: 18, scale: 2 }).notNull().default(sql`0`),
  creditsUsd: numeric('credits_usd', { precision: 18, scale: 2 }).notNull().default(sql`0`),
  netAmountUsd: numeric('net_amount_usd', { precision: 18, scale: 2 }).notNull(),
  documentUrl: text('document_url'),
  status: text('status').notNull().default('received'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb('metadata').notNull().default({}),
}, (t) => ({
  orgProviderInvoiceUniq: uniqueIndex('uq_inv_org_prov_num').on(
    t.organizationId,
    t.provider,
    t.invoiceNumber,
  ),
  providerPeriodIdx: index('ix_inv_provider_period').on(
    t.provider,
    t.periodStart,
    t.periodEnd,
  ),
}));
