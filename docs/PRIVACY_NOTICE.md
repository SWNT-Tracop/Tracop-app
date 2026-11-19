# Aviso de privacidad: texto pendiente

El texto legal del aviso de privacidad no se redacta en esta implementación. El equipo responsable debe definirlo y aprobarlo antes de reemplazar `PRIVACY_POLICY_VERSION=v0-draft` por una versión de publicación. El consentimiento se conserva en `identity.consents` por tipo, versión, fecha y canal.

---

## Nota para el equipo: Telegram como tercero

El módulo `messaging` usa Telegram Bot API (demo) y, en el futuro, WhatsApp Business Cloud API. Al enviar mensajes por estos canales, **datos personales** (teléfono enmascarado en logs, `channelUserId`, contenido del mensaje) salen de la infraestructura de TRACOP y son procesados por Meta/Telegram según sus políticas.

Puntos a cubrir en el aviso definitivo:

1. **Finalidad**: entrega de OTP, notificaciones de estado de pedido, vinculación de cuenta, asistencia conversacional para publicar lotes.
2. **Datos compartidos**: `channelUserId` (ID de chat de Telegram), número de teléfono (solo si el usuario lo comparte vía botón `request_contact`), texto/voz/fotos/ubicación que el usuario envía al bot.
3. **Base legal**: consentimiento explícito al vincular el canal (botón "Compartir contacto" o código de vinculación). El consentimiento se registra en `identity.consents` con `policy_type='messaging'`, versión y canal.
4. **Derechos**: el usuario puede desvincular el canal en cualquier momento (borra `channel_links`); TRACOP deja de enviarle mensajes por ese canal. Los datos ya entregados a Telegram/WhatsApp siguen sujetos a la política de cada proveedor.
5. **Transferencia internacional**: Telegram y Meta procesan datos fuera de Colombia; el aviso debe informarlo y referenciar las cláusulas contractuales tipo / mecanismos de adecuación que apliquen.
6. **Conservación**: TRACOP no guarda el contenido de mensajes de voz/foto (solo `mediaRef` / `file_id`); los updates procesados se marcan en `messaging.processed_updates` solo con `update_id` (idempotencia técnica).

> Esta nota **no** es texto legal definitivo. Sirve como checklist para quien redacte el aviso final.
