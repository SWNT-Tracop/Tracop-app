import { randomBytes } from 'node:crypto';
import { DomainError } from '../../../shared/kernel/domain-error.js';
import type { AuditWriter } from '../../../shared/ports/audit-writer.js';
import type { ParameterReader } from '../../../shared/ports/parameter-reader.js';
import type { OutboxWriter } from '../../../shared/ports/outbox-writer.js';
import type { PhotoProcessorPort } from '../../../shared/ports/photo-processor.js';
import type { StoragePort } from '../../../shared/ports/storage.js';
import {
  deliveryConfirmedTransaction,
  paymentVerifiedTransaction,
  refundTransaction,
  settlementPaidTransaction,
} from '../domain/ledger.js';
import {
  Payment,
  type PaymentEvent,
  type PaymentMethod,
  type PaymentProps,
  type PaymentStatus,
} from '../domain/payment.js';
import { markSettlementPaid, planSettlements, type SettlementProps } from '../domain/settlement.js';
import type {
  DeliveringCarrierPort,
  LedgerRepository,
  PaymentOrderPort,
  PaymentRepository,
  PaymentsClock,
  PaymentsSettings,
  PaymentsUnitOfWork,
  SettlementRepository,
  StoredLedgerEntry,
} from '../ports/payments-ports.js';

export type PaymentsActor = { readonly sub: string; readonly role: string };

/** Who reviews proofs, resolves disputes and pays settlements. */
const STAFF_ROLES: readonly string[] = ['finance', 'operator', 'admin'];
const BENEFICIARY_ROLES: readonly string[] = ['producer', 'supplier', 'carrier'];
const REVIEW_QUEUE: readonly PaymentStatus[] = ['proof_uploaded', 'disputed'];

export interface PaymentView {
  readonly payment: PaymentProps;
  /** Short-lived download URL of the proof; only for the buyer and staff. */
  readonly proofUrl: string | null;
}

const isUuidV7 = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const notFound = (): DomainError => new DomainError('Pago no encontrado.', 'not_found');

export class PaymentsService {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly ledger: LedgerRepository,
    private readonly settlements: SettlementRepository,
    private readonly orders: PaymentOrderPort,
    private readonly carriers: DeliveringCarrierPort,
    private readonly storage: StoragePort,
    private readonly processor: PhotoProcessorPort,
    private readonly outbox: OutboxWriter,
    private readonly uow: PaymentsUnitOfWork,
    private readonly clock: PaymentsClock,
    private readonly settings: PaymentsSettings,
    private readonly audit: AuditWriter,
    private readonly parameters: ParameterReader,
    private readonly newId: () => string,
  ) {}

  /**
   * The buyer chose how to pay an accepted order. Idempotent per order: while the order has an
   * open payment, the same one is returned whatever id or method is sent again.
   */
  async initiate(
    actor: PaymentsActor,
    input: { readonly orderId: string; readonly paymentId: string; readonly method: PaymentMethod },
  ): Promise<{ readonly created: boolean; readonly view: PaymentView }> {
    if (actor.role !== 'buyer') throw new DomainError('Rol no autorizado.', 'forbidden');
    if (!isUuidV7(input.paymentId))
      throw new DomainError('El id del pago debe ser UUID v7.', 'invalid_payment_id');
    return this.uow.run(async () => {
      const order = await this.orders.getOrder(input.orderId);
      if (!order || order.buyerId !== actor.sub)
        throw new DomainError('Pedido no encontrado.', 'not_found');
      const existing = await this.payments.findOpenByOrder(input.orderId);
      if (existing) return { created: false, view: await this.view(existing, actor) };
      if (await this.payments.findById(input.paymentId))
        throw new DomainError('El id del pago ya existe.', 'idempotency_conflict');

      await this.orders.startPayment(input.orderId, actor.sub);
      const payment = Payment.initiate({
        id: input.paymentId,
        orderId: order.orderId,
        buyerId: order.buyerId,
        providerId: order.providerId,
        method: input.method,
        amounts: order.amounts,
        now: this.clock.now(),
      });
      if (!(await this.payments.insert(payment.props))) {
        // Another request opened the order's payment first; answer with that one.
        const raced = await this.payments.findOpenByOrder(input.orderId);
        if (!raced) throw new DomainError('Conflicto al crear el pago.', 'version_conflict');
        return { created: false, view: await this.view(raced, actor) };
      }
      await this.publish(payment.drainEvents());
      return { created: true, view: await this.view(payment.props, actor) };
    });
  }

  /** A presigned POST for the buyer to upload the transfer proof straight to storage. */
  async requestProofUpload(
    actor: PaymentsActor,
    paymentId: string,
  ): Promise<{
    readonly url: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly expiresAt: Date;
  }> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.settings.proofUploadUrlTtlSeconds * 1000);
    const incomingKey = `payment-incoming/${paymentId}/${randomBytes(24).toString('base64url')}`;
    await this.mutate(paymentId, async (payment) => {
      if (payment.props.buyerId !== actor.sub) throw notFound();
      payment.prepareProofUpload(incomingKey, expiresAt, now);
    });
    const policy = await this.storage.createUploadPolicy({
      key: incomingKey,
      maxBytes: this.settings.proofMaxBytes,
      expiresAt,
    });
    return { url: policy.url, fields: policy.fields, expiresAt: policy.expiresAt };
  }

  /**
   * Validates and re-encodes the uploaded proof (WebP, no metadata), then marks it uploaded and
   * holds the order's stock while finance reviews it.
   */
  async confirmProof(actor: PaymentsActor, paymentId: string): Promise<PaymentView> {
    const current = await this.payments.findById(paymentId);
    if (!current || current.buyerId !== actor.sub) throw notFound();
    if (current.status !== 'pending' || !current.proofIncomingKey)
      throw new DomainError('No hay una carga de comprobante pendiente.', 'proof_upload_missing');
    if (current.proofUploadExpiresAt && current.proofUploadExpiresAt < this.clock.now())
      throw new DomainError('La carga del comprobante venció.', 'proof_expired');

    const incomingKey = current.proofIncomingKey;
    const proofKey = `payment-proofs/${paymentId}/${randomBytes(24).toString('base64url')}.webp`;
    const image = await this.processProof(incomingKey);
    await this.storage.putObject({ key: proofKey, body: image, contentType: 'image/webp' });

    let confirmed: PaymentProps;
    try {
      confirmed = await this.mutate(paymentId, async (payment) => {
        if (payment.props.proofIncomingKey !== incomingKey)
          throw new DomainError('La carga del comprobante cambió.', 'version_conflict');
        payment.confirmProof(proofKey, this.clock.now());
        await this.orders.holdStockForReview(payment.props.orderId);
      });
    } catch (error) {
      await this.bestEffortDelete(proofKey);
      throw error;
    }
    await this.bestEffortDelete(incomingKey);
    return this.view(confirmed, actor);
  }

  async get(actor: PaymentsActor, paymentId: string): Promise<PaymentView> {
    const payment = await this.payments.findById(paymentId);
    if (!payment || !this.canSee(actor, payment)) throw notFound();
    return this.view(payment, actor);
  }

  /** The latest payment of an order, for its buyer or staff. */
  async getForOrder(actor: PaymentsActor, orderId: string): Promise<PaymentView> {
    const payment = await this.payments.findLatestByOrder(orderId);
    if (!payment || !this.canSee(actor, payment)) throw notFound();
    return this.view(payment, actor);
  }

  /**
   * Whether the order's payment was verified (verified, held or settled), for trust to accept a
   * rating only on paid orders. Not exposed by any controller.
   */
  async hasVerifiedPayment(orderId: string): Promise<boolean> {
    const payment = await this.payments.findOpenByOrder(orderId);
    return payment !== null && ['verified', 'held', 'settled'].includes(payment.status);
  }

  /** Staff queue: proofs to review and open disputes, oldest first. */
  async listForReview(actor: PaymentsActor, limit: number): Promise<readonly PaymentProps[]> {
    this.requireStaff(actor);
    return this.payments.listByStatus(REVIEW_QUEUE, limit);
  }

  async verify(
    actor: PaymentsActor,
    paymentId: string,
    expectedVersion: number,
  ): Promise<PaymentView> {
    this.requireStaff(actor);
    const payment = await this.mutate(
      paymentId,
      async (entity) => {
        const now = this.clock.now();
        entity.verify(actor.sub, now);
        await this.orders.markPaid(entity.props.orderId, actor.sub);
        await this.post(entity.props, paymentVerifiedTransaction(entity.props), now);
        await this.audited(actor, 'payment.verify', entity.props.id, 'proof_uploaded', 'verified');
      },
      expectedVersion,
    );
    return this.view(payment, actor);
  }

  async reject(
    actor: PaymentsActor,
    paymentId: string,
    expectedVersion: number,
    reason: string,
  ): Promise<PaymentView> {
    this.requireStaff(actor);
    const payment = await this.mutate(
      paymentId,
      async (entity) => {
        const now = this.clock.now();
        entity.reject(actor.sub, reason, now);
        // The buyer may pay again; until then the stock lapses after a short grace window.
        const graceHours = await this.parameters.get('payment.rejection_grace_hours');
        const graceEnd = new Date(now.getTime() + Number(graceHours) * 3_600_000);
        await this.orders.resumeStockExpiry(entity.props.orderId, graceEnd);
        await this.audited(actor, 'payment.reject', entity.props.id, 'proof_uploaded', 'rejected');
      },
      expectedVersion,
    );
    return this.view(payment, actor);
  }

  /** OrderDelivered: the funds become payable and wait for the claim window. Idempotent. */
  async holdForDeliveredOrder(orderId: string): Promise<boolean> {
    return this.uow.run(async () => {
      const current = await this.payments.findOpenByOrder(orderId, true);
      if (!current || current.status !== 'verified') return false;
      const now = this.clock.now();
      const payment = Payment.reconstitute(current);
      payment.hold(await this.carriers.findDeliveringCarrier(orderId), now);
      await this.save(payment, current.version);
      await this.post(payment.props, deliveryConfirmedTransaction(payment.props), now);
      return true;
    });
  }

  /** The buyer disputes a paid order before any settlement was issued. */
  async dispute(
    actor: PaymentsActor,
    paymentId: string,
    expectedVersion: number,
    reason: string,
  ): Promise<PaymentView> {
    const payment = await this.mutate(
      paymentId,
      async (entity) => {
        if ((await this.settlements.listForPayment(entity.props.id)).length)
          throw new DomainError('El pago ya está en liquidación.', 'settlement_issued');
        entity.dispute(actor.sub, reason, this.clock.now());
        await this.orders.markDisputed(entity.props.orderId, actor.sub);
      },
      expectedVersion,
      (current) => current.buyerId === actor.sub,
    );
    return this.view(payment, actor);
  }

  /**
   * Staff resolve a dispute: released, the delivered order goes on to settlement; refunded, the
   * ledger pays the buyer back (the transfer itself is made outside TRACOP). Either way the
   * order is closed.
   */
  async resolveDispute(
    actor: PaymentsActor,
    paymentId: string,
    input: {
      readonly expectedVersion: number;
      readonly outcome: 'release' | 'refund';
      readonly note: string;
    },
  ): Promise<PaymentView> {
    this.requireStaff(actor);
    const payment = await this.mutate(
      paymentId,
      async (entity) => {
        const now = this.clock.now();
        if (input.outcome === 'release') entity.releaseDispute(actor.sub, input.note, now);
        else {
          entity.refund(actor.sub, input.note, now);
          await this.post(
            entity.props,
            refundTransaction(entity.props, entity.props.heldAt !== null),
            now,
          );
        }
        await this.orders.close(entity.props.orderId, actor.sub);
        await this.audited(
          actor,
          input.outcome === 'release' ? 'payment.dispute_release' : 'payment.dispute_refund',
          entity.props.id,
          'disputed',
          entity.props.status,
        );
      },
      input.expectedVersion,
    );
    return this.view(payment, actor);
  }

  /** Worker job: issue the settlements of held payments whose claim window is over. */
  async issueDueSettlements(limit = 100): Promise<number> {
    const now = this.clock.now();
    const claimWindowHours = Number(await this.parameters.get('payment.claim_window_hours'));
    const heldBefore = new Date(now.getTime() - claimWindowHours * 3_600_000);
    let issued = 0;
    for (const paymentId of await this.payments.findDueForSettlement(heldBefore, limit)) {
      const didIssue = await this.uow.run(async () => {
        const current = await this.payments.findById(paymentId, true);
        if (!current) return false;
        const payment = Payment.reconstitute(current);
        if (!payment.isClaimWindowOver(now, claimWindowHours)) return false;
        const plan = planSettlements(current, this.newId, now);
        if (!(await this.settlements.insertPlan(plan))) return false;
        await this.publish(
          plan.map((settlement) => this.settlementEvent('SettlementIssued', settlement, null, now)),
        );
        if (!plan.length) await this.settle(payment, current.version, now);
        return true;
      });
      if (didIssue) issued += 1;
    }
    return issued;
  }

  /** Finance paid a settlement out of TRACOP's account; the last one settles the payment. */
  async markSettlementPaid(
    actor: PaymentsActor,
    settlementId: string,
    input: { readonly expectedVersion: number; readonly reference: string | null },
  ): Promise<SettlementProps> {
    this.requireStaff(actor);
    return this.uow.run(async () => {
      // Lock the payment before its settlement, the same order every payments use case follows.
      const located = await this.settlements.findById(settlementId);
      if (!located) throw new DomainError('Liquidación no encontrada.', 'not_found');
      const paymentProps = await this.payments.findById(located.paymentId, true);
      const current = await this.settlements.findById(settlementId, true);
      if (!current) throw new DomainError('Liquidación no encontrada.', 'not_found');
      if (current.version !== input.expectedVersion)
        throw new DomainError('Conflicto de versión.', 'version_conflict');
      if (!paymentProps || paymentProps.status !== 'held')
        throw new DomainError('El pago no está en liquidación.', 'invalid_transition');
      const now = this.clock.now();
      const paid = markSettlementPaid(current, actor.sub, input.reference, now);
      if (!(await this.settlements.update(paid, current.version)))
        throw new DomainError('Conflicto de versión.', 'version_conflict');
      await this.post(
        paymentProps,
        settlementPaidTransaction(paid.beneficiaryKind, paid.amount),
        now,
      );
      await this.publish([this.settlementEvent('SettlementPaid', paid, actor.sub, now)]);
      await this.audit.record({
        actorId: actor.sub,
        actorRole: actor.role,
        action: 'settlement.mark_paid',
        entity: 'settlement',
        entityId: paid.id,
        before: { status: 'issued' },
        after: { status: 'paid', reference: paid.reference },
      });
      const all = await this.settlements.listForPayment(paid.paymentId);
      if (all.every((settlement) => settlement.status === 'paid'))
        await this.settle(Payment.reconstitute(paymentProps), paymentProps.version, now);
      return paid;
    });
  }

  /** Staff see every settlement; producers, suppliers and carriers only their own. */
  async listSettlements(
    actor: PaymentsActor,
    filter: { readonly status?: SettlementProps['status'] | undefined; readonly limit: number },
  ): Promise<readonly SettlementProps[]> {
    if (STAFF_ROLES.includes(actor.role)) return this.settlements.list(filter);
    if (BENEFICIARY_ROLES.includes(actor.role))
      return this.settlements.list({ ...filter, beneficiaryId: actor.sub });
    throw new DomainError('Rol no autorizado.', 'forbidden');
  }

  async ledgerForOrder(
    actor: PaymentsActor,
    orderId: string,
  ): Promise<readonly StoredLedgerEntry[]> {
    this.requireStaff(actor);
    return this.ledger.listForOrder(orderId);
  }

  private async audited(
    actor: PaymentsActor,
    action: string,
    paymentId: string,
    before: PaymentStatus,
    after: PaymentStatus,
  ): Promise<void> {
    await this.audit.record({
      actorId: actor.sub,
      actorRole: actor.role,
      action,
      entity: 'payment',
      entityId: paymentId,
      before: { status: before },
      after: { status: after },
    });
  }

  private async settle(payment: Payment, expectedVersion: number, now: Date): Promise<void> {
    payment.settle(now);
    await this.save(payment, expectedVersion);
    await this.orders.close(payment.props.orderId, null);
  }

  /** Locks the payment, applies `change` and saves it with its events, in one transaction. */
  /**
   * Loads the payment for update and applies `change`. `canSee` runs before the version check,
   * so someone who may not see the payment gets the 404 of a missing one, never a 409 that would
   * reveal it exists.
   */
  private async mutate(
    paymentId: string,
    change: (payment: Payment) => Promise<void>,
    expectedVersion?: number,
    canSee: (payment: PaymentProps) => boolean = () => true,
  ): Promise<PaymentProps> {
    return this.uow.run(async () => {
      const current = await this.payments.findById(paymentId, true);
      if (!current || !canSee(current)) throw notFound();
      if (expectedVersion !== undefined && current.version !== expectedVersion)
        throw new DomainError('Conflicto de versión.', 'version_conflict');
      const payment = Payment.reconstitute(current);
      await change(payment);
      await this.save(payment, current.version);
      return payment.props;
    });
  }

  private async save(payment: Payment, expectedVersion: number): Promise<void> {
    if (!(await this.payments.update(payment.props, expectedVersion)))
      throw new DomainError('Conflicto de versión.', 'version_conflict');
    await this.publish(payment.drainEvents());
  }

  private async post(
    payment: PaymentProps,
    transaction: Parameters<LedgerRepository['post']>[2],
    now: Date,
  ): Promise<void> {
    if (!(await this.ledger.post(payment.orderId, payment.id, transaction, now)))
      throw new DomainError('El asiento ya fue registrado.', 'ledger_already_posted');
  }

  private async publish(events: readonly PaymentEvent[]): Promise<void> {
    if (!events.length) return;
    await this.payments.appendEvents(events);
    await this.outbox.append(
      events.map((event) => ({
        aggregate: `payment:${event.paymentId}`,
        type: event.type,
        payload: {
          paymentId: event.paymentId,
          orderId: event.orderId,
          occurredAt: event.occurredAt,
          ...event.payload,
        },
      })),
    );
  }

  private settlementEvent(
    type: 'SettlementIssued' | 'SettlementPaid',
    settlement: SettlementProps,
    actorId: string | null,
    now: Date,
  ): PaymentEvent {
    return {
      type,
      paymentId: settlement.paymentId,
      orderId: settlement.orderId,
      actorId,
      occurredAt: now.toISOString(),
      payload: {
        settlementId: settlement.id,
        beneficiaryId: settlement.beneficiaryId,
        beneficiaryKind: settlement.beneficiaryKind,
        amount: settlement.amount.toString(),
      },
    };
  }

  private async processProof(incomingKey: string): Promise<Uint8Array> {
    const metadata = await this.storage.headObject(incomingKey);
    if (!metadata)
      throw new DomainError('No se encontró el comprobante cargado.', 'proof_upload_missing');
    if (metadata.sizeBytes < 1 || metadata.sizeBytes > this.settings.proofMaxBytes)
      throw new DomainError('El comprobante supera el tamaño permitido.', 'proof_size_invalid');
    const bytes = await this.storage.getObject(incomingKey);
    if (bytes.byteLength !== metadata.sizeBytes || bytes.byteLength > this.settings.proofMaxBytes)
      throw new DomainError('El comprobante supera el tamaño permitido.', 'proof_size_invalid');
    try {
      return (await this.processor.process({ bytes, ...this.settings.image })).bytes;
    } catch {
      throw new DomainError(
        'El comprobante debe ser una imagen JPEG, PNG o WebP válida.',
        'proof_image_invalid',
      );
    }
  }

  private canSee(actor: PaymentsActor, payment: PaymentProps): boolean {
    return payment.buyerId === actor.sub || STAFF_ROLES.includes(actor.role);
  }

  private async view(payment: PaymentProps, actor: PaymentsActor): Promise<PaymentView> {
    const proofUrl =
      payment.proofKey && this.canSee(actor, payment)
        ? await this.storage.createDownloadUrl(
            payment.proofKey,
            new Date(this.clock.now().getTime() + this.settings.proofDownloadUrlTtlSeconds * 1000),
          )
        : null;
    return { payment, proofUrl };
  }

  private requireStaff(actor: PaymentsActor): void {
    if (!STAFF_ROLES.includes(actor.role)) throw new DomainError('Rol no autorizado.', 'forbidden');
  }

  private async bestEffortDelete(key: string): Promise<void> {
    try {
      await this.storage.deleteObject(key);
    } catch {
      // Unreferenced proof objects are left for the bucket lifecycle policy (AGENTS §23).
    }
  }
}
