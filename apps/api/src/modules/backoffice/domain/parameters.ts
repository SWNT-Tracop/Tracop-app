import { DomainError } from '../../../shared/kernel/domain-error.js';
import { PARAMETER_KEYS, type ParameterKey } from '../../../shared/kernel/parameter-keys.js';

export type ParameterUnit = 'bps' | 'cop' | 'hours' | 'days' | 'count' | 'characters';

export interface ParameterDefinition {
  readonly key: ParameterKey;
  readonly unit: ParameterUnit;
  readonly min: bigint;
  readonly max: bigint;
  /** A business value still open in AGENTS §23: shown as PROVISIONAL to the staff. */
  readonly provisional: boolean;
  readonly description: string;
}

/** Same ceiling as ordering's quote amounts (the largest PostgreSQL bigint). */
const MAX_COP = 9_223_372_036_854_775_807n;

/** The run-time parameters, their ranges and whether they are still PROVISIONAL (§23). */
export const PARAMETER_DEFINITIONS: Readonly<Record<ParameterKey, ParameterDefinition>> = {
  'order.commission_rate_bps': {
    key: 'order.commission_rate_bps',
    unit: 'bps',
    min: 0n,
    max: 10_000n,
    provisional: true,
    description: 'Comisión sobre el subtotal, en puntos básicos (100 = 1 %).',
  },
  'order.freight_cop': {
    key: 'order.freight_cop',
    unit: 'cop',
    min: 0n,
    max: MAX_COP,
    provisional: true,
    description: 'Flete fijo por pedido en pesos colombianos.',
  },
  'order.quote_ttl_hours': {
    key: 'order.quote_ttl_hours',
    unit: 'hours',
    min: 1n,
    max: 720n,
    provisional: true,
    description: 'Vigencia de una cotización antes de aceptarla.',
  },
  'order.reservation_ttl_hours': {
    key: 'order.reservation_ttl_hours',
    unit: 'hours',
    min: 1n,
    max: 720n,
    provisional: true,
    description: 'Vigencia de la reserva de stock de un pedido aceptado sin comprobante.',
  },
  'payment.claim_window_hours': {
    key: 'payment.claim_window_hours',
    unit: 'hours',
    min: 1n,
    max: 720n,
    provisional: true,
    description: 'Ventana de reclamo tras la entrega, antes de emitir liquidaciones.',
  },
  'payment.rejection_grace_hours': {
    key: 'payment.rejection_grace_hours',
    unit: 'hours',
    min: 1n,
    max: 168n,
    provisional: true,
    description: 'Tiempo que conserva la reserva un pedido cuyo comprobante fue rechazado.',
  },
  'catalog.product_proposal_pending_limit': {
    key: 'catalog.product_proposal_pending_limit',
    unit: 'count',
    min: 1n,
    max: 50n,
    provisional: true,
    description: 'Propuestas de producto pendientes por usuario.',
  },
  'trust.rating_window_days': {
    key: 'trust.rating_window_days',
    unit: 'days',
    min: 1n,
    max: 90n,
    provisional: true,
    description: 'Días tras la entrega en que el comprador puede calificar.',
  },
  'trust.min_ratings_visible': {
    key: 'trust.min_ratings_visible',
    unit: 'count',
    min: 1n,
    max: 50n,
    provisional: true,
    description: 'Calificaciones mínimas para mostrar el promedio y los comentarios al calificado.',
  },
  'trust.comment_max_length': {
    key: 'trust.comment_max_length',
    unit: 'characters',
    min: 0n,
    max: 500n,
    provisional: true,
    description:
      'Longitud máxima del comentario de una calificación (0 desactiva los comentarios).',
  },
  'trust.verification_cooldown_days': {
    key: 'trust.verification_cooldown_days',
    unit: 'days',
    min: 0n,
    max: 365n,
    provisional: true,
    description: 'Espera mínima para volver a solicitar la verificación tras un rechazo.',
  },
};

export const isParameterKey = (value: string): value is ParameterKey =>
  (PARAMETER_KEYS as readonly string[]).includes(value);

/** Parses an integer string and checks it against the parameter's range. */
export const parseParameterValue = (key: ParameterKey, raw: string): bigint => {
  const definition = PARAMETER_DEFINITIONS[key];
  if (!/^-?(0|[1-9]\d{0,18})$/.test(raw))
    throw new DomainError('El valor debe ser un entero.', 'invalid_parameter_value');
  const value = BigInt(raw);
  if (value < definition.min || value > definition.max)
    throw new DomainError(
      `El valor debe estar entre ${definition.min} y ${definition.max}.`,
      'parameter_out_of_range',
      { min: definition.min.toString(), max: definition.max.toString() },
    );
  return value;
};
