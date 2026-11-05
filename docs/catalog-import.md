# Importación administrativa local de catálogo

Esta CLI permite preparar y revisar habilidades, cursos y relaciones en PostgreSQL
17 **local y desechable/de desarrollo**, usando las tablas de la migración 001.
No es un endpoint ni una funcionalidad desplegada. No habilita `/skills-gap` real,
no carga Azure, no ejecuta migraciones y no introduce un seed de cursos reales.

## Formato JSON v1 y revisión de fuentes

Archivo regular UTF-8, máximo **1 MiB (1 048 576 bytes)**, con estos campos obligatorios:

| Objeto | Campos |
| --- | --- |
| Lote | `formatVersion: 1`, `batchId`, `reviewedAt`, `skills`, `courses` |
| Curso | `title`, `platform`, `url`, `isPaid`, `durationHours`, `logoUrl`, `skills`, `sourceReference` |

`skills` es una lista de nombres canónicos exactos, sensible a mayúsculas y sin
normalización Unicode/sinónimos. En el lote y en cada curso admite de 0 a 1000
nombres distintos. `courses` admite de 0 a 1000 cursos únicos por URL exacta; al
menos una de las dos listas del lote debe contener elementos. Un curso puede no
tener habilidades. Una habilidad referenciada debe estar declarada en `skills`
del lote o existir previamente en `public.skills`; nunca se crea por inferencia.

`isPaid` es booleano. `durationHours` es entero entre 0 y 2147483647 (integer de
PostgreSQL), o `null`; `logoUrl` es URL o `null`. No se reemplaza `null` con cero
ni con cadenas vacías. `reviewedAt` exige una fecha real UTC canónica
`YYYY-MM-DDTHH:mm:ss.sssZ`, años 0001–9999. Valida la representación, no la
vigencia, autenticidad ni calidad de la revisión.

Todos los textos deben ser explícitos, no vacíos, sin espacios exteriores y de
hasta 4096 unidades UTF-16. Se rechazan categorías Unicode Cc, Cf y Cs (controles,
marcas de formato y sustitutos aislados). En v1 se prohíben también `;`, `--`,
`/*` y `*/` en textos y URLs como política conservadora para archivos administrativos;
esto puede excluir títulos/URLs legítimos y requiere revisión, no limpieza automática.
No es el mecanismo de protección SQL: **todos los datos se parametrizan**. Los
apóstrofes legítimos, por ejemplo `O'Reilly`, se preservan como datos.

URLs: prefijo literal `http://` o `https://`, host válido por el parser WHATWG,
sin credenciales (incluso userinfo vacío), espacios, barras invertidas, fragmentos,
escapes porcentuales inválidos o controles/formato/espacios codificados. No se
descargan URLs ni se comprueba que una página exista. No se canonicalizan URLs:
puerto explícito, barra final, query y variantes de escritura siguen siendo
identidades distintas conforme a la clave única original. El revisor debe evitar
duplicados semánticos y no incluir tokens ni secretos en URLs o referencias.

Se rechazan propiedades desconocidas, ausentes, tipos coercibles pero incorrectos,
JSON/UTF-8 inválido y claves repetidas en cualquier objeto, incluidos escapes
equivalentes (`title` y `t\u0069tle`). Habilidades repetidas, URLs repetidas y
asociaciones repetidas se rechazan incluso si sus datos coinciden.

El ejemplo completo está en
[`catalog-import.test.json`](../test/fixtures/catalog-import.test.json):
**solo TEST, ficticio, nunca importar a producción ni presentar como evidencia**.
No se aportan fuentes ni certificaciones inventadas. Antes de cualquier lote real,
una persona debe revisar fuentes, permisos/licencias de uso, nombres canónicos,
precio, duración, correspondencia curso-habilidad y fecha de revisión.

`batchId`, `reviewedAt` y `sourceReference` son evidencia administrativa conservada
en el archivo revisado y en el informe; **no existen columnas que la persistan en
PostgreSQL**. `provenancePersisted: false` lo declara. Conservar archivo e informe
juntos bajo control de acceso; el importador no mantiene un historial persistente.
`documentSha256` es SHA-256 de `JSON.stringify` del documento validado (orden de
campos construido por el parser, arrays conservados), no de los bytes originales.
No es una firma ni certificación. Repetir `batchId` no sustituye la comparación
de contenido y un cambio solo de evidencia no actualiza la base.

## Preparación y comandos

Requiere Node 24, `npm ci`, PostgreSQL 17 local y migraciones existentes aplicadas
por el mantenedor. Usar un shell de mantenimiento separado y configuración privada
PG del proyecto (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, reglas TLS
existentes). No pasar contraseñas como argumentos. Puede usarse
`DOTENV_CONFIG_PATH=.env.maintenance.local`, archivo ignorado por Git.

Solo admite `NODE_ENV=development` o `test`, `PGHOST=127.0.0.1`, `::1` o
`localhost`. Rechaza producción, Azure/remotos y el rol `cvexpert_brecha_app`
incluso para dry-run, y señales de App Service `WEBSITE_INSTANCE_ID`/`WEBSITE_SITE_NAME`.
La CLI resuelve el host, exige todas las direcciones loopback y fija una dirección
numérica. Verifica también host/usuario del pool, peer TCP conectado, `current_user`,
`session_user` y privilegios SQL reales. Nunca imprime objetos del driver ni cadenas
de conexión. Los mensajes de validación no interpolan entradas externas.

Guardar entradas reales fuera del repo o en `local-catalog-input/` (ignorado):

```sh
# Predeterminado: solo consultar, sin escrituras.
npm run db:catalog:import -- --file local-catalog-input/reviewed.json

# Después de revisar el informe y las fuentes:
npm run db:catalog:import -- --file local-catalog-input/reviewed.json --apply
```

No hay opciones de borrado, actualización, force, URL de conexión ni contraseña.
El informe JSON distingue habilidades `insert`/`existing`, cursos
`insert`/`unchanged`/`conflict`, asociaciones `insert`/`existing`/`conflict`, campos
contradictorios y total de cursos en conflicto. Incluye referencias de fuentes.
Las inserciones de un dry-run son propuestas, no filas escritas.

Salida 0: dry-run completado (puede contener conflictos) o aplicación exitosa.
Salida 1: validación, conexión, permisos, integridad o aplicación rechazada.
Al rechazar `--apply` por conflictos, stdout contiene el plan con `mode: rejected`
y stderr un mensaje fijo; no se emite un informe `applied`. Otros errores imprimen
solo un mensaje seguro. Para archivar JSON puro sin el encabezado de npm puede
usarse `npm --silent run db:catalog:import -- ... > informe.json`.

## Persistencia, permisos y conflictos

La identidad de habilidad es su nombre exacto; la de curso es su URL exacta.
Inserta habilidades declaradas y cursos ausentes con sus asociaciones. Un curso
existente debe coincidir en título, plataforma, precio, duración, logo y **conjunto
completo** de habilidades, independientemente del orden. Si coincide, `unchanged`;
si difiere, `conflict`: no añade ni elimina asociaciones del curso existente y
rechaza todo `--apply` antes de escribir. Los cursos/habilidades omitidos se
conservan. Las relaciones nuevas corresponden exclusivamente a cursos nuevos.
Repetir el lote produce `existing`/`unchanged`, sin duplicados ni actualizaciones.
Un conflicto exige una corrección revisada del archivo o un procedimiento separado
de mantenimiento; no se arregla cambiando artificialmente la URL.

Permisos SQL mínimos para **ambos modos**: USAGE en esquema `public`, SELECT,
INSERT y UPDATE en `skills`, `courses`, `course_skills`, y USAGE en las secuencias
`skills_id_seq` y `courses_id_seq`. UPDATE se exige para el bloqueo de tablas
SHARE ROW EXCLUSIVE de PostgreSQL; la herramienta nunca ejecuta UPDATE. No exige
DELETE, TRUNCATE, CREATE, SUPERUSER, CREATEDB ni permisos sobre requisitos de mercado.
El dueño local también cumple. No modifica roles, grants ni permisos del lector HTTP.

Reutiliza `inTransaction`. Dry-run usa REPEATABLE READ y READ ONLY: no ensaya DML
para revertirlo y comparte una instantánea consistente. No reserva el estado ni
prueba triggers/permisos efectivos de una escritura futura. Apply revalida en
READ COMMITTED después de tomar el advisory lock `(834921, 1)` compartido con
migraciones/seed y bloquea las tres tablas en SHARE ROW EXCLUSIVE. Así serializa
importaciones y bloquea DML ajeno al protocolo, permitiendo SELECT HTTP. Los
timeouts del pool existente limitan esperas; un timeout falla de forma segura.
Cualquier fallo revierte todas las filas del lote. Las secuencias identity pueden
consumir números aun con rollback: no se promete IDs consecutivos. No se cambian
las migraciones 001/002 ya aplicadas.

## Riesgos, límites y Azure

Un proxy/túnel local puede aparentar loopback: **no usar túneles, proxies, puertos
redirigidos a Azure ni credenciales productivas**. La herramienta comprueba el
destino accesible pero no puede certificar el origen físico de un servicio detrás
de loopback. NODE_ENV tampoco autentica un entorno. La separación de credenciales,
red y revisión del destino es responsabilidad administrativa.

La validación no acredita fuentes, no deduce sinónimos, no identifica cursos
equivalentes con URLs diferentes ni elimina contradicciones históricas. El informe
contiene evidencia administrativa y debe custodiarse. El tamaño y número de filas
están limitados; una base con asociaciones preexistentes muy grandes puede agotar
timeouts y requiere diagnóstico separado.

La futura carga controlada en Azure requiere **procedimiento separado y aprobación
humana**: identidad de mantenimiento, acceso de red, revisión de fuentes y lote,
respaldo, auditoría persistente y política de correcciones. Este código la rechaza;
no basta cambiar NODE_ENV. No se modifican Express, contratos HTTP, Actions,
Azure, APIM, certificados, Key Vault, Service Bus ni el PR #14.

## Pruebas y empaquetado

```sh
npm ci
npm run build
npm test
npm run db:test
npm audit --audit-level=high
```

Para `db:test`, seguir la configuración local desechable del CI existente con
PostgreSQL 17: usuario propietario `cvexpert_ci` con CREATEDB (solo el harness lo
necesita), rol `cvexpert_brecha_app` LOGIN sin privilegios administrativos y
`PG_READONLY_PASSWORD`. Publicar el contenedor únicamente en loopback, configurar
variables PG locales y `NODE_ENV=test`, `DB_SSL_MODE=disable` y `PGSSLROOTCERT` vacío.
El helper crea bases `cvexpert_test_<UUID>` desde template0 y elimina solo las
bases que creó, incluso ante fallos. No apuntar los tests a una base compartida.

Las pruebas incluyen CLI real, validación, claves duplicadas/escapadas, UTF-8 y
límite de bytes, NULL, M:N, dry-run, idempotencia, conflictos de campos/conjuntos,
rollback por integridad después de escrituras, inyección, concurrencia, denegación
por identidad SQL real, destinos remotos/producción y consumo por `/courses`.
Sin Docker/PostgreSQL no declarar aprobadas las integraciones omitidas.

`scripts/` se comprueba con `tsconfig.maintenance.json` sin emitir; `dist` solo
contiene el código de `src`. El empaquetador existente usa allowlist de dist,
manifiestos, OpenAPI y dependencias de producción: excluye scripts, fixtures y
entradas locales. `tsx` es dependencia de desarrollo. El comando permanece en el
manifiesto como ocurre con mantenimiento de mercado, pero el importador no se
distribuye ni funciona en el ZIP de producción. No se modifica el empaquetador.

La evidencia de esta implementación está en
[`catalog-import-verification.md`](catalog-import-verification.md).
