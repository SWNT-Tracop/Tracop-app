import { DomainError } from '../../../shared/kernel/domain-error.js';

export const PAYMENT_METHODS = ['transfer', 'nequi'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATES = [
  'pending',
  'proof_uploaded',
  'verified',
  'held',
  'settled',
  'rejected',
  'disputed',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATES)[number];

/**
 * pending -> proof_uploaded -> verified -> held -> settled; a proof can be rejected; a verified
 * or held payment can be disputed, and the dispute ends released (held) or refunded.
 */
const TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  pending: ['proof_uploaded'],
  proof_uploaded: ['verified', 'rejected'],
  verified: ['held', 'disputed'],
  held: ['settled', 'disputed'],
  disputed: ['held', 'refunded'],
  settled: [],
  rejected: [],
  refunded: [],
};

/** Statuses in which a payment still counts as the order's payment. */
export const OPEN_PAYMENT_STATES: readonly PaymentStatus[] = PAYMENT_STATES.filter(
  (status) => status !== 'rejected',
);

export interface PaymentAmounts {
  readonly subtotal: bigint;
  readonly freight: bigint;
  readonly commission: bigint;
  readonly total: bigint;
  readonly providerNet: bigint;
}

export interface PaymentProps extends PaymentAmounts {
  readonly id: string;
  readonly orderId: string;
  readonly buyerId: string;
  readonly providerId: string;
  readonly method: PaymentMethod;
  readonly status: PaymentStatus;
  readonly version: number;
  readonly proofIncomingKey: string | null;
  readonly proofUploadExpiresAt: Date | null;
  readonly proofKey: string | null;
  readonly proofUploadedAt: Date | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: Date | null;
  readonly rejectionReason: string | null;
  readonly heldAt: Date | null;
  readonly carrierId: string | null;
  readonly disputeReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type PaymentEventType =
  | 'PaymentInitiated'
  | 'PaymentProofUploaded'
  | 'PaymentVerified'
  | 'PaymentRejected'
  | 'PaymentHeld'
  | 'PaymentDisputed'
  | 'PaymentDisputeReleased'
  | 'PaymentRefunded'
  | 'PaymentSettled'
  | 'SettlementIssued'
  | 'SettlementPaid';

export interface PaymentEvent {
  readonly type: PaymentEventType;
  readonly paymentId: string;
  readonly orderId: string;
  readonly actorId: string | null;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

const MAX_REASON_LENGTH = 500;

const requireReason = (reason: string, code: string): string => {
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > MAX_REASON_LENGTH)
    throw new DomainError('El motivo es obligatorio (máximo 500 caracteres).', code);
  return trimmed;
};

/** The quote amounts must add up: total = subtotal + freight and net = subtotal - commission. */
export const assertConsistentAmounts = (amounts: PaymentAmounts): void => {
  const values = [
    amounts.subtotal,
    amounts.freight,
    amounts.commission,
    amounts.total,
    amounts.providerNet,
  ];
  if (
    values.some((value) => value < 0n) ||
    amounts.total <= 0n ||
    amounts.total !== amounts.subtotal + amounts.freight ||
    amounts.providerNet !== amounts.subtotal - amounts.commission
  )
    throw new DomainError('Los montos del pago no son consistentes.', 'invalid_amounts');
};

export class Payment {
  private readonly pendingEvents: PaymentEvent[] = [];
  private constructor(private state: PaymentProps) {}

  static initiate(input: {
    readonly id: string;
    readonly orderId: string;
    readonly buyerId: string;
    readonly providerId: string;
    readonly method: PaymentMethod;
    readonly amounts: PaymentAmounts;
    readonly now: Date;
  }): Payment {
    if (!PAYMENT_METHODS.includes(input.method))
      throw new DomainError('Medio de pago no soportado.', 'invalid_payment_method');
    assertConsistentAmounts(input.amounts);
    const payment = new Payment({
      id: input.id,
      orderId: input.orderId,
      buyerId: input.buyerId,
      providerId: input.providerId,
      method: input.method,
      ...input.amounts,
      status: 'pending',
      version: 1,
      proofIncomingKey: null,
      proofUploadExpiresAt: null,
      proofKey: null,
      proofUploadedAt: null,
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      heldAt: null,
      carrierId: null,
      disputeReason: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
    payment.record('PaymentInitiated', input.buyerId, input.now, {
      method: input.method,
      total: input.amounts.total.toString(),
    });
    return payment;
  }

  static reconstitute(props: PaymentProps): Payment {
    return new Payment({ ...props });
  }

  get props(): PaymentProps {
    return this.state;
  }

  /** A presigned upload was issued; the proof only counts once it is confirmed. */
  prepareProofUpload(incomingKey: string, expiresAt: Date, now: Date): void {
    if (this.state.status !== 'pending')
      throw new DomainError('El pago no admite comprobante en su estado.', 'invalid_transition');
    this.state = {
      ...this.state,
      proofIncomingKey: incomingKey,
      proofUploadExpiresAt: expiresAt,
      version: this.state.version + 1,
      updatedAt: now,
    };
  }

  confirmProof(proofKey: string, now: Date): void {
    if (!this.state.proofIncomingKey)
      throw new DomainError('No hay una carga de comprobante pendiente.', 'proof_upload_missing');
    this.move('proof_uploaded', now);
    this.state = {
      ...this.state,
      proofKey,
      proofIncomingKey: null,
      proofUploadExpiresAt: null,
      proofUploadedAt: now,
    };
    this.record('PaymentProofUploaded', this.state.buyerId, now, {});
  }

  verify(reviewerId: string, now: Date): void {
    this.move('verified', now);
    this.state = { ...this.state, reviewedBy: reviewerId, reviewedAt: now };
    this.record('PaymentVerified', reviewerId, now, { total: this.state.total.toString() });
  }

  reject(reviewerId: string, reason: string, now: Date): void {
    const rejectionReason = requireReason(reason, 'rejection_reason_required');
    this.move('rejected', now);
    this.state = { ...this.state, reviewedBy: reviewerId, reviewedAt: now, rejectionReason };
    this.record('PaymentRejected', reviewerId, now, { reason: rejectionReason });
  }

  /** The order was delivered: funds wait for the claim window before settlement. */
  hold(carrierId: string | null, now: Date): void {
    if (this.state.freight > 0n && !carrierId)
      throw new DomainError('El flete requiere un transportista.', 'carrier_unknown');
    this.move('held', now);
    this.state = { ...this.state, heldAt: now, carrierId };
    this.record('PaymentHeld', null, now, {});
  }

  dispute(actorId: string, reason: string, now: Date): void {
    const disputeReason = requireReason(reason, 'dispute_reason_required');
    this.move('disputed', now);
    this.state = { ...this.state, disputeReason };
    this.record('PaymentDisputed', actorId, now, { reason: disputeReason });
  }

  /** The dispute was resolved for the provider: back to held if it had been delivered. */
  releaseDispute(actorId: string, note: string, now: Date): void {
    if (!this.state.heldAt)
      throw new DomainError(
        'Solo se libera una disputa de un pedido entregado.',
        'dispute_not_releasable',
      );
    const resolution = requireReason(note, 'resolution_note_required');
    this.move('held', now);
    this.record('PaymentDisputeReleased', actorId, now, { note: resolution });
  }

  refund(actorId: string, note: string, now: Date): void {
    const resolution = requireReason(note, 'resolution_note_required');
    this.move('refunded', now);
    this.record('PaymentRefunded', actorId, now, { note: resolution });
  }

  settle(now: Date): void {
    this.move('settled', now);
    this.record('PaymentSettled', null, now, {});
  }

  isClaimWindowOver(now: Date, claimWindowHours: number): boolean {
    return (
      this.state.status === 'held' &&
      this.state.heldAt !== null &&
      now.getTime() >= this.state.heldAt.getTime() + claimWindowHours * 3_600_000
    );
  }

  drainEvents(): readonly PaymentEvent[] {
    return this.pendingEvents.splice(0);
  }

  private move(next: PaymentStatus, now: Date): void {
    if (!TRANSITIONS[this.state.status].includes(next))
      throw new DomainError('Transición de pago inválida.', 'invalid_transition');
    this.state = { ...this.state, status: next, version: this.state.version + 1, updatedAt: now };
  }

  private record(
    type: PaymentEventType,
    actorId: string | null,
    now: Date,
    payload: Record<string, unknown>,
  ): void {
    this.pendingEvents.push({
      type,
      paymentId: this.state.id,
      orderId: this.state.orderId,
      actorId,
      occurredAt: now.toISOString(),
      payload: { status: this.state.status, ...payload },
    });
  }
}
