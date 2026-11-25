import { createHash, createHmac } from 'node:crypto';
import type { Clock } from '../../../shared/kernel/clock.js';
import { DomainError, RateLimitExceeded } from '../../../shared/kernel/domain-error.js';
import { createId } from '../../../shared/kernel/ids.js';
import type { AuditWriter } from '../../../shared/ports/audit-writer.js';
import type { OutboxWriter } from '../../../shared/ports/outbox-writer.js';
import { alertMatches, newAlert, type AlertProps } from '../domain/alerts.js';
import { suggestPrice, type PriceSuggestion } from '../domain/pricing.js';
import { normalizeSourceText, parseReferenceCsv } from '../domain/reference-csv.js';
import {
  isAfter,
  rank,
  type CandidateFacts,
  type Reason,
  type ReasonWeights,
} from '../domain/scoring.js';
import type {
  CatalogFactsPort,
  OrderFactsPort,
  ProviderVerificationPort,
  RecommendationsRateLimit,
  RecommendationsRepository,
  SourceMapping,
} from '../ports/recommendations-ports.js';

export interface Actor {
  readonly sub: string;
  readonly role: string;
}

export interface RecommendationsSettings {
  readonly referenceMaxAgeDays: number;
  readonly observationWindowDays: number;
  readonly minSample: number;
  readonly minOwnObservations: number;
  readonly minOwnProviders: number;
  readonly weights: ReasonWeights;
  readonly nearbyKm: number;
  readonly freshHours: number;
  readonly candidateLimit: number;
  readonly defaultRadiusKm: number;
  readonly alertsPerUser: number;
  /** Key of the provider hash in observations (never stored). */
  readonly providerKeySecret: string;
}

export interface UnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export const DANE_CITATION =
  'Fuente: Departamento Administrativo Nacional de Estadística: www.dane.gov.co';
const PROVIDER_ROLES = new Set(['producer', 'supplier']);
const STAFF_ROLES = new Set(['operator', 'admin']);
const DAY_MS = 86_400_000;
const VERIFICATION_BATCH = 50;

export interface SuggestionView {
  readonly productId: string;
  readonly unit: string;
  readonly suggestion: PriceSuggestion;
  readonly citation: string | null;
}

export interface RecommendedLot {
  readonly lotId: string;
  readonly productId: string;
  readonly unit: string;
  readonly unitPrice: bigint;
  readonly distanceKm: number | null;
  readonly score: number;
  readonly reasons: readonly Reason[];
}

export interface RecommendationPage {
  readonly items: readonly RecommendedLot[];
  readonly next: { readonly score: number; readonly lotId: string } | null;
}

/**
 * Price suggestions, lot recommendations and price alerts. Rules and statistics only, with
 * the reasons as codes; it reads other modules only through ports adapted in bootstrap.
 */
export class RecommendationsService {
  constructor(
    private readonly repository: RecommendationsRepository,
    private readonly catalog: CatalogFactsPort,
    private readonly orders: OrderFactsPort,
    private readonly providers: ProviderVerificationPort,
    private readonly outbox: OutboxWriter,
    private readonly audit: AuditWriter,
    private readonly rateLimit: RecommendationsRateLimit,
    private readonly uow: UnitOfWork,
    private readonly settings: RecommendationsSettings,
    private readonly clock: Clock,
  ) {}

  // ----------------------------------------------------------------- pricing

  async suggestion(actor: Actor, productId: string, unit: string): Promise<SuggestionView> {
    if (!PROVIDER_ROLES.has(actor.role)) throw new DomainError('No autorizado.', 'forbidden');
    this.limit(`pricing:${actor.sub}`);
    return this.suggestionFor(productId, unit);
  }

  /** Also used by the AI assistant's PriceSuggestionPort. */
  async suggestionFor(productId: string, unit: string): Promise<SuggestionView> {
    const productUnit = await this.catalog.productUnit(productId);
    if (!productUnit) throw new DomainError('Producto no encontrado.', 'not_found');
    // A unit other than the product's has no data: no equivalence is assumed.
    if (unit !== productUnit)
      return { productId, unit, suggestion: { status: 'insufficient_data' }, citation: null };
    const now = this.clock.now();
    const since = new Date(now.getTime() - this.settings.referenceMaxAgeDays * DAY_MS);
    const [reference, own] = await Promise.all([
      this.repository.referencePrices(productId, unit, since.toISOString().slice(0, 10)),
      this.repository.observations(
        productId,
        unit,
        new Date(now.getTime() - this.settings.observationWindowDays * DAY_MS),
      ),
    ]);
    const suggestion = suggestPrice(reference, own, this.settings);
    const usesDane =
      suggestion.status === 'ok' && suggestion.sources.some(({ name }) => name === 'DANE-SIPSA');
    return { productId, unit, suggestion, citation: usesDane ? DANE_CITATION : null };
  }

  // ---------------------------------------------------------- recommendations

  async recommendLots(
    actor: Actor,
    query: {
      readonly lat?: number;
      readonly lng?: number;
      readonly radiusKm?: number;
      readonly limit: number;
      readonly after?: { readonly score: number; readonly lotId: string };
    },
  ): Promise<RecommendationPage> {
    if (actor.role !== 'buyer') throw new DomainError('No autorizado.', 'forbidden');
    this.limit(`recommendations:${actor.sub}`);
    const point =
      query.lat !== undefined && query.lng !== undefined
        ? {
            lat: query.lat,
            lng: query.lng,
            radiusKm: query.radiusKm ?? this.settings.defaultRadiusKm,
          }
        : {};
    const lots = (
      await this.catalog.availableLots({ ...point, limit: this.settings.candidateLimit })
    ).filter(({ providerId }) => providerId !== actor.sub);
    const purchased = await this.repository.purchasedProducts(actor.sub);
    const verified = await this.verifiedAmong([
      ...new Set(lots.map(({ providerId }) => providerId)),
    ]);
    const medians = new Map<string, bigint | null>();
    for (const key of new Set(lots.map(({ productId, unit }) => `${productId}|${unit}`))) {
      const [productId, unit] = key.split('|') as [string, string];
      const view = await this.suggestionFor(productId, unit).catch(() => null);
      medians.set(key, view?.suggestion.status === 'ok' ? view.suggestion.median : null);
    }
    const candidates: CandidateFacts[] = lots.map((lot) => ({
      lotId: lot.lotId,
      productId: lot.productId,
      unitPrice: lot.unitPrice,
      availableFrom: lot.availableFrom,
      distanceKm: lot.distanceKm,
      providerVerified: verified.has(lot.providerId),
      referenceMedian: medians.get(`${lot.productId}|${lot.unit}`) ?? null,
    }));
    const ranked = rank(candidates, {
      purchasedProductIds: purchased,
      now: this.clock.now(),
      nearbyKm: this.settings.nearbyKm,
      freshHours: this.settings.freshHours,
      weights: this.settings.weights,
    });
    const after = query.after;
    const remaining = after ? ranked.filter((lot) => isAfter(lot, after)) : ranked;
    const page = remaining.slice(0, query.limit);
    const byId = new Map(lots.map((lot) => [lot.lotId, lot]));
    const last = page.at(-1);
    return {
      items: page.map((scored) => {
        const lot = byId.get(scored.lotId)!;
        return {
          lotId: lot.lotId,
          productId: lot.productId,
          unit: lot.unit,
          unitPrice: lot.unitPrice,
          distanceKm: lot.distanceKm,
          score: scored.score,
          reasons: scored.reasons,
        };
      }),
      next:
        last && remaining.length > page.length ? { score: last.score, lotId: last.lotId } : null,
    };
  }

  private async verifiedAmong(providerIds: readonly string[]): Promise<ReadonlySet<string>> {
    const verified = new Set<string>();
    for (let start = 0; start < providerIds.length; start += VERIFICATION_BATCH)
      for (const id of await this.providers.verified(
        providerIds.slice(start, start + VERIFICATION_BATCH),
      ))
        verified.add(id);
    return verified;
  }

  // ------------------------------------------------------------------ alerts

  async createAlert(
    actor: Actor,
    input: {
      readonly id: string;
      readonly productId: string;
      readonly maxPrice: bigint;
      readonly radiusKm: number;
      readonly lat: number;
      readonly lng: number;
    },
  ): Promise<{ readonly alert: AlertProps; readonly created: boolean }> {
    if (actor.role !== 'buyer') throw new DomainError('No autorizado.', 'forbidden');
    this.limit(`alerts:${actor.sub}`);
    if (!(await this.catalog.productUnit(input.productId)))
      throw new DomainError('Producto no encontrado.', 'not_found');
    const alert = newAlert({ ...input, buyerId: actor.sub, now: this.clock.now() });
    return this.uow.run(async () => {
      await this.repository.lockBuyer(actor.sub);
      const existing = await this.repository.findAlert(alert.id);
      if (existing) {
        const same =
          existing.buyerId === actor.sub &&
          !existing.deleted &&
          existing.productId === alert.productId &&
          existing.maxPrice === alert.maxPrice &&
          existing.radiusKm === alert.radiusKm &&
          existing.centerLat === alert.centerLat &&
          existing.centerLng === alert.centerLng;
        if (!same) throw new DomainError('Esa alerta ya existe.', 'alert_conflict');
        return { alert: existing, created: false };
      }
      if ((await this.repository.countAlerts(actor.sub)) >= this.settings.alertsPerUser)
        throw new DomainError('Llegaste al máximo de alertas.', 'alert_limit');
      await this.repository.insertAlert(alert);
      return { alert, created: true };
    });
  }

  async listAlerts(actor: Actor): Promise<readonly AlertProps[]> {
    if (actor.role !== 'buyer') throw new DomainError('No autorizado.', 'forbidden');
    return this.repository.listAlerts(actor.sub);
  }

  /** Another buyer's alert is not found (404), never forbidden. */
  async deleteAlert(actor: Actor, id: string): Promise<void> {
    if (actor.role !== 'buyer') throw new DomainError('No autorizado.', 'forbidden');
    if (!(await this.repository.deleteAlert(id, actor.sub, this.clock.now())))
      throw new DomainError('Alerta no encontrada.', 'not_found');
  }

  /** LotPublished: one PriceAlertMatched per matching (alert, lot), however often it is delivered. */
  async matchAlerts(lotId: string): Promise<number> {
    const lot = await this.catalog.publishedLot(lotId);
    if (!lot) return 0;
    const alerts = (await this.repository.alertsForProduct(lot.productId)).filter((alert) =>
      alertMatches(alert, lot),
    );
    let matched = 0;
    for (const alert of alerts) {
      const now = this.clock.now();
      const created = await this.uow.run(async () => {
        if (!(await this.repository.recordMatch(alert.id, lot.lotId, now))) return false;
        await this.outbox.append([
          {
            aggregate: `alert:${alert.id}`,
            type: 'PriceAlertMatched',
            payload: {
              buyerId: alert.buyerId,
              alertId: alert.id,
              lotId: lot.lotId,
              amount: lot.unitPrice.toString(),
            },
          },
        ]);
        return true;
      });
      if (created) matched += 1;
    }
    return matched;
  }

  // ------------------------------------------------------------ observations

  private lineKey(lineId: string): string {
    return createHash('sha256').update(`recommendations.order-line:${lineId}`).digest('hex');
  }

  private providerKey(providerId: string): string {
    return createHmac('sha256', this.settings.providerKeySecret)
      .update(`recommendations.provider:${providerId}`)
      .digest('hex');
  }

  /** OrderAccepted: price observations (no person ids) and the buyer's own history, once. */
  async recordAcceptedOrder(orderId: string): Promise<boolean> {
    const order = await this.orders.order(orderId);
    if (!order) return false;
    const observations: Parameters<
      RecommendationsRepository['recordOrder']
    >[0]['observations'][number][] = [];
    for (const line of order.lines) {
      const product = await this.catalog.lotProduct(line.lotId);
      if (!product || product.unit !== line.unit) continue;
      observations.push({
        id: createId(),
        orderLineKey: this.lineKey(line.lineId),
        productId: product.productId,
        unit: line.unit,
        unitPrice: line.unitPrice,
        providerKey: this.providerKey(order.providerId),
      });
    }
    return this.uow.run(() =>
      this.repository.recordOrder({
        orderId,
        buyerId: order.buyerId,
        at: order.acceptedAt,
        observations,
      }),
    );
  }

  /** Order delivered: its observations are marked as completed sales. */
  async recordDeliveredOrder(orderId: string): Promise<number> {
    const order = await this.orders.order(orderId);
    if (!order) return 0;
    return this.repository.markDelivered(
      order.lines.map(({ lineId }) => this.lineKey(lineId)),
      this.clock.now(),
    );
  }

  // ------------------------------------------------------- reference prices

  /** CLI: imports a reference CSV once per file content; serialized per file. */
  async importReferencePrices(
    content: string,
  ): Promise<
    | { readonly status: 'imported'; readonly rows: number }
    | { readonly status: 'already_imported'; readonly rows: number }
    | { readonly status: 'invalid'; readonly errors: readonly string[] }
  > {
    const parsed = parseReferenceCsv(content);
    if (!parsed.ok) return { status: 'invalid', errors: parsed.errors };
    const fileSha256 = createHash('sha256').update(content).digest('hex');
    return this.uow.run(async () => {
      await this.repository.lockImport(fileSha256);
      const existing = await this.repository.findImport(fileSha256);
      if (existing) return { status: 'already_imported' as const, rows: existing.rows };
      const rows = await this.repository.insertImport({
        id: createId(),
        fileSha256,
        rows: parsed.rows,
        importedAt: this.clock.now(),
      });
      return { status: 'imported' as const, rows };
    });
  }

  async listMappings(actor: Actor, productId?: string): Promise<readonly SourceMapping[]> {
    this.requireStaff(actor);
    return this.repository.mappings(productId);
  }

  async createMapping(
    actor: Actor,
    input: {
      readonly id: string;
      readonly productId: string;
      readonly sourceProduct: string;
      readonly presentation: string;
    },
  ): Promise<SourceMapping> {
    this.requireStaff(actor);
    const unit = await this.catalog.productUnit(input.productId);
    if (!unit) throw new DomainError('Producto no encontrado.', 'not_found');
    const mapping: SourceMapping = {
      id: input.id,
      productId: input.productId,
      unit,
      source: 'DANE-SIPSA',
      // Stored and matched folded (case, accents, spaces), as the imported rows are.
      sourceProduct: normalizeSourceText(input.sourceProduct),
      presentation: normalizeSourceText(input.presentation),
      createdAt: this.clock.now(),
    };
    return this.uow.run(async () => {
      if (!(await this.repository.insertMapping({ ...mapping, createdBy: actor.sub })))
        throw new DomainError('Esa asociación ya existe.', 'mapping_conflict');
      await this.audit.record({
        actorId: actor.sub,
        actorRole: actor.role,
        action: 'pricing.mapping.create',
        entity: 'product_source_mapping',
        entityId: mapping.id,
        before: null,
        after: {
          productId: mapping.productId,
          unit,
          sourceProduct: mapping.sourceProduct,
          presentation: mapping.presentation,
        },
      });
      return mapping;
    });
  }

  async deleteMapping(actor: Actor, id: string): Promise<void> {
    this.requireStaff(actor);
    await this.uow.run(async () => {
      const deleted = await this.repository.deleteMapping(id);
      if (!deleted) throw new DomainError('Asociación no encontrada.', 'not_found');
      await this.audit.record({
        actorId: actor.sub,
        actorRole: actor.role,
        action: 'pricing.mapping.delete',
        entity: 'product_source_mapping',
        entityId: id,
        before: {
          productId: deleted.productId,
          sourceProduct: deleted.sourceProduct,
          presentation: deleted.presentation,
        },
        after: null,
      });
    });
  }

  private requireStaff(actor: Actor): void {
    if (!STAFF_ROLES.has(actor.role)) throw new DomainError('No autorizado.', 'forbidden');
  }

  private limit(key: string): void {
    const retryAfter = this.rateLimit.take(key);
    if (retryAfter > 0) throw new RateLimitExceeded(retryAfter);
  }
}
