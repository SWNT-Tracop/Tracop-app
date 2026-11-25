import type { LedgerTransaction } from '../domain/ledger.js';
import type {
  PaymentAmounts,
  PaymentEvent,
  PaymentProps,
  PaymentStatus,
} from '../domain/payment.js';
import type { SettlementProps } from '../domain/settlement.js';

/** What payments needs to know about an order, from ordering. */
export interface PaymentOrderSnapshot {
  readonly orderId: string;
  readonly buyerId: string;
  readonly providerId: string;
  readonly status: string;
  readonly amounts: PaymentAmounts;
}

/** Ordering's use cases for payments; each runs in the caller's transaction. */
export interface PaymentOrderPort {
  getOrder(orderId: string): Promise<PaymentOrderSnapshot | null>;
  startPayment(orderId: string, buyerId: string): Promise<void>;
  holdStockForReview(orderId: string): Promise<void>;
  resumeStockExpiry(orderId: string, expiresAt: Date): Promise<void>;
  markPaid(orderId: string, actorId: string): Promise<void>;
  markDisputed(orderId: string, actorId: string): Promise<void>;
  close(orderId: string, actorId: string | null): Promise<void>;
}

/** Logistics: who delivered the order, to settle the freight. */
export interface DeliveringCarrierPort {
  findDeliveringCarrier(orderId: string): Promise<string | null>;
}

export interface PaymentRepository {
  findById(id: string, lock?: boolean): Promise<PaymentProps | null>;
  /** The order's payment that is not rejected, if any. */
  findOpenByOrder(orderId: string, lock?: boolean): Promise<PaymentProps | null>;
  findLatestByOrder(orderId: string): Promise<PaymentProps | null>;
  /** Inserts unless the order already has an open payment; returns whether it inserted. */
  insert(payment: PaymentProps): Promise<boolean>;
  update(payment: PaymentProps, expectedVersion: number): Promise<boolean>;
  listByStatus(statuses: readonly PaymentStatus[], limit: number): Promise<readonly PaymentProps[]>;
  /** Held payments delivered before `heldBefore` that have no settlements yet. */
  findDueForSettlement(heldBefore: Date, limit: number): Promise<readonly string[]>;
  appendEvents(events: readonly PaymentEvent[]): Promise<void>;
}

export interface StoredLedgerEntry {
  readonly transactionId: string;
  readonly kind: LedgerTransaction['kind'];
  readonly account: string;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly createdAt: Date;
}

export interface LedgerRepository {
  /** Posts the transaction unless (order, kind) was already posted; returns whether it posted. */
  post(
    orderId: string,
    paymentId: string,
    transaction: LedgerTransaction,
    now: Date,
  ): Promise<boolean>;
  listForOrder(orderId: string): Promise<readonly StoredLedgerEntry[]>;
}

export interface SettlementRepository {
  findById(id: string, lock?: boolean): Promise<SettlementProps | null>;
  listForPayment(paymentId: string, lock?: boolean): Promise<readonly SettlementProps[]>;
  /** Inserts the plan unless the payment already has settlements; returns whether it did. */
  insertPlan(settlements: readonly SettlementProps[]): Promise<boolean>;
  update(settlement: SettlementProps, expectedVersion: number): Promise<boolean>;
  list(filter: {
    readonly beneficiaryId?: string | undefined;
    readonly status?: SettlementProps['status'] | undefined;
    readonly limit: number;
  }): Promise<readonly SettlementProps[]>;
}

export interface PaymentsMetrics {
  readonly proofsAwaitingReview: number;
  readonly oldestProofUploadedAt: Date | null;
  readonly openDisputes: number;
  readonly settlementsIssued: { readonly count: number; readonly amountCop: bigint };
  readonly settlementsPaid: { readonly count: number; readonly amountCop: bigint };
}

export interface PaymentsMetricsQuery {
  snapshot(): Promise<PaymentsMetrics>;
}

export interface PaymentsUnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export interface PaymentsClock {
  now(): Date;
}

export interface PaymentsSettings {
  readonly proofMaxBytes: number;
  readonly proofUploadUrlTtlSeconds: number;
  readonly proofDownloadUrlTtlSeconds: number;
  readonly image: {
    readonly maxInputPixels: number;
    readonly maxInputDimension: number;
    readonly maxOutputDimension: number;
    readonly quality: number;
  };
}

export const PAYMENT_ORDER_PORT = Symbol('PAYMENT_ORDER_PORT');
export const DELIVERING_CARRIER_PORT = Symbol('DELIVERING_CARRIER_PORT');
export const PAYMENT_REPOSITORY = Symbol('PAYMENT_REPOSITORY');
export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');
export const SETTLEMENT_REPOSITORY = Symbol('SETTLEMENT_REPOSITORY');
export const PAYMENTS_UNIT_OF_WORK = Symbol('PAYMENTS_UNIT_OF_WORK');
export const PAYMENTS_CLOCK = Symbol('PAYMENTS_CLOCK');
export const PAYMENTS_SETTINGS = Symbol('PAYMENTS_SETTINGS');
