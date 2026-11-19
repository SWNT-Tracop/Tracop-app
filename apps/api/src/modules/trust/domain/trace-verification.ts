import { verifyHashChain } from '../../../shared/kernel/hash-chain.js';
import { orderEventHashContent, type OrderTraceEvent } from '../../ordering/index.js';

export interface TraceVerification {
  readonly valid: boolean;
  readonly eventCount: number;
  readonly firstHash: string | null;
  readonly lastHash: string | null;
}

export const verifyTrace = (events: readonly OrderTraceEvent[]): TraceVerification => ({
  valid: verifyHashChain(events, orderEventHashContent),
  eventCount: events.length,
  firstHash: events[0]?.hash ?? null,
  lastHash: events.at(-1)?.hash ?? null,
});
