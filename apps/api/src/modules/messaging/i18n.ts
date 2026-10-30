export const messagingMessages = {
  start: 'Hola, soy TRACOP. Para vincular tu cuenta, comparte tu contacto con el botón de abajo.',
  shareContact: 'Compartir mi contacto',
  linked: 'Tu cuenta de TRACOP quedó vinculada. Ya puedes recibir notificaciones por este chat.',
  alreadyLinked: 'Tu cuenta ya estaba vinculada a este chat.',
  registerFirst:
    'No encontramos una cuenta de TRACOP con ese número. Regístrate primero en la app y vuelve a intentarlo.',
  genericFailure: 'No pudimos vincular tu cuenta. Inténtalo de nuevo o contacta a soporte.',
  contactSecurity: 'Por seguridad, comparte tu propio contacto desde el botón del mensaje.',
  unavailable: 'Por ahora solo puedo recibir texto y contactos.',
  otp: (code: string): string =>
    `Tu código de TRACOP es ${code}. Vence en pocos minutos. No lo compartas.`,
} as const;
