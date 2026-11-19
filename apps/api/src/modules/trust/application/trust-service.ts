import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../shared/kernel/domain-error.js';
import {
  ORDER_TRACE_PORT,
  type OrderTraceEvent,
  type OrderingTracePort,
} from '../../ordering/index.js';
import { verifyTrace } from '../domain/trace-verification.js';

export interface TraceActor {
  readonly sub: string;
  readonly role: string;
}

export interface VerifiedOrderTrace {
  readonly orderId: string;
  readonly integrity: ReturnType<typeof verifyTrace>;
  readonly events: readonly OrderTraceEvent[];
}

@Injectable()
export class TrustService {
  constructor(@Inject(ORDER_TRACE_PORT) private readonly ordering: OrderingTracePort) {}

  async getOrderTrace(actor: TraceActor, orderId: string): Promise<VerifiedOrderTrace> {
    const events = await this.ordering.getTrace(actor, orderId);
    if (!events) throw new DomainError('Pedido no encontrado.', 'not_found');
    return { orderId, integrity: verifyTrace(events), events };
  }
}
