# Fase 4C1 — Descubrimiento incremental OpenLearn

Base `origin/develop` **39c6ab3**, con PR #27–#33. Rama
`codex/course-sync-openlearn-incremental`, worktree independiente
`.worktrees/course-sync-openlearn-incremental`. No se incorporaron entradas locales
de otros worktrees. No hay cambios de migraciones, permisos, conciliación, importadores,
HTTP, Android, Azure ni publicación.

## Estrategia verificada

Se revisaron adaptador, store/service, worker, integración, persistencia y conciliación,
CLIs anteriores, probe, documentación del proveedor y cursos editoriales, migraciones
001–005, grants y suites de PostgreSQL/CI. Se conserva el comportamiento anterior:
`OpenLearnProvider` y `courses:openlearn:probe` siguen usando su SELECT de diez filas y
una petición. Solo se extraen sus funciones puras de validación/conversión para reutilizarlas.

La [guía oficial](https://data.open.ac.uk/howto) documenta SELECT y negociación JSON;
el [inventario](https://data.open.ac.uk/datasets) identifica el grafo
`http://data.open.ac.uk/context/openlearn2`. [SPARQL 1.1](https://www.w3.org/TR/sparql11-query/)
define subconsultas, DISTINCT, VALUES y agregados. Su aceptación efectiva por este
endpoint se verificó con las cuatro peticiones del piloto, no se dedujo solo del estándar.

Dos consultas controladas por código por página:

1. `SELECT DISTINCT ?resource`, mismo tipo/vocabulario y filtro HTTPS de cursos del
   adaptador, `ORDER BY STR(?resource) LIMIT 1..10`. Desde la segunda página se añade
   `FILTER(STR(?resource) > "cursor")`. El cursor solo admite IRIs del patrón RDF conocido;
   no hay SPARQL, endpoint, grafo ni vocabulario configurable por el usuario.
2. Metadatos exclusivamente para esas identidades mediante `VALUES`. Una subconsulta
   calcula `COUNT(*)` por identidad sobre **el mismo patrón**; la respuesta devuelve ese
   conteo en cada fila. Se comprueba que todas las identidades seleccionadas estén presentes
   y que el número de filas recibido coincida con su conteo. Se conservan categorías
   multivaluadas como observaciones/evidencia; el conciliador existente agrupa duplicados
   idénticos y retiene discrepancias para revisión.

La segunda consulta tiene `LIMIT 201` como centinela y se aceptan como máximo 200 filas,
256 KiB y 15 segundos por petición. Un conteo excesivo, identidad inesperada, orden no
monótono, identidad repetida en la selección, metadatos faltantes, aviso de truncamiento,
JSON/UTF-8 inválido o respuesta incompleta bloquea la página entera. **Nunca** se consume
el primer recorte y se adelanta el cursor. Los registros ya validados y hashes disponibles
quedan en el artefacto fallido; no se presentan como una página completa ni se saltan
identidades rechazadas. Hace falta investigar/revisar la página antes de continuar.

Esto evita cortar un curso por sus categorías, a diferencia de paginar filas con OFFSET.
No es un snapshot del grafo: cambios entre consultas pueden hacer fallar la página y una
inserción futura anterior al cursor requeriría un recorrido posterior autorizado. Tampoco
garantiza detectar un proveedor que silenciosamente falsee tanto datos como conteos.
`exhausted` significa solo una selección vacía al final de esta consulta en ese momento;
**todos** los runs siguen siendo `scope=query`, `status=partial`, `missingPages=true`, sin bajas.

## Arquitectura, estado y recuperación

```text
CLI init → intención y presupuesto locales bajo lock
CLI fetch → reserva durable → SELECT identidades → reserva durable → SELECT metadatos
          → validación compartida → fromDiscovery → SyncRun → artefacto atómico pendiente
CLI apply-local → createPostgresStaging.execute(run)
                → snapshot + reconcile + observaciones + run + checkpoint / COMMIT
                → recibo confirmado → cursor local confirmado
CLI status / history-local → estado local / recibos persistidos
```

`session.ts` reutiliza `withDiscoveryStore`: lock exclusivo `live.lock`/`fixture.lock`,
escritura temporal + sync + rename, nombres cerrados, control de directorio real y lector
JSON acotado que rechaza claves repetidas. Las entradas anteriores del store no cambian.
Estado y artefactos quedan en `<root>/local-catalog-input/discovery/`, ignorado por Git.

`<mode>-openlearn-incremental.json`, formato 1, conserva proveedor, modo, fingerprint de
consulta/endpoint y versión declarada del parser, cursor inicial y confirmado, límites, peticiones reservadas,
última petición, backoff, último código seguro, intención pendiente (UUID, fecha, archivo,
hash del artefacto), destino local vinculado, identidades vistas y recibos aplicados.
El artefacto formato 1 conserva `SyncRun`, recursos, metadatos mínimos validados, queries
exactas y SHA-256, horas/status/bytes y hashes de respuestas, cursores y conflictos de URL.
`status`/recibos exponen también SHA-256 canónico del run. Este hash del run y el hash del
artefacto son distintos del `input_sha256` SQL, que incluye las versiones esperadas.
Al cambiar la semántica del parser, debe incrementarse su marcador de versión en el fingerprint.
El fingerprint usa una IRI de plantilla solo para calcular el hash de la forma de consulta;
esa plantilla nunca se consulta ni se incorpora como identidad observada.

| Punto de fallo | Recuperación segura |
| --- | --- |
| Antes del envío | Se reserva y sincroniza el contador antes de abrir el socket. Un intento reservado no se devuelve al presupuesto. |
| Durante consulta, 429, timeout, 5xx o respuesta inválida | Run `failed`, `valid=false`, sin candidatos aplicables; conserva evidencia disponible, cursor anterior y código seguro. Sin reintento HTTP automático. |
| Cierre después de consultar pero antes de guardar artefacto | La intención queda pendiente y el presupuesto consumido. Si no existe artefacto, `INTERRUPTED_FETCH_REVIEW_REQUIRED` bloquea nuevas consultas; no se inventa un éxito recuperable. |
| Artefacto renombrado pero confirmación local pendiente | La intención ya conoce su UUID/archivo. Se recupera el artefacto sin otra petición y se comprueban versión, identidad, alcance, metadatos y hash disponible. |
| PostgreSQL falla antes de COMMIT | El artefacto y cursor anterior siguen intactos. Repetir `apply-local` con el mismo root/modo; nunca volver a consultar para reintentar SQL. |
| COMMIT incierto o fallo al guardar recibo local después del COMMIT | Repetir exactamente el artefacto/run en el mismo destino; el recibo SQL resuelve replay sin DML duplicado y permite confirmar cursor local. |
| Run omitido por checkpoint más reciente | `STAGING_RUN_SKIPPED_REVIEW_REQUIRED`: no avanza cursor ni descarta artefacto. Requiere revisión de la secuencia. |
| Query incompatible, estado/artefacto alterado, cambio de destino | Rechazo explícito; no reutiliza ni reinicia silenciosamente el cursor. |

Una página con conflictos de identidad/editoriales puede confirmarse porque sus observaciones
y resultados quedan auditados para revisión; no implica aceptar sus cambios ni publicarlos.
El checkpoint SQL significa run procesado, incluso si el proveedor falló. El cursor local
solo avanza para una página íntegra y un recibo no omitido. Tras éxito, repetir `apply-local`
devuelve `NO_PENDING_ARTIFACT`; consultar `status`/historial para el resultado confirmado.
No se elimina el artefacto aplicado. Los conteos de un replay son los del recibo original,
no nuevo DML. `invalid`/`ambiguous` cuentan acciones del conciliador; en fallo de transporte
no se inventa cuántos registros faltaron/rechazó la fuente (`rejectedRecords=null`).

Los archivos locales son mantenimiento de confianza, no entradas HTTP ni aprobaciones
firmadas. El hash detecta cambios respecto al preparado; no autentica al proveedor.
El lock solo coordina **ese host y directorio compartido**, incluyendo las reservas de
presupuesto y las pausas. Un lock abandonado exige revisión manual del proceso/artefacto;
no se rompe automáticamente. No hay garantía distribuida ni fsync del directorio frente
a pérdida de alimentación. No mover/borrar estado, variar root, ejecutar probes paralelos
ni iniciar otros pilotos para ampliar deliberadamente el presupuesto.

## Límites y autorizaciones

Límites **internos**, no cuotas oficiales: una página/dos peticiones por sesión por defecto;
piloto explícito máximo dos páginas/cuatro peticiones, 1–10 identidades por página,
pausa predeterminada 5000 ms (configurable 2000–60000). Una invocación `fetch` prepara una
sola página, nunca un bucle remoto. No hay renovación diaria, reset CLI ni reintentos
ilimitados. El proveedor vacío necesita solo la consulta de identidades.

429 persiste backoff y respeta `Retry-After` en segundos o fecha con mínimo interno de
60 s; 5xx tiene mínimo de cinco minutos. Incluso terminado el backoff, una página fallida
queda bloqueada para revisión: no se reintenta automáticamente. Timeouts, errores de red y
parseo también bloquean la sesión. Los errores no guardan cuerpos HTTP ni secretos.

`live init/fetch` exige `NODE_ENV=development`, referencia explícita de autorización de
fuente y ausencia de CI/App Service/producción. El código no descarga páginas HTML ni
reutiliza la instancia antigua de proveedor para evadir su presupuesto. No hay scheduler.
Los comandos antiguos conservan sus controles y no reciben un modo nuevo peligroso.

La escritura se autoriza **por separado** con `apply-local` y todas las variables
`COURSE_SYNC_*` del CLI existente. Se reutilizan sin excepciones `localSyncConfig` y
`createPostgresStaging`: IP/peer loopback, PG17, base UUID con marca desechable, rol limitado
`cvexpert_sync_ingest`, proveedor autorizado con referencia y ausencia de DML/DDL público.
El destino se vincula al estado antes del primer execute; no se cambia para resolver un
COMMIT incierto. La CLI no crea bases/roles, migra, concede grants ni autoriza proveedores.
No lee `.env`/`PG*` como destino de aplicación. No se requiere migración 006.

RDF no prueba disponibilidad actual, precio, idioma, duración, nivel ni habilidades:
permanecen desconocidos. Las categorías no se convierten en habilidades. No se escribe
`verified`, `review_state` ni `published_course_id`. `retainKnown` y el conflicto editorial
por cambios reales de fuente siguen siendo responsabilidad exclusiva del repositorio.

Las URLs y aliases de los seis cursos de `openlearn-real-courses.json` se usan solo para
detectar coincidencias: `EDITORIAL_IDENTITY_REVIEW_REQUIRED`, candidato `validation=conflict`
y evidencia retenida. Nunca se insertan esos seis registros en el RDF, se adopta su identidad
ni se reclama que el grafo contiene los mismos cursos que el sitio. El conciliador también
protege registros manuales y colisiones con otras identidades presentes en staging.

## Comandos reproducibles

Sin parámetros: fixture en memoria, sin red, SQL ni escrituras. La prueba ejecuta esa CLI
bajo permisos Node 24 sin red/workers/hijos/escritura, con transformación TS nativa.

```powershell
npm run courses:openlearn:incremental
npm run courses:openlearn:incremental -- init --root . --cursor start --pages 2 --requests 4
npm run courses:openlearn:incremental -- fetch --root .
npm run courses:openlearn:incremental -- status --root .
```

Para aplicar, usar una base UUID **ya provisionada** con `withTestDatabase`, migraciones
001–005, marca `cvexpert-course-sync-disposable-v1`, grants existentes y autorización local
del proveedor ([preparación](course-sync-staging-postgres.md)). El demo automatizado de abajo
hace ese ciclo y elimina la base propia en `finally`, usando solo fixtures sintéticos.

```powershell
$env:NODE_ENV = 'development'
$env:COURSE_SYNC_HOST = '127.0.0.1'
$env:COURSE_SYNC_PORT = '55438'
$env:COURSE_SYNC_DATABASE = 'cvexpert_test_<UUID sin guiones de la base marcada>'
$env:COURSE_SYNC_CONFIRM_DISPOSABLE = $env:COURSE_SYNC_DATABASE
$env:COURSE_SYNC_USER = 'cvexpert_sync_ingest'
$env:COURSE_SYNC_PASSWORD = '<contraseña local del rol limitado>'
npm run courses:openlearn:incremental -- apply-local --root .
npm run courses:openlearn:incremental -- fetch --root .
npm run courses:openlearn:incremental -- apply-local --root .
npm run courses:openlearn:incremental -- history-local --root .
```

La segunda consulta usa el cursor confirmado por la primera aplicación. `--cursor` es
obligatorio en init: `start` o una IRI verificada de un recorrido compatible. Un root ya
inicializado no se reinicia. No editar el estado para ampliar límites o saltar errores.

Para un **futuro** piloto autorizado, en un directorio acordado común y tras revisar que
no existe otro piloto/presupuesto activo, usar modo live y referencia propia; init y fetch
no abren PostgreSQL. No repetir el piloto de esta entrega: ya consumió sus cuatro peticiones.

```powershell
$env:NODE_ENV = 'development'
npm run courses:openlearn:incremental -- init --root . --mode live --cursor start --pages 2 --requests 4 --authorize-source REFERENCIA_EXPLICITA
npm run courses:openlearn:incremental -- fetch --root . --mode live --authorize-source REFERENCIA_EXPLICITA
npm run courses:openlearn:incremental -- status --root . --mode live
# Con destino desechable marcado y autorización de ingesta independiente ya configurados:
npm run courses:openlearn:incremental -- apply-local --root . --mode live
# Solo después de confirmar el primer cursor: fetch y apply-local una segunda vez.
npm run courses:openlearn:incremental -- history-local --root . --mode live
```

Para repetir pruebas/demostración con PostgreSQL 17 local y los seis roles desechables
creados como en `.github/workflows/ci-cd.yml`:

```powershell
$env:NODE_ENV = 'test'
$env:PGHOST = '127.0.0.1'
$env:PGPORT = '55438'
$env:PGDATABASE = 'cvexpert_ci'
$env:PGUSER = 'cvexpert_ci'
$env:PGPASSWORD = 'ci-only-disposable-password'
$env:DB_SSL_MODE = 'disable'
$env:PGSSLROOTCERT = ''
$env:PG_READONLY_PASSWORD = 'ci-readonly-disposable-password'
$env:ADMIN_IMPORT_TEST_CA = "$PWD/local-catalog-input/TEST-ca.pem" # CA local de pruebas administrativas
npm run courses:openlearn:incremental:demo
npm run build
npm test
npm run db:test
node --test .github/scripts/*.test.mjs
npm audit --audit-level=high
git diff --check
```

Las pruebas nuevas entran en los globs existentes de `npm test`/`db:test`; el workflow
ya provee PostgreSQL 17 y los roles/grants necesarios, sin excepciones nuevas. Las suites
automatizadas usan transportes inyectados; no consumen red externa ni credenciales reales.

## Evidencia real y validación

El [resumen revisado del piloto](providers/openlearn-incremental-pilot-2026-11-16.json)
conserva veinte IRIs distintas, IDs, títulos, URLs, categorías, tiempos, hashes de consultas,
respuestas, runs y artefactos; contiene solo metadatos mínimos seleccionados. Atribución
The Open University / OpenLearn, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
según el inventario oficial; selección/validación de campos, sin afirmar afiliación.
No contiene respuestas brutas, lecciones, imágenes, credenciales ni aprobaciones.

Piloto 2026-11-16 16:41:57–16:42:14 UTC, cuatro HTTP 200 con pausas >=5 s:

| Estado | Candidatos | Observaciones | Runs | Checkpoints | courses / skills / course_skills |
| --- | ---: | ---: | ---: | ---: | --- |
| Antes, base UUID vacía | 0 | 0 | 0 | 0 | 0 / 0 / 0 |
| Primera página | 10 | 11 | 1 | 1 | 0 / 0 / 0 |
| Segunda página | 20 | 21 | 2 | 1 | 0 / 0 / 0 |

Intersección de IRIs entre páginas: **cero**. Primera frontera `.../retail-marketing/content-section-0`;
segunda `.../the-importance-interpersonal-skills/content-section-0`. `The Beveridge vision`
(ID 29681) trae `Healthcare Careers` y `Nursing`: ambas observaciones se guardaron sin
duplicar el candidato. Ningún curso se aprobó ni publicó y no hubo bajas elegibles.
La base del piloto se eliminó con el helper; los dos artefactos y estado local permanecen
ignorados en este worktree, sin nuevos permisos ni conexión operativa. El resumen versionado
permite revisar lo comprobado aunque no se conserven respuestas brutas completas.

Regresiones cubren primera/segunda página, categorías multivaluadas, ID externo repetido
en otro recurso RDF, duplicados/orden inesperado, truncamiento/conteos, 429/timeout/5xx/JSON,
reserva antes de transporte, dos procesos locales, versión de consulta incompatible,
recuperación tras rename, hash alterado, cambio de destino, run obsoleto, rollback SQL,
COMMIT confirmado con respuesta perdida, idempotencia, desconocidos, conflicto editorial
y de versión, revisión/enlace preservados, recibos/checkpoints y DML público denegado.

Validación final local, Node **24.21.0**, PostgreSQL **17** desechable:

| Comando | Resultado |
| --- | --- |
| `npm run build` | Correcto, ambos proyectos TypeScript. |
| `npm test` | **182/182**, sin omitidas. |
| `npm run db:test` | **122/122**, sin omitidas; migraciones 001–005 y controles administrativos intactos. |
| `npm run courses:openlearn:incremental:demo` | **6/6**, sin red externa. |
| `node --test .github/scripts/*.test.mjs` | **52/52**, sin cambios a workflows. |
| `npm audit --audit-level=high` | **0 vulnerabilidades**. |
| `git diff --check` | Correcto. |

No se ejecutó un nuevo workflow remoto: la rama queda local para revisión, sin push,
merge ni despliegue. Los globs y controles existentes incluyen estas pruebas al abrir el PR.
En Windows dos pruebas existentes comparan textos LF literalmente: se normalizaron
temporalmente esos archivos durante sus comandos y se restauraron sus bytes originales;
no se cambian assertions ni workflows. Las pruebas HTTP existentes requieren sockets
loopback: fuera de esa restricción del sandbox pasan sin cambiar sus controles.

## Pendiente antes de operación

Se necesitan cuota/autorización operativa verificadas, coordinación global durable del
presupuesto, almacenamiento compartido de artefactos/cursores, leases distribuidos,
recuperación operativa de locks/errores, estrategia de cambios e inserciones antes del
cursor y cobertura completa demostrada antes de un scheduler. Esta exclusión local y
estos límites de piloto no bastan para Azure; no se habilita cron ni infraestructura.
Para publicación siguen pendientes verificación individual de vigencia/costo/metadatos,
revisión de identidad URL/RDF y habilidades canónicas, aprobación humana auténtica y
procedimiento administrativo plan/sign/apply/verify autorizado. Ningún artefacto incremental
es CatalogDocument ni autorización para escribir el catálogo público.
