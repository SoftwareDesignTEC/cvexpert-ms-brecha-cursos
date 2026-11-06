# Procedimiento administrativo: catálogo y mercado en Azure PostgreSQL

Esta entrega prepara revisión offline y **dry-run exclusivamente de lectura**.
No implementa aplicación remota. No hay endpoint HTTP, despliegue, migración nueva,
seed ni modificación de APIM, App Service o Actions. Los importadores locales
mantienen sus restricciones y opciones originales; nunca usarlos con túneles a Azure.

## Alcance y revisión previa

El operador debe custodiar catálogo, mercado, escala y destino revisados fuera de
Git (por ejemplo `local-admin-import/`, ignorado). Los formatos y reglas siguen
[catálogo](catalog-import.md) y [mercado](market-import.md): los mismos parsers y
planificadores de consulta sirven a ambas CLIs. No se normalizan nombres, no se
convierten escalas ni se fabrican niveles, referencias o fechas. Se rechaza mercado
`demo`. La revisión humana debe excluir también fixtures TEST, cursos ficticios y
secretos dentro de referencias/URLs: una clasificación `reference` no prueba calidad.

Se revisaron las migraciones históricas sin alterarlas:

| Migración | Relevancia |
| --- | --- |
| 001 | skills, courses, course_skills; identidad exacta por nombre/URL y conjunto completo de asociaciones. Sin columnas de procedencia del catálogo. |
| 002 | market_requirements; FK a habilidad existente, contexto/escala, nivel nullable, fuente, fecha y clasificación. |
| 003 | user_skill_snapshots; ajena a la importación, no leer ni conceder acceso a esta identidad. |

El historial completo de `schema_migrations` debe coincidir exactamente en nombre,
orden y SHA-256 con 001–003 de esta revisión. Una migración futura requiere revisar
esta herramienta; no omitir la comprobación ni ejecutar migraciones automáticamente.
El checksum del historial no certifica por sí solo el DDL efectivo del servidor.

## 1. Validación offline, sin red

Requiere Node 24 y dependencias de desarrollo instaladas (`npm ci`). Desde un
checkout revisado, crear `local-admin-import/target.json` con exactamente estos campos
(valores ilustrativos, **no recursos configurados**):

```json
{
  "server": "servidor-revisado.postgres.database.azure.com",
  "port": 5432,
  "database": "base_revisada",
  "identity": "mantenedor_preview"
}
```

Solo se admite FQDN Azure público canónico en minúsculas; con Private Link se usa
el mismo FQDN y DNS privado. No admite alias, URL de conexión ni host loopback en
la CLI. El puerto entero explícito debe coincidir con la sesión SQL; normalmente
5432. El archivo de destino se aprueba por una segunda persona contra el inventario
administrativo. No se descubre ni se elige un servidor automáticamente.

```sh
npm --silent run db:admin:preview -- --target local-admin-import/target.json --catalog local-admin-import/catalog.json --market local-admin-import/market.json --scale local-admin-import/scale.json
```

El resultado `mode: offline-validation` solo acredita sintaxis y reglas de entrada;
`databaseChecked: false`. No crea un pool ni requiere credenciales. No es un plan
de inserción. Los cuatro archivos usan el lector compartido: UTF-8 estricto,
archivo regular, máximo 1 MiB, rechazo de claves repetidas/escapadas.
`--apply`, `--force`, `--allow-updates` y opciones desconocidas/repetidas se rechazan.

## 2. Preparación futura del dry-run conectado

**No ejecutar durante desarrollo ni como parte del PR.** Una autorización operativa
posterior debe aprobar destino, ventana de consulta, origen de red y fuentes. No
cambiar firewall, red, grants ni recursos Azure desde esta herramienta. Ejecutar en
una estación administrativa autorizada; App Service y GitHub Actions se rechazan.

Usar una identidad dedicada a revisión. Rechaza `cvexpert_brecha_app` (incluida
variante `@servidor` y mayúsculas) y exige coincidencia exacta de `current_user` y
`session_user` con el destino revisado. No admite `SET ROLE`. Tampoco permite roles
con SUPERUSER, CREATEDB, CREATEROLE, REPLICATION o BYPASSRLS, incluso por membresía.

Permisos mínimos que un DBA debe revisar y conceder **por un cambio separado**:

- CONNECT a la base y USAGE en `public`.
- SELECT en `public.skills`, `public.courses`, `public.course_skills`,
  `public.market_requirements`, `public.schema_migrations`.
- Sin INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES o TRIGGER en esas tablas;
  sin CREATE en `public`; sin acceso a `user_skill_snapshots`.

No se requieren secuencias, propiedad de objetos, permisos de migración o capacidad
de escritura. Se comprueban privilegios efectivos, incluidos heredados/PUBLIC.
Si PUBLIC tiene CREATE o acceso a snapshots, se detiene; su corrección requiere
revisión DBA independiente. La herramienta no concede ni revoca privilegios.
No pretende auditar todos los objetos, funciones o vías de escalación de la base;
el DBA debe revisar membresías y grants ajenos a estas tablas antes de habilitarla.

Inyectar exclusivamente en el proceso administrativo mediante un almacén seguro:

| Variable | Uso |
| --- | --- |
| ADMIN_IMPORT_SERVER | Coincidencia exacta con server aprobado |
| ADMIN_IMPORT_PORT | Coincidencia decimal exacta con port aprobado |
| ADMIN_IMPORT_DATABASE | Coincidencia exacta con database aprobado |
| ADMIN_IMPORT_IDENTITY | Coincidencia exacta con identity aprobada |
| ADMIN_IMPORT_PASSWORD | Contraseña/token de corta duración; nunca argumento ni archivo versionado |
| ADMIN_IMPORT_CA_FILE | Opcional: bundle CA aprobado; de lo contrario trust store de Node |

No se selecciona el destino desde PG*, DATABASE_URL ni configuración del backend.
El lector JSON heredado carga dotenv, pero la conexión administrativa solo consume
ADMIN_IMPORT_* y sus controles de entorno. Mantener el shell separado y sin `.env`
operativo del backend. No registrar variables, objetos de pool o cadenas de conexión.

La configuración fija TLS con `rejectUnauthorized: true` y SNI del FQDN aprobado.
Se rechaza `NODE_TLS_REJECT_UNAUTHORIZED=0`. La sesión verifica socket TLS autorizado,
nombre de servidor, TLS 1.2/1.3 y `pg_stat_ssl` de su propio PID; compara base,
identidades, puerto efectivo y registra dirección del servidor. La identidad del
servidor se fundamenta en DNS + certificado para ese FQDN + CA aprobada, no en una
dirección IP fija (Azure puede cambiarla). Revisar también NODE_OPTIONS, trust store,
checkout y dependencias de la estación; una CA maliciosa rompe esa confianza.

Solo después de esa revisión, el siguiente **comando futuro** habilita conexiones:

```sh
npm --silent run db:admin:preview -- --target local-admin-import/target.json --catalog local-admin-import/catalog.json --market local-admin-import/market.json --scale local-admin-import/scale.json --connect-azure > local-admin-import/preview.json
```

Desde el inicio de conexión se establece `default_transaction_read_only=on`.
Se abre una única transacción REPEATABLE READ, READ ONLY que incluye preflight y
ambos planes. Solo ejecuta SELECT y controles transaccionales: no prueba DML para
revertirlo, no consume secuencias, no toma locks de escritura. Hay timeouts de
conexión (5 s), sentencia (15 s), lock (5 s) e inactividad transaccional (30 s).
El COMMIT de lectura cierra la instantánea; no aplica ninguna propuesta.

## 3. Interpretar y custodiar el informe

El reporte incluye UUID, fecha UTC, destino e identidad comprobados, TLS, permisos,
migraciones y hashes SHA-256 del conjunto validado y de cada documento. Los hashes
usan JSON.stringify del resultado de los parsers (no bytes originales, arrays con
su orden validado); no son firmas ni autorización para importar.

`catalog` distingue habilidades/asociaciones insert/existing y cursos
insert/unchanged/conflict con campos discrepantes y referencias. `market` conserva
before/after, fuentes, fechas e insert/unchanged/update. Un update con observación
posterior exige revisión explícita futura (`requiresUpdateReview`); nunca se aplica.
Errores de negocio del contexto de mercado o referencias ausentes se reportan como
conflicto de ámbito, con `market: null`: significa **plan bloqueado**, no cero cambios.
Lo mismo ocurre con un catálogo que referencia habilidades ausentes no declaradas.
Errores SQL/TLS/permisos abortan sin informe de éxito y con mensaje fijo sin datos
del driver. Los motivos de conflicto proceden de mensajes fijos de validadores.

`summary` cuenta inserciones/existentes por filas de catálogo (incluye relaciones),
filas de mercado, updates por revisar y conflictos. Un conflicto de contexto cuenta
una vez aunque abarque varias filas. No calcula un upsert entre ambos documentos:
mercado exige habilidades **ya persistidas**; habilidades nuevas propuestas por
catálogo producen un bloqueo de mercado. La futura aplicación conjunta deberá
revalidar mercado después de insertar catálogo dentro de su transacción.

Salida 0: validación/consulta completa; puede contener updates pendientes de revisión.
Salida 2: consulta completa con conflictos de negocio (se conserva JSON revisable).
Salida 1: error de entrada, destino, red, TLS, identidad, privilegios o historial.
`applyAvailable: false` siempre. Ninguna salida autoriza escrituras.

Custodiar juntos originales, destino, escala, reporte, SHA-256 de sus bytes,
commit exacto (`git rev-parse HEAD`), operador, aprobador y ticket. Usar ACL y archivo
inmutable/firmado según la política del equipo; no se implementa un almacén de
auditoría remoto aquí. No subir informes operativos al PR ni publicarlos en logs.
El informe incluye datos de entrada/BD y referencias: **no deben contener secretos**.
La procedencia del catálogo permanece externa (`provenancePersisted: false`);
fuente/fecha de mercado existen en 002, pero no hay historial de versiones.

## 4. Diseño de aplicación futura y recuperación (no implementado)

Requiere otro cambio revisado y autorización operativa; no ampliar los importadores
locales ni añadir HTTP. Antes de habilitar aplicación:

1. Aprobar fuentes, escala, destino, commit, hashes, plan sin conflictos y updates
   específicos. Preparar identidad de aplicación temporal con DML mínimo, distinta
   del lector y del rol HTTP. Definir auditoría persistente e identificador único de
   ejecución mediante una migración nueva si se necesita, nunca editar 001–003.
2. Comprobar restauración/PITR y retención disponibles y ensayar recuperación en un
   recurso aislado; registrar punto temporal y responsables. Exportar before-images
   de las filas afectadas con claves/relaciones, hashes y acceso restringido.
3. Una opción explícita futura deberá exigir artefacto aprobado y su hash, volver
   a verificar sesión/TLS/grants e historial, y recomputar el plan bajo el advisory
   lock `(834921, 1)` compartido con migraciones/seed y locks de tablas en orden fijo
   skills, courses, course_skills, market_requirements (SHARE ROW EXCLUSIVE).
   Usar una sola transacción READ COMMITTED: revalidar **después** de bloquear;
   abortar ante divergencias del plan aprobado. No reutilizar una instantánea vieja.
4. Insertar catálogo sin modificar cursos existentes; validar y aplicar mercado
   sobre el estado transaccional resultante, sin borrar omitidos ni inventar fechas.
   Registrar auditoría durable en la misma transacción y verificar row counts,
   restricciones y estado final antes de COMMIT. Cualquier fallo: ROLLBACK completo.
   Secuencias pueden tener huecos tras rollback. Probar fallos parciales y concurrencia.
5. Ante pérdida de conexión durante COMMIT, resultado desconocido: no reintentar a
   ciegas. Consultar identificador/auditoría durable y estado con otra sesión de
   lectura; reconciliar hashes y reportar resultado. Este dry-run aún no provee ese
   protocolo, por lo que no debe adaptarse informalmente para escribir.
6. Tras COMMIT, verificar con rol lector y retirar credenciales temporales. Si hay
   que revertir, aprobar una compensación transaccional basada en before-images y
   comprobar que cada fila aún coincide con el after-image; abortar si hubo cambios
   posteriores. Borrar solo filas demostrablemente creadas por la ejecución, respetar
   FKs y no borrar habilidades/cursos ahora referenciados. Nunca truncar o reseedear.
   Para daño mayor, restaurar PITR a otro servidor, validar y coordinar recuperación
   selectiva/cambio de destino mediante un incidente independiente.

Un dry-run no reserva datos, prueba triggers de escritura, verifica cuotas ni
garantiza que una aplicación futura vaya a tener permisos. Las lecturas prolongadas
retienen snapshots y pueden impactar recursos; ejecutar por lotes revisados y con
ventana autorizada. No hay conexión a Azure durante desarrollo/verificación.

## Pruebas locales

```sh
npm run build
npm test
npm run db:test
```

La suite DB usa el helper existente que solo acepta loopback development/test,
crea `cvexpert_test_<UUID>` y elimina únicamente sus bases. Seguir la preparación
de PostgreSQL 17 en [catálogo](catalog-import.md). Nunca usar proxies a Azure.
Las pruebas nuevas de planificadores siempre corren. La subprueba TLS completa
requiere un servidor desechable local TLS y `ADMIN_IMPORT_TEST_CA` (PEM del CA de
prueba). Sin esa variable se marca omitida explícitamente; no afirmar TLS probado.

Para reproducir la subprueba TLS: generar fuera de Git un certificado de prueba
autofirmado con SAN `test.postgres.database.azure.com` (openssl req -x509), configurar
ssl=on, ssl_cert_file y ssl_key_file en **esa instancia desechable**, y crear por
su dueño el rol `cvexpert_admin_preview_test` LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
NOINHERIT, contraseña **solo prueba** `TEST-preview-only`. Usar PGHOST=127.0.0.1,
PGPORT del servidor, NODE_ENV=test, DB_SSL_MODE=disable y las credenciales desechables
habituales del harness. ADMIN_IMPORT_TEST_CA apunta al PEM público de prueba.
El test abre su propio pool TLS a loopback con SNI ficticio y CA explícita; la CLI
productiva no tiene esa excepción ni opción para desactivar TLS.

Ver [evidencia local](admin-import-verification.md) para resultados y limitaciones.
