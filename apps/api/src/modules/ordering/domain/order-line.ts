import { DomainError } from '../../../shared/kernel/domain-error.js';
import type { OrderLineProps } from './order.js';

export class OrderLine {
  private constructor(readonly props: OrderLineProps) {}
  static create(props: OrderLineProps): OrderLine {
    if (props.quantityMilli <= 0n)
      throw new DomainError('La cantidad debe ser positiva.', 'invalid_order_line');
    if (props.unitPrice < 0n)
      throw new DomainError('El precio no puede ser negativo.', 'invalid_order_line');
    return new OrderLine({ ...props });
  }
}
