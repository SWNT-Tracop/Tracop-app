@AGENTS.md

# Reglas de trabajo para agentes

`AGENTS.md` es la fuente de verdad técnica. Estas reglas describen cómo se trabaja en el repositorio. Responde en español; el código, los commits y los identificadores van en inglés.

## Forma de trabajo

- El usuario revisa los PR y hace los merges. El agente implementa y revisa, pero **no se autoaprueba**: entrega evidencia verificable para que el usuario decida.
- Una carpeta, trabajo **secuencial**: una funcionalidad a la vez. Termina cuando su PR está integrado en `develop`; la siguiente empieza desde un `develop` actualizado.
- Respuestas cortas y directas. Si algo es ambiguo, pregunta; **no lo reinterpretes**.

## Reglas

1. **Plan primero** en tareas nuevas: comprensión, archivos por capa, puertos y riesgos propios. Espera confirmación, salvo que el encargo diga que el diseño ya está decidido.
2. **Un commit por bloque lógico**, con sus pruebas y Conventional Commits con los scopes de `.commitlintrc.json`. Nunca `--force`, `--no-verify` ni reescribir historia publicada. Comprueba `git status` antes de cambiar de rama; no uses `checkout`/`restore`/`reset` sobre rutas con trabajo sin confirmar. No apliques ni borres stashes sin autorización.
3. **Antes de cada push**, verifica desde un clon limpio (sin `.env`, `node_modules` ni `dist`), con Node 22 y los pasos de `.github/workflows/ci.yml` en orden. La caché de Turbo y Node 24 no cuentan.
4. **Informes con evidencia**: archivo, función, nombre de la prueba y salida literal. Marca «NO verificado» lo que no comprobaste. Las pruebas de otras funciones no son evidencia de esta.
5. **Límites entre módulos**: solo se importa `modules/<otro>/index.ts`; `bootstrap/` solo adapta APIs públicas, sin SQL ni reglas de negocio; cada módulo es dueño de su schema; se exportan casos de uso, nunca repositorios.
6. **Migraciones** solo hacia adelante, escritas a mano en `apps/api/drizzle` y aplicadas con `drizzle/migrate.ts` desde una base vacía. Nunca `drizzle-kit generate` ni tocar `meta/_journal.json`. Numeración única y contigua: no reserves números; quien se integra segundo renumera.
7. **Pruebas**: concurrencia contra PostgreSQL real (Testcontainers), sin depender del reloj de pared ni de aserciones por subcadena sobre texto serializado. Cada bug corregido añade la prueba que lo reproduce.
8. **Seguridad y privacidad**: sin PII, direcciones, tokens ni URLs firmadas en logs; autorización y propiedad en la capa de aplicación; respuestas por rol; un tercero recibe 404, no 403; dinero en enteros; UUID v7; UTC. Los valores de negocio de §23 son parámetros configurables marcados «PROVISIONAL», nunca inventados.
9. **Dependencias** solo justificadas (tamaño, mantenimiento, licencia, alternativas). La documentación narrativa se escribe en commits `docs:` aparte al cierre de cada fase y solo describe lo que existe. Regenera `docs/openapi.json` con `pnpm openapi:export`.
10. **PR normal hacia `develop`** con el checklist de §21, marcando lo verificado y lo NO verificado. Espera CI, SonarCloud, CodeQL y Snyk sobre el SHA final. No integres: lo hace el usuario.
