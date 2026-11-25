import { DomainError } from '../../../shared/kernel/domain-error.js';
import type { AuditWriter } from '../../../shared/ports/audit-writer.js';
import type { OutboxWriter } from '../../../shared/ports/outbox-writer.js';
import type { ParameterReader } from '../../../shared/ports/parameter-reader.js';
import {
  nonChronologicalOrder,
  normalizeComment,
  validateScore,
  visibleRating,
  withinRatingWindow,
  type RateeKind,
  type RatingProps,
} from '../domain/rating.js';
import {
  approveVerification,
  rejectVerification,
  requestVerification,
  revokeVerification,
  unverified,
  type VerificationProps,
} from '../domain/verification.js';
import type {
  CarrierDeliveryStats,
  OrderDeliveryInfoPort,
  TrustClock,
  TrustRateLimitPort,
  TrustRepository,
  TrustUnitOfWork,
} from '../ports/trust-ports.js';

export type TrustActor = { readonly sub: string; readonly role: string };

const PROVIDER_ROLES: readonly string[] = ['producer', 'supplier'];
const STAFF_ROLES: readonly string[] = ['operator', 'admin'];
export const MAX_TRUST_BATCH = 50;

/** Same answer for every rating that cannot be created again, so nothing leaks. */
const ratingConflict = () =>
  new DomainError('Esa calificación ya fue registrada.', 'rating_conflict');
const notFound = () => new DomainError('Pedido no encontrado.', 'not_found');

export interface ProviderTrust {
  readonly verified: boolean;
  /** One-decimal average as text ("4.3"), null below the visibility minimum. */
  readonly rating: string | null;
  readonly ratingsCount: number;
}

export interface MyReputation {
  readonly rating: string | null;
  readonly ratingsCount: number;
  /** Comment texts only, in a stable non-chronological order; empty below the minimum. */
  readonly comments: readonly string[];
  readonly verification: VerificationProps['status'] | null;
}

export class TrustService {
  constructor(
    private readonly repository: TrustRepository,
    private readonly deliveries: OrderDeliveryInfoPort,
    private readonly parameters: ParameterReader,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly ratingRateLimit: TrustRateLimitPort,
    private readonly verificationRateLimit: TrustRateLimitPort,
    private readonly uow: TrustUnitOfWork,
    private readonly clock: TrustClock,
  ) {}

  /**
   * The buyer rates the provider or the delivering carrier of a delivered and paid order within
   * the rating window. Idempotent by id; any other repeat is the same generic 409.
   */
  async submitRating(
    actor: TrustActor,
    input: {
      readonly id: string;
      readonly orderId: string;
      readonly ratee: RateeKind;
      readonly score: number;
      readonly comment?: string | null | undefined;
    },
  ): Promise<{ readonly created: boolean; readonly rating: RatingProps }> {
    if (actor.role !== 'buyer') throw new DomainError('Rol no autorizado.', 'forbidden');
    const now = this.clock.now();
    this.ratingRateLimit.consume(actor.sub, now);
    const score = validateScore(input.score);
    const comment = normalizeComment(
      input.comment,
      Number(await this.parameters.get('trust.comment_max_length')),
    );
    const info = await this.deliveries.get(input.orderId);
    // Someone else's order, one not delivered, not paid, out of the window or without that
    // ratee all look the same: not found.
    if (!info || info.buyerId !== actor.sub || !info.deliveredAt || !info.paymentVerified)
      throw notFound();
    const windowDays = Number(await this.parameters.get('trust.rating_window_days'));
    if (!withinRatingWindow(info.deliveredAt, now, windowDays)) throw notFound();
    const rateeId = input.ratee === 'provider' ? info.providerId : info.carrierId;
    if (!rateeId) throw notFound();

    return this.uow.run(async () => {
      const existing = await this.repository.findRating(input.id);
      if (existing) {
        const same =
          existing.raterId === actor.sub &&
          existing.orderId === input.orderId &&
          existing.rateeKind === input.ratee &&
          existing.score === score &&
          existing.comment === comment;
        if (same) return { created: false, rating: existing };
        throw ratingConflict();
      }
      const rating: RatingProps = {
        id: input.id,
        orderId: input.orderId,
        raterId: actor.sub,
        rateeId,
        rateeKind: input.ratee,
        score,
        comment,
        createdAt: now,
        hiddenAt: null,
      };
      if (!(await this.repository.insertRating(rating))) throw ratingConflict();
      await this.repository.addToReputation(rateeId, input.ratee, score, now);
      // The event names neither the buyer nor the order, only who was rated and the score.
      await this.outbox.append([
        {
          aggregate: `${input.ratee}:${rateeId}`,
          type: 'RatingSubmitted',
          payload: { ratingId: rating.id, rateeId, rateeKind: input.ratee, score },
        },
      ]);
      return { created: true, rating };
    });
  }

  /** The provider's or carrier's own reputation, with comments only above the minimum. */
  async myReputation(actor: TrustActor): Promise<MyReputation> {
    const kind = this.ownKind(actor);
    const minVisible = await this.parameters.get('trust.min_ratings_visible');
    const totals = (await this.repository.reputations([actor.sub], kind)).get(actor.sub);
    const count = totals?.ratingsCount ?? 0n;
    const comments =
      count >= minVisible
        ? nonChronologicalOrder(await this.repository.visibleComments(actor.sub, kind)).map(
            (rating) => rating.comment!,
          )
        : [];
    const verification =
      kind === 'provider'
        ? ((await this.repository.findVerification(actor.sub))?.status ?? 'unverified')
        : null;
    return {
      rating: totals ? visibleRating(totals.ratingSum, totals.ratingsCount, minVisible) : null,
      ratingsCount: Number(count),
      comments,
      verification,
    };
  }

  /** Public provider trust for catalog and ordering: verified badge and visible rating. */
  async providerTrust(providerIds: readonly string[]): Promise<ReadonlyMap<string, ProviderTrust>> {
    const ids = [...new Set(providerIds)];
    if (ids.length > MAX_TRUST_BATCH)
      throw new DomainError('Demasiados proveedores en una consulta.', 'batch_too_large');
    if (!ids.length) return new Map();
    const minVisible = await this.parameters.get('trust.min_ratings_visible');
    const [verified, reputations] = await Promise.all([
      this.repository.verifiedProviders(ids),
      this.repository.reputations(ids, 'provider'),
    ]);
    return new Map(
      ids.map((id) => {
        const totals = reputations.get(id);
        return [
          id,
          {
            verified: verified.has(id),
            rating: totals
              ? visibleRating(totals.ratingSum, totals.ratingsCount, minVisible)
              : null,
            ratingsCount: Number(totals?.ratingsCount ?? 0n),
          },
        ];
      }),
    );
  }

  /** OrderDelivered: counts the delivery for the carrier's internal punctuality, once. */
  async countDelivery(orderId: string): Promise<boolean> {
    const info = await this.deliveries.get(orderId);
    if (!info?.carrierId || !info.deliveredAt) return false;
    const withWindow = info.deliveryWindow !== null;
    const onTime = withWindow && info.deliveredAt.getTime() <= info.deliveryWindow!.getTime();
    return this.uow.run(() =>
      this.repository.countDelivery(orderId, info.carrierId!, withWindow, onTime, this.clock.now()),
    );
  }

  async requestVerification(
    actor: TrustActor,
    note: string | null | undefined,
  ): Promise<VerificationProps> {
    if (!PROVIDER_ROLES.includes(actor.role))
      throw new DomainError('Rol no autorizado.', 'forbidden');
    const now = this.clock.now();
    this.verificationRateLimit.consume(actor.sub, now);
    const cooldownDays = Number(await this.parameters.get('trust.verification_cooldown_days'));
    return this.uow.run(async () => {
      const current =
        (await this.repository.findVerification(actor.sub, true)) ?? unverified(actor.sub);
      const next = requestVerification(current, note, now, cooldownDays);
      await this.repository.saveVerification(next);
      await this.recordVerification(
        actor,
        'verification.request',
        current,
        next,
        'VerificationRequested',
      );
      return next;
    });
  }

  async listVerifications(
    actor: TrustActor,
    status: VerificationProps['status'],
    limit: number,
  ): Promise<readonly VerificationProps[]> {
    this.requireStaff(actor);
    return this.repository.listVerifications(status, limit);
  }

  async approveVerification(
    actor: TrustActor,
    providerId: string,
    checks: Readonly<Record<string, boolean>>,
  ): Promise<VerificationProps> {
    return this.reviewVerification(
      actor,
      providerId,
      'verification.approve',
      'ProviderVerified',
      (current, now) => approveVerification(current, checks, actor.sub, now),
    );
  }

  async rejectVerification(
    actor: TrustActor,
    providerId: string,
    reason: string,
  ): Promise<VerificationProps> {
    return this.reviewVerification(
      actor,
      providerId,
      'verification.reject',
      'VerificationRejected',
      (current, now) => rejectVerification(current, reason, actor.sub, now),
    );
  }

  async revokeVerification(
    actor: TrustActor,
    providerId: string,
    reason: string,
  ): Promise<VerificationProps> {
    return this.reviewVerification(
      actor,
      providerId,
      'verification.revoke',
      'VerificationRevoked',
      (current, now) => revokeVerification(current, reason, actor.sub, now),
    );
  }

  /** Staff hide the text of a comment; the score keeps counting. Audited. */
  async hideComment(actor: TrustActor, ratingId: string): Promise<RatingProps> {
    this.requireStaff(actor);
    return this.uow.run(async () => {
      const current = await this.repository.findRating(ratingId);
      if (!current || current.comment === null)
        throw new DomainError('Calificación no encontrada.', 'not_found');
      if (current.hiddenAt) return current;
      const hidden = await this.repository.hideComment(ratingId, actor.sub, this.clock.now());
      await this.audit.record({
        actorId: actor.sub,
        actorRole: actor.role,
        action: 'rating.hide_comment',
        entity: 'rating',
        entityId: ratingId,
        before: { hidden: false },
        after: { hidden: true },
      });
      await this.outbox.append([
        {
          aggregate: `${current.rateeKind}:${current.rateeId}`,
          type: 'RatingCommentHidden',
          payload: { ratingId },
        },
      ]);
      return hidden!;
    });
  }

  /** Everything about a provider or carrier, staff only (internal delivery stats included). */
  async subjectForStaff(
    actor: TrustActor,
    userId: string,
  ): Promise<{
    readonly ratings: readonly RatingProps[];
    readonly reputation: { readonly provider: string | null; readonly carrier: string | null };
    readonly verification: VerificationProps | null;
    readonly carrierDeliveries: CarrierDeliveryStats | null;
  }> {
    this.requireStaff(actor);
    const minVisible = 1n; // Staff see the exact average from the first rating.
    const [provider, carrier] = await Promise.all([
      this.repository.reputations([userId], 'provider'),
      this.repository.reputations([userId], 'carrier'),
    ]);
    const format = (totals: { ratingSum: bigint; ratingsCount: bigint } | undefined) =>
      totals ? visibleRating(totals.ratingSum, totals.ratingsCount, minVisible) : null;
    return {
      ratings: await this.repository.ratingsOf(userId),
      reputation: { provider: format(provider.get(userId)), carrier: format(carrier.get(userId)) },
      verification: await this.repository.findVerification(userId),
      carrierDeliveries: await this.repository.carrierStats(userId),
    };
  }

  private async reviewVerification(
    actor: TrustActor,
    providerId: string,
    action: string,
    eventType: string,
    transition: (current: VerificationProps, now: Date) => VerificationProps,
  ): Promise<VerificationProps> {
    this.requireStaff(actor);
    return this.uow.run(async () => {
      const current = await this.repository.findVerification(providerId, true);
      if (!current) throw new DomainError('Solicitud no encontrada.', 'not_found');
      const next = transition(current, this.clock.now());
      await this.repository.saveVerification(next);
      await this.recordVerification(actor, action, current, next, eventType);
      return next;
    });
  }

  private async recordVerification(
    actor: TrustActor,
    action: string,
    before: VerificationProps,
    after: VerificationProps,
    eventType: string,
  ): Promise<void> {
    await this.audit.record({
      actorId: actor.sub,
      actorRole: actor.role,
      action,
      entity: 'verification',
      entityId: after.providerId,
      before: { status: before.status },
      after: {
        status: after.status,
        ...(after.checks && action === 'verification.approve' ? { checks: after.checks } : {}),
      },
    });
    await this.outbox.append([
      {
        aggregate: `provider:${after.providerId}`,
        type: eventType,
        payload: { providerId: after.providerId, status: after.status },
      },
    ]);
  }

  private ownKind(actor: TrustActor): RateeKind {
    if (PROVIDER_ROLES.includes(actor.role)) return 'provider';
    if (actor.role === 'carrier') return 'carrier';
    throw new DomainError('Rol no autorizado.', 'forbidden');
  }

  private requireStaff(actor: TrustActor): void {
    if (!STAFF_ROLES.includes(actor.role)) throw new DomainError('Rol no autorizado.', 'forbidden');
  }
}
