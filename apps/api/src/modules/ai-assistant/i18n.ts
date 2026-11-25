/** Bot texts of the lot draft assistant (es-CO). */
export const assistantMessages = {
  notLinked: 'Primero vincula tu cuenta: escribe /start y comparte tu contacto.',
  notProvider: 'Solo los productores y proveedores pueden ofrecer lotes por aquí.',
  noProfile: 'Antes de ofrecer lotes, completa tu perfil de proveedor en la app TRACOP.',
  consentRequest:
    'Para entender tus mensajes uso un asistente de inteligencia artificial de un proveedor externo. ' +
    'Solo le envío el texto de tu oferta (nunca tu teléfono, dirección ni ubicación exacta) y tú ' +
    'siempre confirmas antes de publicar. ¿Aceptas? Si no, te guío paso a paso sin IA. ' +
    '[Texto del aviso pendiente de aprobación legal]',
  consentAccepted:
    'Gracias. Escríbeme tu oferta, por ejemplo: «tengo 2 bultos de papa criolla a 80 mil el bulto para el viernes».',
  consentDeclined: 'Entendido, seguimos sin IA. Te pregunto los datos uno por uno.',
  consentWithdrawn: 'Retiré tu consentimiento. Desde ahora te guío sin IA.',
  consentStatusAccepted: 'Tienes activo el asistente con IA.',
  consentStatusNone: 'No tienes activo el asistente con IA.',
  accept: 'Acepto',
  decline: 'No acepto',
  withdraw: 'Retirar consentimiento',
  guidedFallback: 'Ahora no puedo usar el asistente automático; te pregunto los datos uno por uno.',
  questions: {
    product: '¿Qué producto ofreces? Escribe solo el nombre, por ejemplo «papa criolla».',
    product_choice: '¿Cuál de estos productos es?',
    product_proposal: (name: string) =>
      `No encontré «${name}» en el catálogo. ¿Quieres proponerlo? El equipo lo revisa y, mientras tanto, tu lote queda guardado como borrador.`,
    proposal_category: '¿En qué categoría va el producto?',
    quantity: (unit: string) => `¿Cuántos ${unit} tienes? Escribe solo el número.`,
    unit: 'No manejo esa unidad. Usa una de estas: kg, g, lb, und, docena, arroba, quintal, caja, mano o bulto.',
    unit_mismatch: (unit: string) =>
      `En el catálogo ese producto se vende por ${unit}. ¿Cuántos ${unit} tienes?`,
    price: (unit: string) => `¿A cuánto vendes cada ${unit}? Por ejemplo «80 mil».`,
    price_basis: (amount: string, unit: string) =>
      `¿${amount} es el precio de cada ${unit} o el total del lote?`,
    available_from: '¿Desde cuándo está disponible? Por ejemplo «hoy», «mañana» o «el viernes».',
    available_until: '¿Hasta cuándo está disponible? Por ejemplo «el sábado» o «30 de noviembre».',
    location:
      'Comparte la ubicación de recogida con el clip 📎 → Ubicación, o usa la de tu perfil.',
    edit_field: '¿Qué quieres cambiar?',
    quality: 'Describe la calidad en pocas palabras, por ejemplo «primera» o «pareja».',
  },
  issues: {
    unsupported_unit: 'No manejo esa unidad.',
    invalid_quantity: 'No entendí la cantidad.',
    invalid_price: 'No entendí el precio.',
    ambiguous_price: 'Ese total no se divide en un precio exacto por unidad.',
    ambiguous_date: 'Esa fecha puede significar dos días distintos.',
    invalid_date: 'No entendí la fecha.',
    outside_colombia: 'Esa ubicación está fuera de Colombia.',
    until_before_from: 'La fecha final es anterior a la inicial.',
    beyond_horizon: 'Esa fecha está demasiado lejos.',
  },
  perUnit: 'Por unidad',
  total: 'Total del lote',
  propose: 'Proponer producto',
  otherProduct: 'Escribir otro',
  useProfileLocation: 'Usar la de mi perfil',
  confirm: 'Confirmar',
  edit: 'Editar',
  cancel: 'Cancelar',
  fields: {
    product: 'Producto',
    quantity: 'Cantidad',
    price: 'Precio',
    quality: 'Calidad',
    available_from: 'Desde',
    available_until: 'Hasta',
    location: 'Ubicación',
  },
  summary: (lines: readonly string[]) => `Revisa tu lote:\n${lines.join('\n')}\n¿Lo publico?`,
  summaryDraftOnly:
    'Como el producto está en revisión, al confirmar lo guardo como borrador y se publica cuando lo aprueben.',
  suggestion: (amount: string, source: string, date: string) =>
    `Precio de referencia: ${amount} (${source}, ${date}). Es solo una sugerencia.`,
  published: 'Listo, tu lote quedó publicado.',
  savedAsDraft: 'Listo, guardé tu lote como borrador hasta que aprueben el producto.',
  cancelled: 'Cancelé el borrador.',
  expired: 'Tu borrador anterior venció. Empecemos de nuevo.',
  stale: 'Ese borrador ya cambió. Usa los botones del último mensaje.',
  publishFailed: 'No pude publicar el lote. Revisa los datos con «Editar» o inténtalo más tarde.',
  proposalFailed: 'No pude enviar la propuesta. Inténtalo más tarde.',
} as const;
