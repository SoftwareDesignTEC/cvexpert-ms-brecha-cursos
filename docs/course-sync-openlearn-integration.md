# Fase 4A — OpenLearn a staging PostgreSQL

La [Fase 4C1 incremental](course-sync-openlearn-incremental.md) añade comandos separados
con cursor, artefactos recuperables y presupuesto local durable. Los comandos y el SELECT
acotado descritos en esta Fase 4A conservan su comportamiento.

Base: `origin/develop` **a24543e**, merge de #31, incluye PR #27–#31.
Rama `codex/course-sync-openlearn-staging-integration`, worktree aislado
`.worktrees/course-sync-openlearn-staging-integration`. No se copiaron datos operativos
ni archivos locales de otros worktrees.

## Flujo y contratos

```text
OpenLearnProvider.search (una petición / LIMIT 10)
  → validación RDF y URL del adaptador existente
  → fromDiscovery → SyncRun inmutable preparado
  → CourseSyncStaging.execute
  → snapshot + reconcile + observaciones + recibo + checkpoint en una transacción
  → informe de acciones, candidatos actuales e historial
```

Se inspeccionaron el adaptador y probe, worker, modelo, conciliación, puerto y repositorio
PostgreSQL, CLI local, migración 005, grants, suites DB y pilotos 2B/3B. La integración
no guarda `SyncPlan.next`, no ejecuta SQL de publicación y no replica la conciliación.
`discoverOpenLearn(provider,{runId,observedAt})` convierte con `fromDiscovery` y devuelve
un `PreparedOpenLearnRun`. El reloj del proveedor debe estar fijado a `observedAt`, como
en el probe y los fixtures, para no producir observaciones posteriores al run.

Cada run tiene `sourceId=openlearn`, `scope=query`, `missingPages=true`. Una respuesta
válida acotada es `status=partial`; nunca certifica cobertura completa. `valid` indica
si hubo rechazos de registros. Estos quedan como índice/código en el archivo preparado
y en `runs.coverage.errors`, además del conteo del informe. El transporte sigue usando
el SELECT, grafo, límite de 10 filas, tamaño máximo y validación actuales del proveedor.

Ante 429, timeout, JSON inválido u otro fallo del proveedor se construye un run
`status=failed`, `valid=false`, sin candidatos; 429 y presupuesto agotado señalan
`quotaLimited=true`. Si la fuente está autorizada, ese resultado fallido también tiene
recibo/checkpoint durable: significa **procesado**, no consulta exitosa ni catálogo completo.
Los códigos no incluyen cuerpos HTTP, credenciales ni errores internos del transporte.

`ingestOpenLearn(prepared,staging)` valida el sobre, impide catálogo completo y habilidades
automáticas, llama exclusivamente a `execute()` y genera el informe. Distingue inserciones,
actualizaciones, sin cambios, duplicados, rechazos del adaptador y conflictos. El resultado
conserva acciones/replay/skipped del motor; no aprueba habilidades, modifica verificación,
enriquece datos desde el piloto editorial ni publica cursos. Desconocidos permanecen
desconocidos en la observación original y se conserva el conocimiento previo en el candidato.

La fecha/identidad de ejecución son parte del run, no se regeneran al reintentar.
En replay, los conteos resumen las acciones del recibo original; **no representan DML
nuevo**. La lista de candidatos es el snapshot actual de staging de esa fuente, que
puede incluir otras ejecuciones confirmadas; no es una reconstrucción histórica del run.

## Historial y permisos

El puerto añade `history(sourceId,limit=20)`: devuelve identidad, fecha, alcance, estado,
cobertura/errores y resultado durable de los runs, más recientes primero. Admite límites
1–100; usa parámetros SQL y sesión READ ONLY. No requiere migración ni nuevos grants.
Las observaciones originales se consultan en `course_sync.observations`, vinculadas al run.

Se reutilizan **sin excepciones** `localSyncConfig` y `createPostgresStaging`: dirección
IP loopback y peer TCP comprobado, nombre `cvexpert_test_<32 hex>`, marca explícita del
dueño, PostgreSQL 17, LOGIN `cvexpert_sync_ingest` limitado, ausencia de permisos públicos
de escritura/administración, y proveedor autorizado con referencia. La CLI nunca migra,
crea roles, marca bases ni autoriza fuentes por sí sola. `public.courses`, `skills` y
`course_skills` quedan fuera de toda escritura de integración. El rol HTTP no gana acceso.

La base debe crearse mediante el helper local `withTestDatabase`, aplicar 001–005, recibir
el comentario `cvexpert-course-sync-disposable-v1` de su dueño y los grants de
`db/course-sync-local-grants.sql`. Una identidad editorial/de mantenimiento autoriza
`openlearn` en **esa base desechable**, con referencia explícita; por ejemplo
`TEST-fixture-only-review`. Esa autorización de fixtures no aprueba operación periódica real.
Consultar también [los controles de staging](course-sync-staging-postgres.md).

## Comandos locales

El modo predeterminado no abre conexiones ni llama `fetch`; usa exclusivamente
`test/fixtures/openlearn.test.ts`, con transporte sintético inyectado en el adaptador real.

```powershell
npm run courses:openlearn:staging
New-Item -ItemType Directory -Path local-catalog-input -Force
npm run courses:openlearn:staging -- --prepare ./local-catalog-input/TEST-openlearn-run.json
```

`--prepare` crea el archivo con `wx` y sincroniza su contenido: no sobrescribe otro archivo.
Los fixtures tienen run ID/fecha deterministas. No cambiar su contenido tras un intento de
aplicación; el mismo ID con otra entrada se rechaza. Las nuevas observaciones de prueba
usan un nuevo ID/reloj fijado y nuevas respuestas sintéticas, como en la suite integral.

Con una base desechable **ya provisionada y validada**, la escritura exige comando y
confirmación explícitos. No se leen `.env`, `PG*` ni credenciales administrativas desde
esta CLI:

```powershell
$env:NODE_ENV = 'development'
$env:COURSE_SYNC_HOST = '127.0.0.1'
$env:COURSE_SYNC_PORT = '55438'
$env:COURSE_SYNC_DATABASE = 'cvexpert_test_<32 hex de la base desechable>'
$env:COURSE_SYNC_CONFIRM_DISPOSABLE = $env:COURSE_SYNC_DATABASE
$env:COURSE_SYNC_USER = 'cvexpert_sync_ingest'
$env:COURSE_SYNC_PASSWORD = '<contraseña local del rol limitado>'
npm run courses:openlearn:staging -- --apply-local ./local-catalog-input/TEST-openlearn-run.json
npm run courses:openlearn:staging -- --history-local
```

Para reproducir todo con creación/eliminación automática de una base UUID, configurar
un PostgreSQL 17 loopback con las identidades desechables que ya prepara
`.github/workflows/ci-cd.yml`, y ejecutar:

```powershell
$env:NODE_ENV = 'test'
$env:PGHOST = '127.0.0.1'
$env:PGPORT = '55438'
$env:PGDATABASE = 'cvexpert_ci' # solo configuración del servidor de pruebas
$env:PGUSER = 'cvexpert_ci'
$env:PGPASSWORD = 'ci-only-disposable-password'
$env:DB_SSL_MODE = 'disable'
$env:PGSSLROOTCERT = ''
node --import tsx --test test/db/openlearn-integration.test.ts
```

Las contraseñas TEST/CI son exclusivamente sintéticas. El helper crea una base nueva
y la elimina al terminar; no ingiere datos en `cvexpert_ci`. La prueba integral realiza
la primera escritura mediante la CLI y un archivo preparado, con LOGIN de ingesta real.

## Ejemplo comprobado de staging

La respuesta sintética existente tiene 8 bindings: 6 válidos (5 identidades y un
duplicado), 2 rechazados. No contiene cursos reales capturados ni “Simple coding”.

| Estado | candidates | observations | runs | checkpoints |
| --- | ---: | ---: | ---: | ---: |
| Antes | 0 | 0 | 0 | 0 |
| Primera aplicación | 5 | 6 | 1 | 1 |
| Replay idéntico | 5 | 6 | 1 | 1 |

Resultado original comprobado:

```json
{
  "status": "partial",
  "coverage": "bounded_query_only",
  "counts": {
    "inserts": 5, "updates": 0, "unchanged": 0,
    "duplicates": 1, "rejected": 2, "conflicts": 0
  },
  "publicationApproved": false
}
```

Las cinco filas quedan `review_state=pending`, `verified=null`, `published_course_id=null`,
`associatedSkills=[]`, duración e idioma desconocidos. La evidencia conserva el SHA-256
de la respuesta sintética y la fecha/URL retornada. La suite consulta y comprueba las
cuatro tablas, además del catálogo manual sintético antes/después. Una segunda observación
puede cambiar título/URL manteniendo ID. Para probar retención de metadatos, la suite
siembra conocimiento previo **sintético**, sin atribuir duración/idioma al RDF real.

## Reintentos, errores y límites

El archivo preparado es el artefacto de recuperación anterior al DML. Ante fallo de DB,
rollback o COMMIT incierto se repite `--apply-local` con el mismo archivo: no se consulta
otra vez al proveedor. `execute()` conserva el lock, control de versiones, protección
editorial, hash/idempotencia y transacción de 3A. No cambia el algoritmo de conflictos.
Una discrepancia explícita conserva la revisión y exige revisión humana; un proveedor
que omite duración/habilidades no contradice el enriquecimiento editorial.

El run fallido de proveedor se repite como replay; para otra observación hace falta un
run nuevo, sin convertir el fallo previo en éxito. Un fallo transaccional no deja un
recibo exitoso ni checkpoint adelantado. Un fallo al leer el informe después de COMMIT
tampoco exige volver a consultar OpenLearn: el mismo run resuelve el recibo durable.
Ninguna variante de esta integración habilita ausencias aptas para desactivación.

La CLI **no admite `--live`**, ni consulta real combinada con persistencia. El único probe
real de esta revisión fue independiente, explícito y no se persistió. Sus controles no
se cambiaron. Esto evita que repeticiones/concurrencia de la nueva CLI sirvan para eludir
presupuestos reales. Cada instancia del adaptador sigue reservando como máximo una
petición, también ante llamadas simultáneas; no se implementan reintentos de transporte,
OFFSET, paginación, scraping, descarga de HTML ni lectura de lecciones.

La API programática acepta una instancia del adaptador proporcionada por el llamador;
no crea transporte live por defecto ni coordina cuotas entre procesos. No debe usarse
para programar consultas reales. Antes de habilitar live + persistencia hacen falta dos
autorizaciones separadas (consulta y escritura local verificada), reserva global duradera
de cuota/backoff y coordinación entre instancias/procesos. Cobertura completa y scheduler
siguen pendientes y no pueden inferirse de diez filas.

## Validación y CI

Verificación local con Node 24.21.0 y PostgreSQL 17.11 (`postgres:17-bookworm`), puerto 55438 dentro/fuera del
contenedor, expuesto en `127.0.0.1`. Los tests de integración inyectan transportes y
bloquean `globalThis.fetch`: no dependen de Internet ni de credenciales reales.

| Control | Resultado |
| --- | --- |
| `npm run build` | Aprobado |
| `npm test` | 167/167, sin omitidas |
| `npm run db:test` | 111/111, sin omitidas, incluye controles administrativos TLS existentes |
| Integración nueva aislada | 11/11: 3 unitarias y 8 de DB (incluye suite padre) |
| Guards de workflows | 52/52 |
| `npm audit --audit-level=high` | 0 vulnerabilidades |
| `git diff --check` | Sin errores |

La suite integral cubre primera inserción por CLI, replay, observación nueva, retención,
duplicados/contradicciones, enriquecimiento editorial, 429, timeout, JSON inválido,
rollback/reintento sin otra petición, historial, autorización y permisos de publicación
denegados. Los tests nuevos entran automáticamente en los globs `test/*.test.ts` y
`test/db/*.test.ts` del CI PostgreSQL 17 existente: no se cambian workflows ni controles.
La verificación es local equivalente; GitHub Actions remoto no se dispara sin push.
Al finalizar se comprobaron cero bases UUID restantes y se retiró únicamente el
contenedor/volumen desechable creado para esta fase.

Dos comparaciones textuales previas de Windows requirieron normalización temporal a LF
del ejemplo documental y del workflow de diagnóstico. Se restauraron sus bytes al
terminar, sin modificar assertions ni dejarlos en el diff. No se debilitaron pruebas.

## Pendiente para publicar o ejecutar en Azure

Publicar requiere identidad real contrastada, evidencia vigente por campo, revisión de
habilidades y correspondencia exacta con vocabulario, derechos/atribución, revisión
editorial y el procedimiento administrativo separado. Este flujo no genera un lote
aprobado, firma aprobaciones ni invoca importadores.

Azure requiere además diseño/revisión de identidad e infraestructura, secretos,
conectividad, cuotas duraderas, backoff global, coordinación, observabilidad y política
de cobertura. No se despliega ni se modifica Android, FCM, REST o infraestructura Azure.
Ver la [investigación separada de Simple coding](providers/openlearn-simple-coding.md).
