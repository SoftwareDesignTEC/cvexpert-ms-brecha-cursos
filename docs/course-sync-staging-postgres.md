# Course Sync — Fase 3A

La fase guarda propuestas y evidencia en PostgreSQL 17. No publica, aprueba habilidades,
adopta cursos existentes ni desactiva el catálogo público. No conecta proveedores: consume
un `SyncRun` ya obtenido. Saylor/OpenLearn y los endpoints permanecen sin cambios.

## Auditoría y compatibilidad

Base: `origin/develop` en `fada6a1`, con PR #27, #28 y #29. Worktree
`.worktrees/course-sync-staging-postgres`, rama `codex/course-sync-staging-postgres`.

Se revisaron migraciones 001–004, `course-sync` (modelo, normalización, conciliación y
worker), `course-discovery` (proveedores, caché y cuotas), los repositorios de cursos y
recomendaciones, importadores de catálogo/mercado, plan/sign/apply/verify, helper de bases
desechables y workflows/roles. Los lectores HTTP consultan exclusivamente `public`.
El motor `reconcile` permanece intacto. Solo se extiende su vocabulario opcional de
precio y su validación; no se modifican los adaptadores.

005 es aditiva y no cambia 001–004 ni concede permisos a identidades existentes.
El preflight administrativo conserva la comparación exacta de nombres/checksums:
ahora exige 001–005. Una base con solo 001–004 debe aplicar 005 mediante mantenimiento
autorizado antes de usar ese preflight; la CLI de sincronización no migra bases.
No se sustituye el proceso administrativo ni se consumen sus permisos desde la ingesta.

## Esquema y significado de los valores

Todo lo nuevo reside en el esquema privado `course_sync`:

| Tabla | Responsabilidad |
| --- | --- |
| `providers` | Identificador, autorización pendiente/autorizada/revocada y referencia de revisión. La ingesta solo lee. |
| `candidates` | UUID de staging, identidad, URL/título, documento observado conocido, documento editorial independiente, revisión, ausencias, versión y enlace editorial opcional al catálogo. |
| `observations` | Documento normalizado de cada observación válida por ejecución y ordinal; conserva duplicados y discrepancias para auditoría. No se actualiza. |
| `runs` | Identidad de ejecución por proveedor, hash de entrada, cobertura/errores, estado, resultados y fecha. No se actualiza. |
| `checkpoints` | Última ejecución procesada por proveedor; FK a su recibo durable. El historial queda en `runs`. |

Las identidades son tuplas `[sourceId,"id",externalId]`; únicamente un `externalId:null`
habilita `[sourceId,"url",canonicalUrl]`. El campo relacional `identity_key` usa la
representación textual JSONB de esa tupla. Cambiar la URL con ID estable conserva el UUID;
sin ID estable genera otra propuesta y nunca reclama automáticamente la anterior.
Una URL canónica globalmente única y la conciliación detectan colisiones entre fuentes.

| Valor | Representación |
| --- | --- |
| Desconocido | `null`, `unknown`, o colección vacía en la observación; `price` puede omitirse. Los demás campos del contrato deben existir. |
| Observado | `observations.document` conserva exactamente la observación normalizada; `candidates.observed` conserva conocimiento acumulado. |
| Verificado editorialmente | `candidates.verified`, con identidad de revisor y fecha; la ingesta no tiene INSERT/UPDATE sobre estas columnas. |
| Publicado | Registro real en `public.courses`; el enlace opcional requiere ID existente, revisor y fecha. No copia ni publica valores. |

`observed` acumula campos opcionales conocidos: un nuevo `null`, `unknown` o lista de
habilidades vacía no borra conocimiento previo. Las convocatorias omitidas permanecen;
las informadas conservan fechas/ubicación/modalidad desconocidas, y una retirada explícita
es una propuesta revisable. El historial original permite distinguir el dato retenido
del dato observado en el último recorrido. Campos ausentes del contrato obligatorio
invalidan el registro y tampoco borran información.

`verified` es un documento completo, no una aprobación automática de `observed`.
Sus valores conocidos se protegen contra propuestas divergentes. Un conflicto conserva
el candidato completo, guarda la observación y registra `EDITORIAL_CONFLICT` o
`VERSION_CONFLICT` en el resultado durable. La ingesta no cambia `review_state`; el
editor consulta los resultados de `runs` para resolver conflictos y cambiar ese estado.
Los campos editoriales desconocidos no conceden aprobación a valores nuevos.
Un rechazo editorial tampoco concede permisos de publicación al worker.

## JSONB, constraints e índices

Identidad, FK de fuente, unicidad de URL, título, revisión, origen, fechas de última
observación, ausencias 0–3, versión positiva y vínculo al catálogo son relacionales.
Las fuentes admiten hasta 128 caracteres ASCII alfanuméricos, punto, guion y guion bajo;
el ID externo tiene máximo 512 caracteres y la URL canónica máximo 2000. Estas cotas
mantienen las claves únicas dentro del límite de los índices B-tree de PostgreSQL.
Checks impiden documentos que discrepen de identidad/URL/título relacionales, fechas de
última observación incoherentes, revisión verificada sin documento/revisor/fecha y vínculos
sin revisión. El trigger incrementa la versión incluso en ediciones editoriales, hace
inmutables fuente/ID externo/origen y protege las observaciones de registros manuales.
La FK al curso publicado es `RESTRICT`, sin cascadas sobre el catálogo.

JSONB conserva el vocabulario existente de metadatos, evidencia y convocatorias. La
función SQL `valid_document` verifica campos obligatorios, tipos, estados, duración
positiva entera, habilidades como strings, evidencia no vacía con SHA-256 y fecha
coherente, convocatorias con identidades distintas y fechas ordenadas. Precio opcional:
`{ "amount": "25.00", "currency": "USD" }`, decimal no negativo de hasta 12 dígitos
enteros y 4 decimales, moneda de tres letras mayúsculas; no se infiere una tarifa desde
`isPaid`. SQL no verifica externamente la moneda ni la veracidad del proveedor.
`normalize()` vuelve a validar los documentos en cada lectura y escritura: fechas UTC
reales, URLs HTTPS conservadoras, procedencia, duplicados de habilidades, límites de
longitud y ubicación. El validador SQL protege estructura/invariantes y no reemplaza
esa validación semántica; el acceso SQL directo de mantenimiento es de confianza.
La evidencia no acredita aprobación editorial ni pertinencia automática de habilidades.

PK/unique cubren proveedor-identidad y URL; índices adicionales cubren revisión por
fuente, enlace publicado, observaciones por identidad e historial por fuente/fecha.
No se crean índices GIN: las consultas operativas usan las claves relacionales.

## Transacción, concurrencia y recuperación

`CourseSyncStaging` expone `load()` (snapshot/versions) y `execute(run,expectedVersions?)`.
`createPostgresStaging` implementa el puerto sin importar repositorios HTTP.

1. Verifica destino local desechable, identidad limitada, versión 17 y permisos efectivos.
2. Adquiere un advisory lock transaccional exclusivo de staging `(834921,5)`.
3. Resuelve replay por `(source_id,run_id)` y hash canónico de entrada + versiones esperadas.
4. Exige proveedor autorizado; lee staging con `FOR UPDATE` y los checkpoints.
5. Ejecuta el `reconcile` existente sobre ese snapshot, nunca sobre tablas públicas.
6. Conserva campos conocidos después de detectar duplicados/conflictos en la entrada
   original. Comprueba versiones esperadas y valores editoriales; no elige un ganador.
7. Guarda únicamente propuestas aceptables, observaciones válidas, recibo y checkpoint
   en la misma transacción; confirma COMMIT.

El lock global inicial evita carreras de URL entre proveedores; sacrifica paralelismo
por seguridad en esta fase. Los locks de filas y el trigger de versión coordinan
editores con ingestas. Una revisión basada en un snapshot anterior debe suministrar
`expectedVersions`; una divergencia se registra sin sobrescribir. El SQL de guardado
también exige la versión leída. Las modificaciones editoriales externas deben usar
`UPDATE ... WHERE candidate_id=... AND version=...` y exigir una fila afectada.

Repetir el mismo run devuelve el resultado previo sin DML. Reusar su ID con otra entrada
o versiones esperadas falla. Un recorrido anterior al checkpoint se audita como omitido
y no retrocede estado. El checkpoint significa procesado, no catálogo completo/exitoso:
estado, flags, errores y acciones permanecen en el recibo. Incluso observaciones
sintácticamente válidas pero ambiguas u obsoletas se retienen para auditoría, sin aplicarlas.
Las inválidas dejan su acción/rechazo, no un documento candidato supuestamente válido.

Solo catálogos completos/válidos, sin páginas faltantes, cuotas, errores ni conflictos
cuentan ausencias. Se conserva la defensa de retiradas masivas existente. Tres ausencias
proponen revisión; no cambian publicación. Conflictos editoriales/de versión también
inhabilitan ausencias para todo el recorrido.

Se reintenta la transacción completa hasta tres intentos para `40001`, `40P01`, `55P03`.
No se reintentan automáticamente errores de validación, autorización o identidad.
Un fallo antes de COMMIT revierte todo. `COMMIT_UNCERTAIN_RETRY_SAME_RUN` obliga a repetir
la misma entrada: el recibo durable distingue confirmado de no confirmado sin duplicados.
Los intentos abortados no generan recibo confirmado; el llamador conserva su error y
repite el run, mientras que `status:failed` del proveedor sí tiene recibo durable.

## Permisos y ejecución local explícita

Roles independientes, LOGIN limitados, sin membresías entre ellos:

| Rol | Acceso |
| --- | --- |
| Dueño de mantenimiento | Aplica migraciones/provisiona únicamente la base desechable elegida. No se utiliza en el worker. |
| `cvexpert_sync_ingest` | SELECT staging; INSERT de observaciones/runs/propuestas; UPDATE de columnas observadas y checkpoint. Sin DELETE, edición, autorización o catálogo. |
| `cvexpert_sync_editor` | SELECT staging; autorización de fuentes y UPDATE de columnas editoriales/vínculos. Sin UPDATE de observaciones ni permisos administrativos de catálogo. |
| `cvexpert_brecha_app` | Sus SELECT públicos actuales; ningún grant nuevo ni acceso a staging. |
| Importadores administrativos | Sus permisos previos y flujo firmado independiente. Ningún grant nuevo de staging. |

`db/course-sync-local-grants.sql` no crea roles. Se aplica como dueño después de 005,
solo sobre una base `cvexpert_test_<32 hex>` PostgreSQL 17 marcada explícitamente por
su dueño con el comentario `cvexpert-course-sync-disposable-v1`. El SQL comprueba nombre,
marca, versión y conexión TCP; la CLI/repositorio además comprueban el peer TCP loopback
real. Docker puede presentar una dirección interna de puente en `inet_server_addr()`;
no se confunde esa dirección con el peer al que se conectó el cliente.
La marca es una declaración explícita del dueño de que la base es desechable, no debe
aplicarse a una base compartida. No existe inicialización automática ni opción remota.

Para validar el ciclo completo usar el helper `withTestDatabase`: crea una base UUID
propia, la elimina al terminar y siempre exige entorno development/test y loopback.
La suite nueva aplica 001–005, marca esa base y provisiona los grants dentro del callback.
CI crea previamente los LOGIN limitados en el servicio `postgres:17-bookworm` existente;
la suite corre mediante `npm run db:test`, sin skips ni cambios de controles anteriores.

En una base desechable así provisionada, la aplicación explícita utiliza exclusivamente
`COURSE_SYNC_*`; no lee `.env`, `PG*` ni credenciales administrativas:

```powershell
$env:NODE_ENV = 'development'
$env:COURSE_SYNC_HOST = '127.0.0.1'
$env:COURSE_SYNC_PORT = '55438' # puerto local del PostgreSQL 17 desechable
$env:COURSE_SYNC_DATABASE = 'cvexpert_test_<32 hex de la base creada por el helper>'
$env:COURSE_SYNC_CONFIRM_DISPOSABLE = $env:COURSE_SYNC_DATABASE
$env:COURSE_SYNC_USER = 'cvexpert_sync_ingest'
$env:COURSE_SYNC_PASSWORD = '<contraseña local del rol limitado>'
npm run courses:sync:local -- --apply-local ./local-catalog-input/TEST-run.json
```

El archivo es un `SyncRun` del modelo existente (ver `test/fixtures/course-sync.test.ts`),
no un documento de importación pública. La lectura tiene límite de tamaño, exige UTF-8
válido y rechaza claves JSON duplicadas. Repetirlo permite resolver un COMMIT incierto.
El proveedor debe haber sido autorizado previamente por el editor con referencia de revisión.
No hay scheduler, conexión a Azure, despliegue, publicación ni descubrimiento en esta CLI.

## Validación

```text
npm run build
npm test
npm run db:test
node --test .github/scripts/*.test.mjs
git diff --check
```

Las pruebas DB usan exclusivamente PostgreSQL 17 desechable con roles reales. Incluyen
inserción/replay, identidad y URL, desconocidos, precio/ubicación/convocatorias,
duplicados/colisiones, revisión/versiones, registros manuales, carreras, rollback antes
de COMMIT, respuesta COMMIT perdida, reintentos transitorios, checkpoint atómico,
cobertura incompleta, tres ausencias, JSON inválido y DML de catálogo denegado.
También se ejecuta la suite administrativa previa con TLS verificado y el flujo CLI
plan/sign/apply/verify; los datos públicos que esa suite escribe son fixtures sintéticos
dentro de sus bases UUID desechables. No se toca ningún catálogo operativo.
