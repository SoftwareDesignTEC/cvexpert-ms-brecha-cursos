# Importación administrativa de catálogo y mercado

La operación `db:admin:apply` escribe realmente catálogo y requisitos en una sola
transacción. No usa HTTP ni despliega o configura el backend. Los importadores
locales conservan sus restricciones. `db:admin:preview` sigue siendo offline o
READ ONLY; para la aprobación conjunta usar `db:admin:plan`, también READ ONLY.

## Requisitos operativos

Antes de conectar a Azure se requiere autorización humana del PR, destino y datos.
El desarrollo y CI solo usan PostgreSQL 17 desechable en loopback, sin túneles.

Un DBA debe aplicar **004_create_admin_import_runs.sql** con el migrador revisado
y autorizar dos LOGIN separados del usuario HTTP y de `cvexpert_pgadmin`. 001–003
no cambian. El historial completo y sus checksums deben coincidir con 001–004.
La herramienta no ejecuta migraciones, CREATE ROLE, GRANT, firewall ni passwords.

Permisos efectivos, sin propiedad ni membresías privilegiadas:

| Objeto | Lector | Escritor |
| --- | --- | --- |
| Base / public | CONNECT / USAGE, sin CREATE | Igual |
| skills, courses, course_skills, market_requirements, schema_migrations, admin_import_runs | SELECT | SELECT |
| skills, courses, course_skills, market_requirements, admin_import_runs | Sin DML | INSERT |
| skills_id_seq, courses_id_seq | Ninguno requerido | USAGE |
| lock_admin_import_tables() | Sin EXECUTE | EXECUTE |
| user_skill_snapshots | Ningún acceso | Ningún acceso |

Ambos carecen de UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER sobre estas tablas y
escritura sobre schema_migrations. Solo si se aprobaron updates concretos de mercado,
conceder temporalmente UPDATE **por columnas** en market_requirements:
`scale_key, required_level, source_reference, observed_at, data_kind`.
Nunca UPDATE sobre courses/skills/course_skills ni las claves de mercado.
El plan firmado contiene cada before/after y requiere `review.marketUpdates=true`.
No se eliminan requisitos omitidos, ni se cambia automáticamente escala o clase.

La función SECURITY DEFINER de 004 solo bloquea cinco tablas explícitas, con
search_path fijo y EXECUTE revocado a PUBLIC. Evita otorgar UPDATE/DELETE sobre
catálogo para adquirir locks. Su dueño debe ser el dueño de migraciones revisado;
el DBA debe revisar DDL efectivo, triggers, funciones, membresías y grants ajenos
al alcance. Los checksums del historial no son una certificación del DDL efectivo.
No otorgar acceso a esta función ni a la auditoría al usuario HTTP.

Usar checkout/Node 24/dependencias revisados en estación administrativa, trust store
y CA confiables, origen de red autorizado y respaldo/PITR disponible. Custodiar
archivos, propuestas, aprobaciones, claves y recibos fuera de Git, por ejemplo en
`local-admin-import/` (ignorado). No incluir secretos en fuentes ni URLs.

## Archivos y credenciales

Los mismos formatos/validadores de [catálogo](catalog-import.md) y
[mercado](market-import.md) se reutilizan, incluyendo nulos, nombres/URLs exactos,
escala ordinal, fechas UTC y asociaciones completas. JSON regular UTF-8, máximo
1 MiB, claves repetidas prohibidas. `evidence` es el documento de revisión de fuentes.
Un hash no certifica calidad editorial: el aprobador debe comprobar fuentes,
vigencia y decisiones de niveles. Mercado demo y marcadores `[DEMO]` se rechazan;
la revisión humana debe excluir además contenido ficticio mal etiquetado.

Crear `writer-target.json` y `reader-target.json`, con exactamente cuatro campos:

```json
{
  "server": "servidor-revisado.postgres.database.azure.com",
  "port": 5432,
  "database": "base_revisada",
  "identity": "identidad_limitada_revisada"
}
```

Solo difieren en identity. No se admiten alias, connection strings, destinos
locales ni SET ROLE. La configuración administrativa consume exclusivamente:

- ADMIN_IMPORT_SERVER, ADMIN_IMPORT_PORT, ADMIN_IMPORT_DATABASE,
  ADMIN_IMPORT_IDENTITY: deben coincidir exactamente con el destino correspondiente.
- ADMIN_IMPORT_PASSWORD: inyectada en el proceso desde almacén seguro, jamás argumento.
- ADMIN_IMPORT_CA_FILE: opcional, CA PEM confiable; si falta, trust store de Node.
- ADMIN_IMPORT_APPROVER_KEY_SHA256: fingerprint SHA-256 del DER SPKI de la clave
  Ed25519 del aprobador, distribuido por un canal independiente y confiable.

No usar PG*, DATABASE_URL o .env del backend para seleccionar el destino. Revisar
NODE_OPTIONS y CA del proceso. TLS no es configurable a inseguro: certificado/SNI,
TLS 1.2/1.3 y pg_stat_ssl obligatorios. Se compara base, current_user, session_user y
puerto SQL; se rechazan rol HTTP, pgadmin para apply, privilegios elevados, App
Service y marcadores habituales de CI (incluido CI=true). No hay excepción local
en la CLI productiva. No es posible detectar todos los hosts/CI encubiertos: la
estación y el operador son parte de la confianza.

## Plan, aprobación y carga

Los siguientes son comandos **para una ventana futura autorizada**. Ninguno debe
usarse contra Azure como parte de la verificación del PR.

Con credenciales del lector, generar propuesta sin escrituras ni consumo de secuencias:

```powershell
$datos = 'local-admin-import/datos'
$base = @('--catalog', "$datos/catalogo-candidato.json", '--market', "$datos/requisitos-solvo-python-junior-candidato.json", '--scale', "$datos/escala-cv-skill-v1.json", '--evidence', 'local-admin-import/evidencia/fuentes-y-criterios.md')
npm run db:admin:plan -- @base --target local-admin-import/writer-target.json --reader-target local-admin-import/reader-target.json --output local-admin-import/proposal.json
```

El plan conjunto admite habilidades declaradas que aún no existen. Incluye catálogo,
antes/después de requisitos y estado completo del contexto de mercado. Los conflictos
rechazan la propuesta; no se sobrescriben cursos diferentes. Se incluyen hashes de
bytes de los cuatro archivos y del contenido validado. Conserva UUID único de ejecución.

El aprobador revisa originales, fuentes, plan y destino. En `proposal.json` completa
`reviewer`, `ticket`, `approvedAt`, `expiresAt` (UTC ISO, ventana explícita) y cambia
`review.sources`, `review.editorialLevels`, `review.freshness`, `review.authorizeWrites`
a true solo tras revisión. `review.marketUpdates` solo si acepta todos los before/after
mostrados. No modificar hashes ni plan para sortear conflictos: generar nueva propuesta.

Usar una clave Ed25519 custodiada por el aprobador (PKCS8 PEM privada y SPKI PEM
pública). Puede generarse offline una vez con `openssl genpkey -algorithm ED25519`
y exportar pública con `openssl pkey -pubout`; nunca versionar ni entregar la privada
al operador de aplicación. El comando de firma no rellena decisiones de revisión:

```powershell
npm run db:admin:sign -- --proposal local-admin-import/proposal.json --private-key RUTA_PRIVADA/aprobador.pem --output local-admin-import/approval.json
```

La firma cubre JSON canónico con claves ordenadas, arrays conservados y fechas UTC.
`sign` imprime el fingerprint público para distribuirlo por el canal independiente.
La firma es una confirmación verificable de quien custodia la clave; la organización
debe asociar esa clave a la persona autorizada. No es una PKI ni un control contra un
operador que modifique el código, trust store y variables de su propio proceso.

Con credenciales del **escritor** y fingerprint previamente confiado:

```powershell
npm run db:admin:apply -- @base --approval local-admin-import/approval.json --public-key local-admin-import/aprobador-publico.pem --receipt local-admin-import/receipt.jsonl
```

La primera ejecución sobre catálogo vacío inserta las habilidades declaradas, cursos,
asociaciones y requisitos aprobados, más una fila de auditoría. Para el candidato
actual se esperan 4 habilidades, 7 cursos, 8 asociaciones y 4 requisitos; confirmar
estas cifras en el plan revisado. Conserva null y todos los valores exactos. No
configura SKILLS_GAP_MARKET_KEY ni activa despliegue: esa decisión sigue separada.
El contexto candidato es `vacante-solvo-python-junior-cr-2026-11-v1`, escala `cv-skill-v1`;
representa una vacante concreta, con niveles editoriales sujetos a aprobación.

## Transacción, evidencia y recuperación

Apply valida firma, caducidad, hashes de bytes/contenido y entorno antes del pool.
Escribe recibo local append + fsync antes de conectar. En una única transacción
READ COMMITTED READ WRITE:

1. Adquiere advisory lock `(834921,1)` compartido con migradores/importadores.
2. Comprueba sesión, TLS, permisos e historial; bloquea tablas mediante función
   acotada y vuelve a comprobar el estado después del bloqueo.
3. Busca UUID previo. Si coincide exactamente aprobación, destino, identidad y
   estado verificado, devuelve applied/replay sin insertar. Un UUID reutilizado
   con otra aprobación se rechaza.
4. Recalcula el plan y exige igualdad exacta del hash aprobado. Revisa caducidad
   tras esperar el bloqueo. Inserta habilidades, cursos y asociaciones.
5. Resuelve IDs reales de habilidades nuevas y existentes; revalida/aplica mercado.
6. Consulta y verifica todos los valores, asociaciones completas y cantidades del
   lote. Inserta evidencia de aprobación, before/after, hashes, identidad y conteos
   y copia validada de los documentos en admin_import_runs. COMMIT solo después de todas las comprobaciones.

Los locks de tablas bloquean DML no cooperativo y permiten SELECT HTTP. Timeouts:
conexión/lock 5 s, sentencia 15 s, inactividad transaccional 30 s. Un error previo a
COMMIT revierte todo, incluida auditoría; las secuencias pueden dejar huecos.
Las filas antiguas no se borran. Auditoría committed es inmutable para el escritor,
pero un DBA conserva capacidad administrativa; respaldos y retención siguen siendo necesarios.

Salida exitosa: status applied. Rechazo: exit 1; recibo rejected si ya pasó la
validación de aprobación y abrió recibo. Errores anteriores no tienen UUID confiable
ni escriben en BD. Pérdida durante COMMIT: exit 3 y commit-uncertain. Si el proceso
muere después de enviar COMMIT, un recibo started sin resultado también es incierto.
Un fallo al persistir recibo tras confirmación no convierte un COMMIT en rollback.
No interpretar ausencia de salida o timeout como ausencia de escrituras.

Con credenciales del **lector**, misma aprobación, datos y clave pública:

```powershell
npm run db:admin:verify -- @base --approval local-admin-import/approval.json --public-key local-admin-import/aprobador-publico.pem --receipt local-admin-import/verification.jsonl --reader-target local-admin-import/reader-target.json
```

Verify permite aprobación vencida únicamente para reconciliar, nunca para nuevas
escrituras. Obtiene lock de sesión antes de abrir snapshot READ ONLY y consulta
UUID/evidencia y todas las filas esperadas. Devuelve applied si prueba auditoría y
contenido; not-applied si, tras esperar operaciones previas, no existe el UUID.
Un error de conexión, timeout o divergencia significa **sin reconciliar**, no
not-applied. El lock se libera y una conexión con liberación fallida se destruye.

Si applied, no repetir como nueva ejecución. Repetir la misma aprobación vigente
es idempotente. Si not-applied, puede reintentarse la misma aprobación vigente:
se recalcula el plan; si cambió BD/archivo o venció, nueva revisión y firma.
Si existe auditoría pero cambió el contenido desde entonces, detener y revisar:
la evidencia histórica se conserva aunque verify ya no certifique el estado actual.

La reversión es una compensación DBA **revisada por ejecución**, en transacción y
bajo el mismo lock: usar approval.plan como before/after, verificar que cada fila
sigue coincidiendo con el after autorizado y que no haya referencias posteriores;
restaurar solo updates demostrados y eliminar solo relaciones/cursos/habilidades
creados por ese UUID que sigan sin uso externo, en orden de FKs. Abortar ante
cambios posteriores. Conservar auditoría original y ticket de compensación; no
TRUNCATE, reseed ni borrado por nombres/prefijos. Daño mayor: PITR a otro servidor,
verificación y recuperación selectiva bajo incidente separado.

## Pruebas

`npm run build`, `npm test`, `npm run db:test`, `npm audit --audit-level=high`.
CI prepara PostgreSQL 17 con TLS y LOGIN `cvexpert_admin_preview_test` y
`cvexpert_admin_apply_test`; las contraseñas TEST del workflow son solo desechables.
Localmente reproducir ese bootstrap en un contenedor dedicado con puertos internos
y externos iguales, PGHOST=127.0.0.1, NODE_ENV=test, credenciales del dueño con CREATEDB,
DB_SSL_MODE=disable para el harness y ADMIN_IMPORT_TEST_CA apuntando al certificado
público SAN test.postgres.database.azure.com. Los pools administrativos usan TLS
verificado independientemente del harness. Sin esa variable las subpruebas TLS se
omiten explícitamente; CI la configura y la ejecución registrada no omitió ninguna.

Los fixtures [TEST] solo se usan en bases UUID eliminadas por el helper. La prueba
CLI sustituye DNS del FQDN ficticio por loopback únicamente en su proceso; no hay
switch de bypass en producción. No inyectar datos candidatos privados en CI.
Ver [evidencia de pruebas](admin-import-verification.md).
