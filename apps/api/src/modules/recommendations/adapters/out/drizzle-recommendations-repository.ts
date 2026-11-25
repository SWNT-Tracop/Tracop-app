import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../../../shared/infra/database.js';
import type { AlertProps } from '../../domain/alerts.js';
import type { Observation } from '../../domain/pricing.js';
import { normalizeSourceText, type ReferenceRow } from '../../domain/reference-csv.js';
import type {
  RecommendationsRepository,
  SourceMapping,
} from '../../ports/recommendations-ports.js';

type Row = Record<string, unknown>;
const INSERT_BATCH = 500;

const toAlert = (row: Row): AlertProps => ({
  id: String(row.id),
  buyerId: String(row.buyer_id),
  productId: String(row.product_id),
  maxPrice: BigInt(String(row.max_price)),
  radiusKm: Number(row.radius_km),
  centerLat: Number(row.center_lat),
  centerLng: Number(row.center_lng),
  createdAt: new Date(row.created_at as string),
});

const toMapping = (row: Row): SourceMapping => ({
  id: String(row.id),
  productId: String(row.product_id),
  unit: String(row.unit),
  source: 'DANE-SIPSA',
  sourceProduct: String(row.source_product),
  presentation: String(row.presentation),
  createdAt: new Date(row.created_at as string),
});

@Injectable()
export class DrizzleRecommendationsRepository implements RecommendationsRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private async rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await this.database.current().execute(query)).rows as Row[];
  }

  async lockImport(fileSha256: string): Promise<void> {
    await this.rows(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`recommendations.import:${fileSha256}`}))`,
    );
  }

  async findImport(fileSha256: string) {
    const [row] = await this.rows(sql`
      SELECT id, rows_imported FROM recommendations.reference_imports WHERE file_sha256 = ${fileSha256}`);
    return row ? { id: String(row.id), rows: Number(row.rows_imported) } : null;
  }

  async insertImport(input: {
    readonly id: string;
    readonly fileSha256: string;
    readonly rows: readonly ReferenceRow[];
    readonly importedAt: Date;
  }): Promise<number> {
    const at = input.importedAt.toISOString();
    await this.rows(sql`
      INSERT INTO recommendations.reference_imports (id, source, file_sha256, rows_imported, imported_at)
      VALUES (${input.id}::uuid, 'DANE-SIPSA', ${input.fileSha256}, 0, ${at}::timestamptz)`);
    let inserted = 0;
    for (let start = 0; start < input.rows.length; start += INSERT_BATCH) {
      const batch = input.rows.slice(start, start + INSERT_BATCH);
      const values = sql.join(
        batch.map(
          (
            row,
          ) => sql`(${randomUUID()}::uuid, 'DANE-SIPSA', ${row.market}, ${normalizeSourceText(row.sourceProduct)},
            ${normalizeSourceText(row.presentation)}, ${row.price.toString()}::bigint, ${row.observedOn}::date,
            ${at}::timestamptz, ${input.id}::uuid)`,
        ),
        sql`, `,
      );
      // An observation already imported from another file is kept as it was.
      const result = await this.rows(sql`
        INSERT INTO recommendations.reference_prices
          (id, source, market, source_product, presentation, price, observed_on, imported_at, import_id)
        VALUES ${values}
        ON CONFLICT (source, market, source_product, presentation, observed_on) DO NOTHING
        RETURNING id`);
      inserted += result.length;
    }
    await this.rows(sql`
      UPDATE recommendations.reference_imports SET rows_imported = ${inserted} WHERE id = ${input.id}::uuid`);
    return inserted;
  }

  async mappings(productId?: string): Promise<readonly SourceMapping[]> {
    const rows = productId
      ? await this.rows(sql`
          SELECT * FROM recommendations.product_source_mappings WHERE product_id = ${productId}::uuid
          ORDER BY created_at, id`)
      : await this.rows(
          sql`SELECT * FROM recommendations.product_source_mappings ORDER BY created_at, id`,
        );
    return rows.map(toMapping);
  }

  async insertMapping(mapping: SourceMapping & { readonly createdBy: string }): Promise<boolean> {
    const rows = await this.rows(sql`
      INSERT INTO recommendations.product_source_mappings
        (id, product_id, unit, source, source_product, presentation, created_by, created_at)
      VALUES (${mapping.id}::uuid, ${mapping.productId}::uuid, ${mapping.unit}, ${mapping.source},
        ${normalizeSourceText(mapping.sourceProduct)}, ${normalizeSourceText(mapping.presentation)},
        ${mapping.createdBy}::uuid, ${mapping.createdAt.toISOString()}::timestamptz)
      ON CONFLICT DO NOTHING
      RETURNING id`);
    return rows.length === 1;
  }

  async deleteMapping(id: string): Promise<SourceMapping | null> {
    const [row] = await this.rows(sql`
      DELETE FROM recommendations.product_source_mappings WHERE id = ${id}::uuid RETURNING *`);
    return row ? toMapping(row) : null;
  }

  async referencePrices(productId: string, unit: string, since: string) {
    const rows = await this.rows(sql`
      SELECT r.price::text AS price, r.observed_on::text AS observed_on
      FROM recommendations.reference_prices r
      JOIN recommendations.product_source_mappings m
        ON m.source = r.source AND m.source_product = r.source_product AND m.presentation = r.presentation
      WHERE m.product_id = ${productId}::uuid AND m.unit = ${unit} AND r.observed_on >= ${since}::date`);
    return rows.map((row) => ({
      price: BigInt(String(row.price)),
      observedAt: new Date(`${String(row.observed_on)}T00:00:00.000Z`),
    }));
  }

  async observations(
    productId: string,
    unit: string,
    since: Date,
  ): Promise<readonly Observation[]> {
    const rows = await this.rows(sql`
      SELECT unit_price::text AS unit_price, observed_at, provider_key
      FROM recommendations.price_observations
      WHERE product_id = ${productId}::uuid AND unit = ${unit} AND observed_at >= ${since.toISOString()}::timestamptz`);
    return rows.map((row) => ({
      unitPrice: BigInt(String(row.unit_price)),
      observedAt: new Date(row.observed_at as string),
      providerKey: String(row.provider_key),
    }));
  }

  async recordOrder(
    input: Parameters<RecommendationsRepository['recordOrder']>[0],
  ): Promise<boolean> {
    const at = input.at.toISOString();
    const counted = await this.rows(sql`
      INSERT INTO recommendations.counted_orders (order_id, counted_at)
      VALUES (${input.orderId}::uuid, ${at}::timestamptz) ON CONFLICT DO NOTHING RETURNING order_id`);
    if (counted.length === 0) return false;
    for (const observation of input.observations) {
      await this.rows(sql`
        INSERT INTO recommendations.price_observations
          (id, order_line_key, product_id, unit, unit_price, provider_key, observed_at)
        VALUES (${observation.id}::uuid, ${observation.orderLineKey}, ${observation.productId}::uuid,
          ${observation.unit}, ${observation.unitPrice.toString()}::bigint, ${observation.providerKey},
          ${at}::timestamptz)
        ON CONFLICT (order_line_key) DO NOTHING`);
    }
    for (const productId of new Set(input.observations.map((item) => item.productId))) {
      await this.rows(sql`
        INSERT INTO recommendations.buyer_history (buyer_id, product_id, orders_count, last_ordered_at)
        VALUES (${input.buyerId}::uuid, ${productId}::uuid, 1, ${at}::timestamptz)
        ON CONFLICT (buyer_id, product_id) DO UPDATE
        SET orders_count = recommendations.buyer_history.orders_count + 1,
            last_ordered_at = GREATEST(recommendations.buyer_history.last_ordered_at, EXCLUDED.last_ordered_at)`);
    }
    return true;
  }

  async markDelivered(orderLineKeys: readonly string[], at: Date): Promise<number> {
    if (orderLineKeys.length === 0) return 0;
    const rows = await this.rows(sql`
      UPDATE recommendations.price_observations SET delivered_at = ${at.toISOString()}::timestamptz
      WHERE delivered_at IS NULL
        AND order_line_key IN (${sql.join(
          orderLineKeys.map((key) => sql`${key}`),
          sql`, `,
        )})
      RETURNING id`);
    return rows.length;
  }

  async purchasedProducts(buyerId: string): Promise<ReadonlySet<string>> {
    const rows = await this.rows(sql`
      SELECT product_id FROM recommendations.buyer_history WHERE buyer_id = ${buyerId}::uuid`);
    return new Set(rows.map((row) => String(row.product_id)));
  }

  async lockBuyer(buyerId: string): Promise<void> {
    await this.rows(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`recommendations.buyer:${buyerId}`}))`,
    );
  }

  async countAlerts(buyerId: string): Promise<number> {
    const [row] = await this.rows(sql`
      SELECT count(*)::int AS alerts FROM recommendations.price_alerts
      WHERE buyer_id = ${buyerId}::uuid AND deleted_at IS NULL`);
    return Number(row?.alerts ?? 0);
  }

  async insertAlert(alert: AlertProps): Promise<'created' | 'exists'> {
    const rows = await this.rows(sql`
      INSERT INTO recommendations.price_alerts
        (id, buyer_id, product_id, max_price, radius_km, center_lat, center_lng, created_at)
      VALUES (${alert.id}::uuid, ${alert.buyerId}::uuid, ${alert.productId}::uuid, ${alert.maxPrice.toString()}::bigint,
        ${alert.radiusKm}, ${alert.centerLat}, ${alert.centerLng}, ${alert.createdAt.toISOString()}::timestamptz)
      ON CONFLICT (id) DO NOTHING
      RETURNING id`);
    return rows.length === 1 ? 'created' : 'exists';
  }

  async findAlert(id: string) {
    const [row] = await this.rows(
      sql`SELECT * FROM recommendations.price_alerts WHERE id = ${id}::uuid`,
    );
    return row ? { ...toAlert(row), deleted: row.deleted_at !== null } : null;
  }

  async listAlerts(buyerId: string): Promise<readonly AlertProps[]> {
    const rows = await this.rows(sql`
      SELECT * FROM recommendations.price_alerts
      WHERE buyer_id = ${buyerId}::uuid AND deleted_at IS NULL ORDER BY created_at, id`);
    return rows.map(toAlert);
  }

  async deleteAlert(id: string, buyerId: string, at: Date): Promise<boolean> {
    const rows = await this.rows(sql`
      UPDATE recommendations.price_alerts SET deleted_at = ${at.toISOString()}::timestamptz
      WHERE id = ${id}::uuid AND buyer_id = ${buyerId}::uuid AND deleted_at IS NULL
      RETURNING id`);
    return rows.length === 1;
  }

  async alertsForProduct(productId: string): Promise<readonly AlertProps[]> {
    const rows = await this.rows(sql`
      SELECT * FROM recommendations.price_alerts
      WHERE product_id = ${productId}::uuid AND deleted_at IS NULL ORDER BY id`);
    return rows.map(toAlert);
  }

  async recordMatch(alertId: string, lotId: string, at: Date): Promise<boolean> {
    const rows = await this.rows(sql`
      INSERT INTO recommendations.alert_matches (alert_id, lot_id, matched_at)
      VALUES (${alertId}::uuid, ${lotId}::uuid, ${at.toISOString()}::timestamptz)
      ON CONFLICT DO NOTHING RETURNING alert_id`);
    return rows.length === 1;
  }
}
