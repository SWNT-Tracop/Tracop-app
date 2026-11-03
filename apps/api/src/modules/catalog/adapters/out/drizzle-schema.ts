import {
  bigint,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  numeric,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const catalog = pgSchema('catalog');
export const categories = catalog.table(
  'categories',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    parentId: uuid('parent_id'),
    depth: integer('depth').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('categories_parent_name_unique').on(table.parentId, sql`lower(${table.name})`),
    index('categories_parent_id_idx').on(table.parentId),
  ],
);

export const products = catalog.table(
  'products',
  {
    id: uuid('id').primaryKey(),
    categoryId: uuid('category_id').notNull(),
    name: text('name').notNull(),
    searchText: text('search_text').notNull(),
    unit: text('unit').notNull(),
    attributes: jsonb('attributes').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('products_category_name_unique').on(table.categoryId, sql`lower(${table.name})`),
    index('products_category_idx').on(table.categoryId),
    check(
      'products_unit_check',
      sql`${table.unit} IN ('kg','g','lb','und','docena','arroba','quintal','caja','mano','bulto')`,
    ),
  ],
);

export const lots = catalog.table(
  'lots',
  {
    id: uuid('id').primaryKey(),
    providerId: uuid('provider_id').notNull(),
    productId: uuid('product_id').notNull(),
    quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull(),
    unit: text('unit').notNull(),
    unitPrice: bigint('unit_price', { mode: 'bigint' }).notNull(),
    qualityGrade: text('quality_grade'),
    availableFrom: timestamp('available_from', { withTimezone: true }).notNull(),
    availableUntil: timestamp('available_until', { withTimezone: true }).notNull(),
    locationLat: doublePrecision('location_lat').notNull(),
    locationLng: doublePrecision('location_lng').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('lots_provider_status_idx').on(table.providerId, table.status),
    index('lots_product_status_idx').on(table.productId, table.status),
    index('lots_available_idx').on(table.status, table.availableUntil, table.availableFrom),
    index('lots_location_bbox_idx').on(table.locationLat, table.locationLng),
    check('lots_quantity_positive_check', sql`${table.quantity} > 0`),
    check('lots_price_positive_check', sql`${table.unitPrice} > 0`),
    check(
      'lots_status_check',
      sql`${table.status} IN ('draft','published','reserved','sold_out','expired','cancelled')`,
    ),
    check('lots_window_check', sql`${table.availableFrom} <= ${table.availableUntil}`),
  ],
);

export const lotPhotos = catalog.table(
  'lot_photos',
  {
    id: uuid('id').primaryKey(),
    lotId: uuid('lot_id').notNull(),
    mediaRef: text('media_ref').notNull(),
    state: text('state').notNull(),
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes'),
    position: integer('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    leaseToken: text('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('lot_photos_lot_id_idx').on(table.lotId),
    index('lot_photos_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.state} <> 'ready'`),
    index('lot_photos_order_idx')
      .on(table.lotId, table.position)
      .where(sql`${table.deletedAt} IS NULL`),
    check('lot_photos_state_check', sql`${table.state} IN ('pending','processing','ready')`),
    check('lot_photos_position_check', sql`${table.position} > 0`),
    check('lot_photos_size_check', sql`${table.sizeBytes} IS NULL OR ${table.sizeBytes} > 0`),
    check(
      'lot_photos_ready_metadata_check',
      sql`(${table.state} = 'ready' AND ${table.contentType} = 'image/webp' AND ${table.sizeBytes} IS NOT NULL) OR (${table.state} <> 'ready' AND ${table.contentType} IS NULL AND ${table.sizeBytes} IS NULL)`,
    ),
  ],
);
