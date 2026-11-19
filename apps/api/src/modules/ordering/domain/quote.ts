import { DomainError } from '../../../shared/kernel/domain-error.js';
import type { QuoteAmounts } from './pricing.js';

export interface QuoteProps extends QuoteAmounts {
  readonly id: string;
  readonly orderId: string;
  readonly validUntil: Date;
  readonly status: 'active' | 'accepted' | 'expired' | 'cancelled';
}

export class Quote {
  private constructor(readonly props: QuoteProps) {}
  static create(props: QuoteProps): Quote {
    if (props.validUntil.getTime() <= 0)
      throw new DomainError('Vencimiento inválido.', 'invalid_quote');
    return new Quote({ ...props });
  }
  isValidAt(now: Date): boolean {
    return this.props.status === 'active' && this.props.validUntil >= now;
  }
}
