import { bigint, integer, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const payments = pgSchema('payments');

const money = (name: string) => bigint(name, { mode: 'bigint' }).notNull();
const at = (name: string) => timestamp(name, { withTimezone: true });

export const paymentsTable = payments.table('payments', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id').notNull(),
  buyerId: uuid('buyer_id').notNull(),
  providerId: uuid('provider_id').notNull(),
  method: text('method').notNull(),
  status: text('status').notNull(),
  subtotal: money('subtotal'),
  freight: money('freight'),
  commission: money('commission'),
  total: money('total'),
  providerNet: money('provider_net'),
  version: integer('version').notNull(),
  proofIncomingKey: text('proof_incoming_key'),
  proofUploadExpiresAt: at('proof_upload_expires_at'),
  proofKey: text('proof_key'),
  proofUploadedAt: at('proof_uploaded_at'),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: at('reviewed_at'),
  rejectionReason: text('rejection_reason'),
  heldAt: at('held_at'),
  carrierId: uuid('carrier_id'),
  disputeReason: text('dispute_reason'),
  createdAt: at('created_at').notNull(),
  updatedAt: at('updated_at').notNull(),
});

export const paymentEvents = payments.table('payment_events', {
  id: uuid('id').primaryKey(),
  paymentId: uuid('payment_id').notNull(),
  orderId: uuid('order_id').notNull(),
  type: text('type').notNull(),
  actorId: uuid('actor_id'),
  payload: jsonb('payload').notNull(),
  occurredAt: at('occurred_at').notNull(),
});

export const ledgerTransactions = payments.table('ledger_transactions', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id').notNull(),
  paymentId: uuid('payment_id').notNull(),
  kind: text('kind').notNull(),
  createdAt: at('created_at').notNull(),
});

export const ledgerEntries = payments.table('ledger_entries', {
  id: uuid('id').primaryKey(),
  transactionId: uuid('transaction_id').notNull(),
  orderId: uuid('order_id').notNull(),
  account: text('account').notNull(),
  debit: money('debit'),
  credit: money('credit'),
  createdAt: at('created_at').notNull(),
});

export const settlementsTable = payments.table('settlements', {
  id: uuid('id').primaryKey(),
  paymentId: uuid('payment_id').notNull(),
  orderId: uuid('order_id').notNull(),
  beneficiaryId: uuid('beneficiary_id').notNull(),
  beneficiaryKind: text('beneficiary_kind').notNull(),
  amount: money('amount'),
  status: text('status').notNull(),
  issuedAt: at('issued_at').notNull(),
  paidAt: at('paid_at'),
  paidBy: uuid('paid_by'),
  reference: text('reference'),
  version: integer('version').notNull(),
});
