import { DomainError } from '../../../shared/kernel/domain-error.js';

export type SubtotalRounding = 'half_up' | 'floor' | 'ceil';
export interface PricingConfiguration {
  readonly commissionRateBps: bigint;
  readonly freightCop: bigint;
  readonly subtotalRounding: SubtotalRounding;
}
export interface QuoteAmounts {
  readonly subtotal: bigint;
  readonly freight: bigint;
  readonly commission: bigint;
  readonly total: bigint;
  readonly providerNet: bigint;
}

export const MAX_COP = 9_223_372_036_854_775_807n;

const roundPositive = (numerator: bigint, denominator: bigint, mode: SubtotalRounding): bigint => {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (mode === 'floor' || remainder === 0n) return quotient;
  if (mode === 'ceil') return quotient + 1n;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
};

export const calculateQuoteAmounts = (
  lines: readonly { readonly unitPrice: bigint; readonly quantityMilli: bigint }[],
  configuration: PricingConfiguration,
): QuoteAmounts => {
  if (configuration.commissionRateBps < 0n || configuration.commissionRateBps > 10_000n)
    throw new DomainError('Configuración de comisión inválida.', 'invalid_pricing_configuration');
  if (configuration.freightCop < 0n || configuration.freightCop > MAX_COP)
    throw new DomainError('Configuración de flete inválida.', 'invalid_pricing_configuration');
  const exactNumerator = lines.reduce((sum, line) => {
    if (line.unitPrice < 0n || line.quantityMilli <= 0n)
      throw new DomainError('Línea de pedido inválida.', 'invalid_order_line');
    return sum + line.unitPrice * line.quantityMilli;
  }, 0n);
  const subtotal = roundPositive(exactNumerator, 1000n, configuration.subtotalRounding);
  const commission = roundPositive(subtotal * configuration.commissionRateBps, 10_000n, 'half_up');
  const total = subtotal + configuration.freightCop;
  const providerNet = subtotal - commission;
  if ([subtotal, commission, total, providerNet].some((amount) => amount < 0n || amount > MAX_COP))
    throw new DomainError(
      'El valor de la cotización excede el límite permitido.',
      'amount_overflow',
    );
  return { subtotal, freight: configuration.freightCop, commission, total, providerNet };
};
