import { index, integer, numeric, text, timestamp, uuid, pgSchema } from 'drizzle-orm/pg-core';

const ordering = pgSchema('ordering');

export const orders = ordering.table(
  'orders',
  {
    id: uuid('id').primaryKey(),
    buyerId: uuid('buyer_id').notNull(),
    providerId: uuid('provider_id').notNull(),
    status: text('status').notNull(),
    deliveryAddress: text('delivery_address').notNull(),
    deliveryWindow: timestamp('delivery_window', { withTimezone: true }),
    requestHash: text('request_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull().default(1),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('orders_buyer_created_idx').on(table.buyerId, table.createdAt),
    index('orders_provider_accepted_idx').on(table.providerId, table.acceptedAt),
  ],
);

export const orderLines = ordering.table(
  'order_lines',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id').notNull(),
    lotId: uuid('lot_id').notNull(),
    providerId: uuid('provider_id').notNull(),
    quantityMilli: numeric('quantity_milli', { precision: 12, scale: 3 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 20, scale: 0 }).notNull(),
    unit: text('unit').notNull(),
  },
  (table) => [
    index('order_lines_order_idx').on(table.orderId),
    index('order_lines_lot_idx').on(table.lotId),
    index('order_lines_provider_idx').on(table.providerId),
  ],
);

export const quotes = ordering.table(
  'quotes',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id').notNull(),
    subtotal: numeric('subtotal', { precision: 20, scale: 0 }).notNull(),
    freight: numeric('freight', { precision: 20, scale: 0 }).notNull(),
    commission: numeric('commission', { precision: 20, scale: 0 }).notNull(),
    total: numeric('total', { precision: 20, scale: 0 }).notNull(),
    providerNet: numeric('provider_net', { precision: 20, scale: 0 }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('quotes_order_idx').on(table.orderId),
    index('quotes_validity_idx').on(table.validUntil, table.status),
  ],
);

export const orderEvents = ordering.table(
  'order_events',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id').notNull(),
    type: text('type').notNull(),
    payload: text('payload').notNull(),
    actorId: uuid('actor_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    prevHash: text('prev_hash'),
    hash: text('hash').notNull(),
  },
  (table) => [index('order_events_order_idx').on(table.orderId, table.occurredAt)],
);
