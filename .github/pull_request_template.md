## Resumen

<!-- Describe brevemente el cambio y su propósito. -->

## Verificación

- [ ] Respeta la regla de dependencia y no importa internals de otro módulo.
- [ ] Lógica de negocio en `domain`/`application`, no en bordes.
- [ ] Pruebas nuevas/actualizadas y cobertura por encima del mínimo.
- [ ] Si toca sync: probados duplicado, conflicto y rechazo.
- [ ] Si toca dinero: enteros, ledger balanceado, idempotencia.
- [ ] Migración incluida, hacia adelante y revisada.
- [ ] Sin secretos ni PII en código, logs o fixtures.
- [ ] Strings de UI en i18n.
- [ ] Docs/ADR actualizados si cambia una decisión.
- [ ] `lint`, `typecheck` y `test` en verde.
- [ ] SonarCloud en verde.
- [ ] CodeQL en verde.
