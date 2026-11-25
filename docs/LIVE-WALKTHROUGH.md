# Recorrido en vivo

## Automático: `pnpm demo:smoke`

Requisitos:

- Docker, `pnpm install` y la demo levantada con `pnpm demo:up`.
- Usa solo datos sintéticos.

```bash
pnpm demo:up
pnpm demo:smoke      # 12 pasos; termina en «demo:smoke OK» o en «FAILED at step N: …»
DEMO_WIPE=1 pnpm demo:down
```

### Qué recorre

Todo pasa por HTTP contra la API de la demo, con el trabajador, PostgreSQL y MinIO reales:

1. Registro y OTP del productor, el comprador y el transportista, y entrada del personal sembrado.
2. Perfil de proveedor.
3. Propuesta de producto aprobada por el operador.
4. Lote con foto subida al S3 de la demo y procesada, y publicación.
5. Búsqueda y pedido del comprador.
6. Aceptación.
7. Comprobante.
8. Verificación por finanzas.
9. Viaje, recogida y entrega.
10. Liquidación emitida por el trabajador y pagada.
11. Calificación.
12. Revisión de los avisos.

### Qué comprueba en cada paso

- **Auditoría:** las acciones del personal quedan en `backoffice.audit_log` con su rol. También las lecturas de la ubicación, permitidas o denegadas.
- **Avisos:** la bandeja de cada parte recibe cada aviso una sola vez.
- **Privacidad inversa:**
  - Las coordenadas del lote no aparecen en lo que ven el comprador, el proveedor ni el transportista. El transportista solo las obtiene con su endpoint auditado.
  - La dirección de entrega no aparece en lo que ven el proveedor ni el transportista.
  - La clave del comprobante solo la ven el comprador y el personal; el proveedor y el transportista reciben 404.

### Cómo obtiene los datos

- **OTP:** lo lee del archivo de captura de la demo dentro del contenedor de la API (`OTP_SENDER=demo_capture`, un tmpfs privado), nunca de los logs. Ese sender solo existe con `APP_PROFILE=demo`, que nunca corre con `NODE_ENV=production`.
- **Ventana de reclamo:** es el único atajo. El script retrasa `held_at` del pago en la base de la demo, como hacen las pruebas e2e. En la demo, el trabajador emite las liquidaciones cada minuto.

## Manual: con Telegram real y un teléfono

Requisitos:

- Un bot de prueba creado en BotFather, nunca el del piloto.
- Un teléfono con Telegram.
- La API accesible por HTTPS desde Internet, por ejemplo con un túnel. Telegram solo entrega webhooks por HTTPS.

1. En `.env`, que nunca se sube, configura:
   - `OTP_SENDER=telegram`, `TELEGRAM_MODE=webhook`;
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (32 caracteres aleatorios) y `TELEGRAM_BOT_USERNAME`.
2. Arranca la API y el trabajador, y registra el webhook con `pnpm telegram:set-webhook https://<túnel>/webhooks/telegram`. Registra `message` y `callback_query`.
3. En el teléfono, abre el bot, pulsa **Iniciar** y comparte el contacto. Así se vincula el chat (`channel_links`).
4. Desde un cliente HTTP (o la app), regístrate con ese número y pide el OTP. El código debe llegar al chat, no a los logs.
5. Repite el recorrido del apartado automático. Los avisos de pedido, pago, recogida, entrega y liquidación deben llegar al chat del productor y del comprador.
6. Con `AI_ENABLED=true`, un modelo configurado y tu consentimiento de IA en el bot:
   - escribe una oferta, por ejemplo «tengo 2 bultos de papa criolla a 80 mil el bulto para el viernes»;
   - confirma con los botones;
   - el lote debe aparecer publicado.
7. Al terminar:
   - borra el webhook con `deleteWebhook` en la API de Telegram;
   - revoca el token del bot de prueba en BotFather;
   - borra los datos con `DEMO_WIPE=1 pnpm demo:down` o tu base local.

Lo que no se ha verificado con un teléfono real está en [FEATURE-MATRIX.md](FEATURE-MATRIX.md), columna «NO verificado».
