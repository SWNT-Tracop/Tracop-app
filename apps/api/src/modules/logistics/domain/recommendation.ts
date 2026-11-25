import { DomainError } from '../../../shared/kernel/domain-error.js';
import type { CheckinKind } from './trip-states.js';

export interface PickupCandidate {
  readonly orderId: string;
  readonly providerId: string;
  readonly pickupZone: string;
  readonly deliveryZone: string;
  readonly deliveryWindow: string | null;
}

export interface RecommendedStop {
  readonly orderId: string;
  readonly kind: CheckinKind;
  readonly sequence: number;
  readonly zone: string;
}

/** Devuelve solo una referencia municipal; no expone la dirección del pedido. */
export const zoneFromAddress = (address: string): string => {
  const parts = address
    .split(',')
    .map((part) => part.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(Boolean);
  if (parts.length === 0)
    throw new DomainError('La dirección de entrega no tiene zona.', 'invalid_address');

  const streetAddressPattern =
    /\d|#|\b(calle|cll|carrera|cra|avenida|av|diagonal|diag|transversal|tv|autopista|kil[oó]metro|km)\b/;
  const municipality = [...parts].reverse().find((part) => !streetAddressPattern.test(part));
  return municipality ?? 'zona de entrega';
};

/**
 * Recomendación básica: recogidas agrupadas por zona del proveedor y entregas
 * agrupadas por zona textual del destinatario, recogidas antes que entregas.
 * No calcula distancias geográficas ni optimiza rutas.
 */
export const recommendStops = (
  candidates: readonly PickupCandidate[],
): readonly RecommendedStop[] => {
  if (new Set(candidates.map((candidate) => candidate.orderId)).size !== candidates.length)
    throw new DomainError('Pedidos duplicados en la recomendación.', 'duplicate_order');

  const pickups = candidates
    .map((candidate) => ({
      orderId: candidate.orderId,
      kind: 'pickup' as const,
      zone: candidate.pickupZone,
    }))
    .sort(compareStops);
  const deliveries = candidates
    .map((candidate) => ({
      orderId: candidate.orderId,
      kind: 'delivery' as const,
      zone: candidate.deliveryZone,
    }))
    .sort(compareStops);

  return [...pickups, ...deliveries].map((stop, index) => ({ ...stop, sequence: index + 1 }));
};

const compareStops = (
  left: { readonly orderId: string; readonly zone: string },
  right: { readonly orderId: string; readonly zone: string },
): number => left.zone.localeCompare(right.zone) || left.orderId.localeCompare(right.orderId);
