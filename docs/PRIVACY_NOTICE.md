# Aviso de privacidad de la demo

El aviso provisional que muestra el APK es el siguiente. Se conserva `PRIVACY_POLICY_VERSION=v0-draft`; este texto no habilita un lanzamiento comercial.

TRACOP — AVISO DE PRIVACIDAD DE LA DEMO
Versión: v0-draft
Estado: aviso provisional para una prueba técnica. No es la política de un servicio comercial.

1. Quién organiza esta prueba
   El equipo del proyecto TRACOP administra esta demostración. Para consultas sobre la prueba o tus datos, contacta directamente a la persona del equipo que te invitó. No se ha definido una entidad responsable ni un canal formal para un lanzamiento comercial.

2. Qué información utilizamos
   Podemos guardar el nombre, celular, rol y datos de perfil que proporciones; la ubicación que compartas; los productos, lotes, pedidos, fotos y comprobantes que uses para las pruebas; y datos técnicos de sesión, dispositivo y seguridad. Usa nombres, productos y comprobantes ficticios. No cargues documentos de identidad, información bancaria, direcciones privadas ni datos de otras personas.

3. Para qué se usa
   La información permite probar el registro, el acceso, los perfiles, el catálogo, los pedidos simulados, la sincronización sin conexión, las notificaciones y la seguridad. Los pedidos, pagos y entregas de este entorno son ejercicios de demostración: no hagas transferencias de dinero ni acuerdes operaciones reales a través de esta prueba.

4. Dónde se guarda
   Parte de la información queda en el dispositivo y se sincroniza con el servidor cuando hay conexión. El servidor y los archivos de esta demo utilizan infraestructura de Amazon Web Services (AWS). También existen copias de seguridad. Cerrar sesión o desinstalar la app no elimina por sí solo los datos del servidor.

5. Telegram y el asistente de IA
   Si vinculas el bot, Telegram procesa los mensajes y la información que compartas por ese canal según sus propias condiciones. Comparte únicamente tu propio contacto cuando sea necesario para vincular la cuenta.

La IA es opcional y tiene un permiso separado en el bot. Al aceptarlo, el texto de tu oferta y nombres de productos del catálogo se envían a Google Gemini para preparar un borrador. No incluyas información personal, confidencial o sensible en tus ofertas. Según el plan del proyecto, Google puede utilizar entradas y respuestas para mejorar sus servicios y puede permitir revisión humana. Puedes continuar sin IA y retirar ese permiso con /ia. Retirarlo evita nuevas consultas autorizadas; no elimina lo que ya se envió a terceros.

6. Conservación y solicitudes
   Este entorno puede reiniciarse, suspenderse o depurarse durante las pruebas. No lo uses como único respaldo de información importante. Para revisar, corregir o solicitar la eliminación de tus datos de prueba, contacta al equipo que te invitó. El equipo debe revisar también las copias de seguridad y los registros que puedan necesitar conservación. No se promete un plazo de borrado automático que no esté implementado.

7. Tu decisión
   Antes de registrarte puedes leer este aviso y decidir si participas. La casilla de registro autoriza el uso de los datos descritos para esta prueba; no activa por sí sola la IA. La aceptación del aviso se registra con su versión, fecha y canal.

Políticas de los proveedores:
Google Gemini: https://ai.google.dev/gemini-api/terms
Telegram: https://telegram.org/privacy

Antes de usar TRACOP con usuarios u operaciones reales, el equipo deberá identificar al responsable, establecer canales y plazos de atención y aprobar los avisos definitivos.

---

## Preparación de producción

Las notas siguientes son una lista interna de asuntos por revisar; no forman parte de la aprobación del texto provisional.

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

---

## Nota para el equipo: proveedor de IA como tercero

El asistente de lotes por Telegram (`ai-assistant`, [ADR-021](adr/ADR-021.md)) envía el texto de la oferta del productor a un proveedor externo de IA (Google Gemini en la demo actual; Anthropic también está disponible por configuración). Puntos a cubrir en el aviso de IA, cuya versión es `AI_CONSENT_VERSION` (sin valor por defecto):

1. **Finalidad**: convertir el mensaje en un borrador de lote que el usuario revisa y confirma; la IA no publica nada.
2. **Datos compartidos**: solo el texto del mensaje (máximo 1000 caracteres) y nombres de productos del catálogo. Nunca teléfono, dirección, ids ni coordenadas.
3. **Base legal**: consentimiento explícito con los botones Acepto / No acepto, registrado en `identity.ai_consent_events` (append-only, por versión). Sin él, el bot solo usa el formulario guiado y no envía nada al proveedor.
4. **Derechos**: el usuario retira el consentimiento con `/ia` → «Retirar consentimiento»; desde entonces no se envía nada más.
5. **Transferencia internacional**: el proveedor procesa los datos fuera de Colombia; el aviso debe informarlo.
6. **Conservación**: TRACOP no guarda el texto ni las respuestas del modelo (la cola `ai_assistant.inbox` se borra al atender cada mensaje); `ai_assistant.usage` guarda solo tokens, latencia y resultado (90 días, PROVISIONAL). La retención en el proveedor depende de su política y debe confirmarse.

> El bot muestra un aviso provisional de demo. La versión de producción sigue pendiente de aprobación.
