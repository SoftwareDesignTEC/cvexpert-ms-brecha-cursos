# Fase 3A — evidencia de validación

Fecha local: 15 de noviembre de 2026, America/Costa_Rica.
Base: `origin/develop` / `fada6a1` (PR #29, incluye #27 y #28).
Rama: `codex/course-sync-staging-postgres`.
Worktree: `C:\Users\Justin\cvexpert-ms-brecha-cursos\.worktrees\course-sync-staging-postgres`.

## Resultados finales

| Control ejecutado | Resultado |
| --- | --- |
| `npm run build` | Aprobado, servidor y scripts de mantenimiento |
| `npm test` | 149/149, cero fallos y cero omitidas |
| `npm run db:test` | 97/97, cero fallos y cero omitidas |
| Nueva suite `test/db/course-sync-staging.test.ts` | 18/18 incluidas en la suite DB |
| `node --test .github/scripts/*.test.mjs` | 52/52 |
| `npm audit --audit-level=high` | 0 vulnerabilidades |
| `git diff --check` y comprobación de archivos nuevos con `--no-index --check` | Sin errores de whitespace |

Entorno: Node **v24.21.0**, PostgreSQL **17.11 (Debian 17.11-1.pgdg12+2)**,
imagen `postgres:17-bookworm`. Contenedor final con puerto `55438` tanto dentro como
fuera, expuesto únicamente en `127.0.0.1`. Credenciales de fixtures limitadas y TLS
local con CA explícita para las pruebas administrativas existentes. No se consultó
Azure, ningún proveedor ni base compartida. La consulta final a `pg_database` encontró
**0** bases `cvexpert_test_<32 hex>` restantes; se retiraron ambos contenedores de prueba
y sus volúmenes al terminar.

En Windows, dos controles previos comparan texto literalmente con LF: el ejemplo de
`docs/job-required-skill-levels.md` y `.github/workflows/azure-oidc-check.yml`. Para
validarlos se normalizaron temporalmente sus saltos de línea a LF, igual que el checkout
de Linux en CI; se restauró CRLF al finalizar. No hay cambios de contenido ni diff en
esos archivos, ni se debilitaron sus assertions. Un checkout Windows con autocrlf puede
seguir mostrando esos fallos preexistentes al repetir esos controles sin normalizar EOL.
El puerto del contenedor también se ajustó para que el destino construido por la prueba
administrativa a partir de `inet_server_port()` coincidiera con el puerto expuesto.

## Cobertura de la nueva suite DB

- Primera inserción, replay durable y rechazo de run ID reutilizado con otra entrada.
- Identidad estable con cambio de título/URL; vínculo editorial que se conserva.
- Desconocidos que no borran duración, idioma, precio, ubicación ni convocatorias.
- Duplicados idénticos y discrepantes; colisiones de URL dentro y entre proveedores.
- Fallback por URL explícito; nueva URL sin ID no reclama el candidato anterior.
- Conflictos editoriales y versiones obsoletas sin ganador automático; bloquean ausencias.
- Registro manual de staging protegido y curso manual público sintético intacto.
- Dos ingestas concurrentes con el mismo run y con runs distintos.
- Fallo SQL antes del COMMIT: rollback de candidatos, observaciones, recibos y checkpoint.
- Respuesta de COMMIT perdida: retry idéntico resuelve el resultado sin duplicados.
- Dos errores `40001`: tercer intento confirma una única ejecución.
- CLI local con archivo, confirmación de destino y replay; rechazo de entornos implícitos.
- Consultas, fallos, cuotas y páginas incompletas sin ausencias; tres completas solo proponen revisión.
- Autorización revocada, marca ausente y permisos editoriales accidentales rechazan la ejecución.
- INSERT/UPDATE/DELETE públicos denegados a los roles de ingesta/HTTP; edición denegada a ingesta.
- Migraciones 001–005 reproducibles, JSON inválido rechazado y vínculos sin revisión rechazados.

Las inserciones públicas de las suites son únicamente fixtures sintéticos en sus
bases UUID desechables. El worker escribe exclusivamente en `course_sync`; los
fixtures públicos de la suite nueva se comparan antes/después y permanecen idénticos.

## Archivos de la entrega

| Archivo | Cambio |
| --- | --- |
| `db/migrations/005_create_course_sync_staging.sql` | Esquema, claves, constraints, índices y trigger de versión |
| `db/course-sync-local-grants.sql` | Grants explícitos mínimos para roles locales independientes |
| `scripts/course-sync/persistence.ts` | Puerto persistente y tipos de snapshot/resultado |
| `scripts/course-sync/postgres.ts` | Repositorio transaccional, verificaciones locales y recuperación |
| `scripts/course-sync/model.ts` | Precio opcional sin inferencias |
| `scripts/course-sync/validation.ts` | Validación y comparación del precio |
| `scripts/sync-courses-local.ts` | Aplicación local explícita, sin conexiones implícitas |
| `scripts/admin-import/planner.ts` | Historial exacto ahora exige también el checksum de 005 |
| `package.json` | Comando `courses:sync:local` |
| `.github/workflows/ci-cd.yml` | Roles limitados adicionales en el servicio PostgreSQL 17 de pruebas |
| `test/course-sync-persistence.test.ts` | Guards locales sin conexión |
| `test/db/course-sync-staging.test.ts` | Integración real con PostgreSQL 17 |
| `test/db/skills-gap.test.ts` | Expectativa aditiva del historial 001–005 |
| `docs/course-sync-architecture.md` | Enlace desde la arquitectura histórica |
| `docs/course-sync-staging-postgres.md` | Arquitectura, límites, permisos y comandos seguros |
| `docs/course-sync-staging-verification.md` | Esta evidencia e inventario |

Decisiones y límites: lock global de staging para evitar carreras entre proveedores;
JSONB validado para el vocabulario existente, con identidad/propiedad/versiones y
vínculos relacionales; documentos observados/editoriales independientes; publicación
fuera del puerto; aplicación restringida a bases locales desechables. No se añade una
UI de edición ni publicación. Los intentos abortados no dejan recibos confirmados;
su reintento conserva el ID de ejecución. El llamador debe conservar el error de
conexión/COMMIT incierto hasta resolver el recibo durable.

No se modificaron migraciones anteriores, motor de conciliación, adaptadores
Saylor/OpenLearn, endpoints, Android, Azure o infraestructura de ejecución. No hubo
push, merge ni despliegue. Los cambios quedan disponibles en el worktree para revisión.
