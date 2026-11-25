import type { NotificationKind } from './notification.js';

/**
 * Versioned in code (AGENTS §14). Texts carry only a short order reference and, for a
 * settlement or a price alert, an amount: never addresses, phones, names or another user's data.
 */
export const TEMPLATE_VERSION = 'v1';

export interface TemplateParameters {
  readonly orderRef: string;
  readonly amount?: string;
}

export interface RenderedNotification {
  readonly title: string;
  readonly body: string;
}

type Template = (parameters: TemplateParameters) => RenderedNotification;

const ES_CO: Readonly<Record<NotificationKind, Template>> = {
  order_received: ({ orderRef }) => ({
    title: 'Nuevo pedido',
    body: `Un comprador aceptó el pedido ${orderRef}. Prepara el lote para la recogida.`,
  }),
  payment_verified_buyer: ({ orderRef }) => ({
    title: 'Pago verificado',
    body: `Verificamos tu pago del pedido ${orderRef}. Pronto programaremos la entrega.`,
  }),
  payment_verified_provider: ({ orderRef }) => ({
    title: 'Pedido pagado',
    body: `El pedido ${orderRef} está pagado. Coordinaremos la recogida.`,
  }),
  payment_rejected: ({ orderRef }) => ({
    title: 'Comprobante rechazado',
    body: `No pudimos verificar el comprobante del pedido ${orderRef}. Revisa el motivo en la app y envía uno nuevo pronto.`,
  }),
  pickup_scheduled: ({ orderRef }) => ({
    title: 'Recogida programada',
    body: `Un transportista recogerá tu pedido ${orderRef}.`,
  }),
  in_transit: ({ orderRef }) => ({
    title: 'Pedido en camino',
    body: `Tu pedido ${orderRef} va en camino.`,
  }),
  delivered: ({ orderRef }) => ({
    title: 'Pedido entregado',
    body: `Registramos la entrega del pedido ${orderRef}. Si hay un problema, repórtalo en la app.`,
  }),
  settlement_issued: ({ orderRef, amount }) => ({
    title: 'Liquidación emitida',
    body: `Emitimos tu liquidación del pedido ${orderRef} por $${amount ?? '0'} COP.`,
  }),
  settlement_paid: ({ orderRef, amount }) => ({
    title: 'Liquidación pagada',
    body: `Pagamos tu liquidación del pedido ${orderRef} por $${amount ?? '0'} COP.`,
  }),
  incident_opened: ({ orderRef }) => ({
    title: 'Nueva incidencia',
    body: `Se abrió una incidencia en el pedido ${orderRef}. Revísala en el backoffice.`,
  }),
  lot_alert: ({ amount }) => ({
    title: 'Hay un lote para tu alerta',
    body: `Se publicó un lote del producto de tu alerta a $${amount ?? '0'} COP. Míralo en la app.`,
  }),
};

const TEMPLATES: Readonly<Record<string, Readonly<Record<NotificationKind, Template>>>> = {
  'es-CO': ES_CO,
};

/** Short, non-identifying reference shown to people: the first 8 hex digits of the order id. */
export const orderReference = (orderId: string): string =>
  `#${orderId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

/** Thousands separated with dots, as in Colombia; amounts are integer COP. */
export const formatCop = (amount: bigint): string => {
  // Grouped by hand, in linear time: a lookahead regex here backtracks super-linearly (S8786).
  const digits = (amount < 0n ? -amount : amount).toString();
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3)
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  return `${amount < 0n ? '-' : ''}${groups.join('.')}`;
};

export const renderNotification = (
  kind: NotificationKind,
  locale: string,
  parameters: TemplateParameters,
): RenderedNotification => (TEMPLATES[locale] ?? ES_CO)[kind](parameters);
