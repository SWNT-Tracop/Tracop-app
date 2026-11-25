import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../../shared/infra/database.js';
import { createId } from '../../../../shared/kernel/ids.js';
import type { LedgerTransaction } from '../../domain/ledger.js';
import type {
  PaymentEvent,
  PaymentMethod,
  PaymentProps,
  PaymentStatus,
} from '../../domain/payment.js';
import type { SettlementProps } from '../../domain/settlement.js';
import type {
  LedgerRepository,
  PaymentRepository,
  PaymentsMetrics,
  PaymentsMetricsQuery,
  SettlementRepository,
  StoredLedgerEntry,
} from '../../ports/payments-ports.js';
import {
  ledgerEntries,
  ledgerTransactions,
  paymentEvents,
  paymentsTable,
  settlementsTable,
} from './drizzle-schema.js';

type PaymentRow = typeof paymentsTable.$inferSelect;
type SettlementRow = typeof settlementsTable.$inferSelect;

const toPayment = (row: PaymentRow): PaymentProps => ({
  ...row,
  method: row.method as PaymentMethod,
  status: row.status as PaymentStatus,
});

const toSettlement = (row: SettlementRow): SettlementProps => ({
  ...row,
  beneficiaryKind: row.beneficiaryKind as SettlementProps['beneficiaryKind'],
  status: row.status as SettlementProps['status'],
});

@Injectable()
export class DrizzlePaymentRepository implements PaymentRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async findById(id: string, lock = false): Promise<PaymentProps | null> {
    const query = this.database
      .current()
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.id, id));
    const [row] = lock ? await query.for('update') : await query;
    return row ? toPayment(row) : null;
  }

  async findOpenByOrder(orderId: string, lock = false): Promise<PaymentProps | null> {
    const query = this.database
      .current()
      .select()
      .from(paymentsTable)
      .where(and(eq(paymentsTable.orderId, orderId), ne(paymentsTable.status, 'rejected')));
    const [row] = lock ? await query.for('update') : await query;
    return row ? toPayment(row) : null;
  }

  async findLatestByOrder(orderId: string): Promise<PaymentProps | null> {
    const [row] = await this.database
      .current()
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.orderId, orderId))
      .orderBy(desc(paymentsTable.createdAt), desc(paymentsTable.id))
      .limit(1);
    return row ? toPayment(row) : null;
  }

  async insert(payment: PaymentProps): Promise<boolean> {
    const rows = await this.database
      .current()
      .insert(paymentsTable)
      .values(payment)
      .onConflictDoNothing()
      .returning({ id: paymentsTable.id });
    return rows.length === 1;
  }

  async update(payment: PaymentProps, expectedVersion: number): Promise<boolean> {
    const { id, ...columns } = payment;
    const rows = await this.database
      .current()
      .update(paymentsTable)
      .set(columns)
      .where(and(eq(paymentsTable.id, id), eq(paymentsTable.version, expectedVersion)))
      .returning({ id: paymentsTable.id });
    return rows.length === 1;
  }

  async listByStatus(
    statuses: readonly PaymentStatus[],
    limit: number,
  ): Promise<readonly PaymentProps[]> {
    const rows = await this.database
      .current()
      .select()
      .from(paymentsTable)
      .where(inArray(paymentsTable.status, [...statuses]))
      .orderBy(asc(paymentsTable.updatedAt), asc(paymentsTable.id))
      .limit(limit);
    return rows.map(toPayment);
  }

  async findDueForSettlement(heldBefore: Date, limit: number): Promise<readonly string[]> {
    const rows = await this.database
      .current()
      .select({ id: paymentsTable.id })
      .from(paymentsTable)
      .leftJoin(settlementsTable, eq(settlementsTable.paymentId, paymentsTable.id))
      .where(
        and(
          eq(paymentsTable.status, 'held'),
          lte(paymentsTable.heldAt, heldBefore),
          isNull(settlementsTable.id),
        ),
      )
      .orderBy(asc(paymentsTable.heldAt), asc(paymentsTable.id))
      .limit(limit);
    return rows.map(({ id }) => id);
  }

  async appendEvents(events: readonly PaymentEvent[]): Promise<void> {
    if (!events.length) return;
    await this.database
      .current()
      .insert(paymentEvents)
      .values(
        events.map((event) => ({
          id: createId(),
          paymentId: event.paymentId,
          orderId: event.orderId,
          type: event.type,
          actorId: event.actorId,
          payload: event.payload,
          occurredAt: new Date(event.occurredAt),
        })),
      );
  }
}

@Injectable()
export class DrizzleLedgerRepository implements LedgerRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async post(
    orderId: string,
    paymentId: string,
    transaction: LedgerTransaction,
    now: Date,
  ): Promise<boolean> {
    const transactionId = createId();
    const inserted = await this.database
      .current()
      .insert(ledgerTransactions)
      .values({ id: transactionId, orderId, paymentId, kind: transaction.kind, createdAt: now })
      .onConflictDoNothing()
      .returning({ id: ledgerTransactions.id });
    if (!inserted.length) return false;
    await this.database
      .current()
      .insert(ledgerEntries)
      .values(
        transaction.lines.map((line) => ({
          id: createId(),
          transactionId,
          orderId,
          account: line.account,
          debit: line.debit,
          credit: line.credit,
          createdAt: now,
        })),
      );
    return true;
  }

  async listForOrder(orderId: string): Promise<readonly StoredLedgerEntry[]> {
    const rows = await this.database
      .current()
      .select({
        transactionId: ledgerEntries.transactionId,
        kind: ledgerTransactions.kind,
        account: ledgerEntries.account,
        debit: ledgerEntries.debit,
        credit: ledgerEntries.credit,
        createdAt: ledgerEntries.createdAt,
      })
      .from(ledgerEntries)
      .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
      .where(eq(ledgerEntries.orderId, orderId))
      .orderBy(asc(ledgerEntries.createdAt), asc(ledgerEntries.id));
    return rows.map((row) => ({ ...row, kind: row.kind as LedgerTransaction['kind'] }));
  }
}

@Injectable()
export class DrizzleSettlementRepository implements SettlementRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async findById(id: string, lock = false): Promise<SettlementProps | null> {
    const query = this.database
      .current()
      .select()
      .from(settlementsTable)
      .where(eq(settlementsTable.id, id));
    const [row] = lock ? await query.for('update') : await query;
    return row ? toSettlement(row) : null;
  }

  async listForPayment(paymentId: string, lock = false): Promise<readonly SettlementProps[]> {
    const query = this.database
      .current()
      .select()
      .from(settlementsTable)
      .where(eq(settlementsTable.paymentId, paymentId))
      .orderBy(asc(settlementsTable.beneficiaryKind));
    return (lock ? await query.for('update') : await query).map(toSettlement);
  }

  async insertPlan(settlements: readonly SettlementProps[]): Promise<boolean> {
    if (!settlements.length) return true;
    const rows = await this.database
      .current()
      .insert(settlementsTable)
      .values([...settlements])
      .onConflictDoNothing()
      .returning({ id: settlementsTable.id });
    if (rows.length === settlements.length) return true;
    if (rows.length === 0) return false;
    // A partial insert means another run planned the same payment; abort this transaction.
    throw new Error('settlement_plan_conflict');
  }

  async update(settlement: SettlementProps, expectedVersion: number): Promise<boolean> {
    const { id, ...columns } = settlement;
    const rows = await this.database
      .current()
      .update(settlementsTable)
      .set(columns)
      .where(and(eq(settlementsTable.id, id), eq(settlementsTable.version, expectedVersion)))
      .returning({ id: settlementsTable.id });
    return rows.length === 1;
  }

  async list(filter: {
    readonly beneficiaryId?: string | undefined;
    readonly status?: SettlementProps['status'] | undefined;
    readonly limit: number;
  }): Promise<readonly SettlementProps[]> {
    const predicates = [
      filter.beneficiaryId ? eq(settlementsTable.beneficiaryId, filter.beneficiaryId) : undefined,
      filter.status ? eq(settlementsTable.status, filter.status) : undefined,
    ].filter((predicate) => predicate !== undefined);
    const rows = await this.database
      .current()
      .select()
      .from(settlementsTable)
      .where(predicates.length ? and(...predicates) : sql`true`)
      .orderBy(desc(settlementsTable.issuedAt), desc(settlementsTable.id))
      .limit(filter.limit);
    return rows.map(toSettlement);
  }
}

@Injectable()
export class DrizzlePaymentsMetricsQuery implements PaymentsMetricsQuery {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async snapshot(): Promise<PaymentsMetrics> {
    const payments = await this.database.current().execute(sql`
      SELECT
        count(*) FILTER (WHERE status = 'proof_uploaded')::int AS proofs,
        min(proof_uploaded_at) FILTER (WHERE status = 'proof_uploaded') AS oldest,
        count(*) FILTER (WHERE status = 'disputed')::int AS disputes
      FROM payments.payments
    `);
    const settlements = await this.database.current().execute(sql`
      SELECT status, count(*)::int AS count, COALESCE(sum(amount), 0)::text AS amount
      FROM payments.settlements GROUP BY status
    `);
    const row = payments.rows[0] as {
      proofs: number;
      oldest: Date | string | null;
      disputes: number;
    };
    const byStatus = new Map(
      (settlements.rows as { status: string; count: number; amount: string }[]).map((r) => [
        r.status,
        { count: r.count, amountCop: BigInt(r.amount) },
      ]),
    );
    const none = { count: 0, amountCop: 0n };
    return {
      proofsAwaitingReview: row.proofs,
      oldestProofUploadedAt: row.oldest ? new Date(row.oldest) : null,
      openDisputes: row.disputes,
      settlementsIssued: byStatus.get('issued') ?? none,
      settlementsPaid: byStatus.get('paid') ?? none,
    };
  }
}
