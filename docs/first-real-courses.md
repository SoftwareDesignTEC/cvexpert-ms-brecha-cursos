# Fase 4B — primeros cursos oficiales, catálogo y recomendaciones

Base: `origin/develop` **fb4c745**, merge del PR #32. Rama/worktree independiente
`codex/course-sync-first-real-courses`. Investigación fechada **2026-11-15**, zona
America/Costa_Rica. No se conectó a bases operativas ni se consultó el grafo RDF.

**Resultado demostrado:** metadatos auténticos de Simple coding → autorización de
fixture **TEST_ONLY** → CatalogDocument v1 → importador local → PostgreSQL 17 UUID
desechable → GET /courses → recomendación por Python faltante. Se importa también
Network security sin asociaciones. Esto no constituye aprobación humana ni publicación
operativa; los seis candidatos reales siguen pendientes.

## Registro y evidencia

El [registro JSON](providers/openlearn-real-courses.json) contiene copias mínimas de
metadatos descriptivos y paráfrasis de resultados, no lecciones ni capturas RDF.
Cada URL es su identidad editorial; `rdfIdentity=null`, `editorialStatus=pending`.
La fecha global y `evidenceSections` identifican fecha, fuente y secciones por candidato.
Idioma docente y servicios opcionales permanecen desconocidos. No se deduce idioma
del título ni se afirma que toda certificación o servicio sea gratuito.

| Curso oficial / fuente primaria | Horas | Nivel declarado | Propuestas, todas pendientes |
| --- | ---: | --- | --- |
| [Simple coding](https://www.open.edu/openlearn/digital-computing/simple-coding/content-section-0) | 2 | Level 1: Introductory | Python, alcance inicial de código/secuencias/repetición |
| [Network security](https://www.open.edu/openlearn/digital-computing/network-security/content-section-0) | 25 | Level 3: Advanced | Seguridad de redes, ciberseguridad, criptografía, con alcance de sus resultados |
| [Introduction to cyber security: stay safe online](https://www.open.edu/openlearn/digital-computing/introduction-cyber-security-stay-safe-online/) | 24 | Level 1: Introductory | Ciberseguridad y seguridad informática básica |
| [An introduction to interaction design](https://www.open.edu/openlearn/science-maths-technology/an-introduction-interaction-design/content-section-0) | 10 | Level 2: Intermediate | Diseño de interacción, usabilidad y UX, a contrastar semánticamente |
| [An introduction to software development](https://www.open.edu/openlearn/science-maths-technology/an-introduction-software-development/content-section-0) | 6 | Level 3: Advanced | Ingeniería de software y fundamentos del enfoque orientado a objetos |
| [Learn to code for data analysis](https://www.open.edu/openlearn/digital-computing/learn-code-data-analysis/content-section-overview) | 24 | Level 1: Introductory | Python introductorio y análisis de datos |

Las seis fichas muestran acceso gratuito al curso y señales de inicio; no se verificaron
actividades autenticadas, herramientas externas o finalización. Network security exige
conocimientos sustanciales de informática. Learn to code for data analysis muestra una
advertencia oficial sobre software/cuestionarios: el revisor debe decidir su impacto.
La URL anterior bajo science-maths-technology redirigió a digital-computing y se conserva
como alias. La portada de cyber security y la ruta `content-section-overview` son URLs
oficiales válidas: no se reescriben a `content-section-0` para satisfacer un adaptador.
No se añadieron cursos de SQL/Linux sin evidencia para completar artificialmente una lista.

## Derechos y atribución

Atribución: **The Open University / OpenLearn**, títulos y enlaces de las fuentes.
Esta entrega registra hechos breves y paráfrasis propias de alcance educativo, sin
logos, lecciones, imágenes, vídeos, paquetes, transcripciones ni vínculos de descargas.
No implica respaldo o afiliación.

Se revisó la [FAQ oficial de copyright y enlaces](https://www.open.edu/openlearn/about-openlearn/frequently-asked-questions-on-openlearn).
Permite enlazar sin sugerir afiliación/respaldo; describe CC BY-NC-SA para materiales
propios salvo excepciones y derechos adicionales de terceros. Las páginas también
muestran avisos de copyright. Esto **no** equivale a una licencia uniforme de todo el
contenido, ni se traslada CC BY 3.0 del dataset RDF a las páginas. El enlace de condiciones
generales desde el sitio devolvió 502 en la herramienta de consulta; sigue pendiente
contrastarlo antes de una publicación operativa. La revisión humana debe aprobar el
alcance concreto de metadatos/enlaces, atribución y uso, especialmente si es comercial.
`rightsStatus=pending_human_review` no se cambió a aprobado.

La herramienta puede entregar páginas indexadas: la fecha es de consulta de evidencia,
no certificación de disponibilidad transaccional en origen. Los hashes generados por
esta fase son de **contenido editorial local**, nunca hashes inventados de HTTP/RDF.

## Por qué la ruta es editorial por URL

Se revisaron `openlearn-enrichment`, `openlearn-simple-coding`, su generador, validador
CatalogDocument, importadores, planificador/apply administrativo, repositorios de catálogo
y recomendaciones, migraciones 001–005 y tests. El generador RDF anterior exige
`sourceId` y `content-section-0`, y su referencia dice OpenLearn ID. Adaptarlo con IDs
inventados o forzar las URLs de portada falsearía procedencia.

La nueva ruta `scripts/editorial-courses/review.ts` conserva identidad por URL y reutiliza
**parseCatalogDocument sin cambios**. No cambia OpenLearnProvider, SPARQL, conciliación,
permisos, migraciones, REST ni Android. `CatalogDocument` no tiene un campo RDF: no se
rellena ninguno. La procedencia editorial, URLs, secciones, fecha, atribución, vocabulario,
revisor y hash se conservan en `sourceReference` y archivos custodiados.

El importador local declara `provenancePersisted=false`: `public.courses` no tiene columna
sourceReference. Por ello hay que conservar registro, revisión, catálogo y reporte de
importación juntos. El flujo administrativo de 004 conserva input/recibo dentro de su
auditoría al aplicarse en una ventana futura autorizada; no se simula ese recibo aquí.

## Estado editorial y decisiones concretas

Se entregan una [plantilla de revisión pendiente](providers/openlearn-real-courses-review.pending.json)
y un [informe de bloqueos reproducible](providers/openlearn-real-courses-report.pending.json).
`reviewer`, `reviewedAt` y `contentSha256` permanecen null. No hay catálogo v1 operativo
con una fecha de aprobación ficticia: se genera únicamente tras decisiones explícitas.

El revisor debe:

1. Confirmar título/URL, acceso y coste de cada curso elegido; comprobar alertas y vigencia
   funcional. Rechazar o dejar pendientes los que no alcancen evidencia suficiente.
2. Obtener una instantánea autorizada de `SELECT name FROM public.skills ORDER BY name`
   en pruebas, o un catálogo revisado, con referencia y fecha. La entrega no afirma que
   Python ni los nombres españoles existan en producción. Seeds `[DEMO]` no lo prueban.
3. Para Simple coding, decidir la pertinencia de la propuesta Python introductorio y,
   solo si existe **exactamente** Python, establecer esa asociación. Si falta, dejarla
   pendiente o tramitar una nueva habilidad por revisión administrativa independiente.
4. Para los demás, elegir correspondencias exactas con justificación por propuesta.
   No inventar sinónimos ni equiparar Level 1/2/3 con niveles CVExpert. UX no se convierte
   automáticamente en otro nombre. Publicar sin habilidades exige justificación explícita.
5. Confirmar derechos/atribución y advertencias. Aportar identidad y fecha reales de
   revisión, y confirmar el hash después de cerrar vocabulario y decisiones.

El hash ata registro, propósito, vocabulario y decisiones, incluidas las confirmaciones;
si cambian, la elegibilidad se invalida. **No es firma ni prueba de identidad humana**:
el manifiesto es un documento de revisión de confianza, sujeto al plan/sign/apply real.
`authorizedToPublish=false` permanece incluso con catálogo elegible para planificar.
El generador no crea habilidades (`catalog.skills=[]`); solo admite coincidencias exactas
de nombres confirmados. Las decisiones de candidatos no elegidos siguen pendientes.

## Comandos de revisión y generación futura, sin base de datos

```powershell
npm run courses:official:review -- report --file docs/providers/openlearn-real-courses.json
New-Item -ItemType Directory -Path local-catalog-input -Force
Copy-Item docs/providers/openlearn-real-courses-review.pending.json local-catalog-input/revision.json
```

Una persona autorizada edita esa copia: vocabulario con procedencia, asociaciones con
justificación, decisiones y confirmaciones, revisor y fecha reales. No copiar las
autorizaciones TEST de las pruebas. Después:

```powershell
node --import tsx scripts/review-official-courses.ts hash --file docs/providers/openlearn-real-courses.json --review local-catalog-input/revision.json
# Tras revisar, copiar el hash devuelto al campo contentSha256 del manifiesto.
node --import tsx scripts/review-official-courses.ts report --file docs/providers/openlearn-real-courses.json --review local-catalog-input/revision.json
node --import tsx scripts/review-official-courses.ts catalog --file docs/providers/openlearn-real-courses.json --review local-catalog-input/revision.json > local-catalog-input/catalogo-revisado.json
```

Se usa Node directamente al redirigir JSON para evitar los banners de npm en el archivo.
Con la plantilla pendiente, `catalog` falla sin emitir un lote. También rechaza exportar
como operativo cualquier propósito `TEST_ONLY`. No hay `--apply` ni acceso SQL en esta CLI.

## Demostración reproducible con PostgreSQL 17

Levantar un PostgreSQL 17 **nuevo y desechable** con roles de pruebas equivalentes a
`.github/workflows/ci-cd.yml` (dueño `cvexpert_ci` con CREATEDB, lector HTTP limitado y
roles separados de ingesta/edición). No utilizar bases compartidas, túneles o credenciales
operativas. Configurar exclusivamente el servidor local de pruebas:

Para ejecutar **solo la demostración** desde cero, basta este servidor dedicado y los
tres roles que usa la prueba. El puerto debe estar libre. No ejecutar estos comandos
sobre un contenedor/base previamente existente:

```powershell
docker run --detach --name cvexpert-real-courses-demo-pg17 --publish 127.0.0.1:55438:55438 --env POSTGRES_PASSWORD=TEST-bootstrap-only --env POSTGRES_DB=cvexpert_ci postgres:17-bookworm -p 55438
docker exec cvexpert-real-courses-demo-pg17 pg_isready -p 55438 -U postgres
# Continuar cuando pg_isready indique accepting connections.
docker exec cvexpert-real-courses-demo-pg17 psql -p 55438 -U postgres -d cvexpert_ci -v ON_ERROR_STOP=1 -c "CREATE ROLE cvexpert_ci LOGIN NOSUPERUSER NOCREATEROLE CREATEDB PASSWORD 'ci-only-disposable-password';" -c "CREATE ROLE cvexpert_brecha_app LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT PASSWORD 'ci-readonly-disposable-password';" -c "CREATE ROLE cvexpert_sync_ingest LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT PASSWORD 'TEST-sync-ingest-only';"
```

Después configurar el proceso que ejecutará la prueba:

```powershell
$env:NODE_ENV = 'test'
$env:PGHOST = '127.0.0.1'
$env:PGPORT = '55438'
$env:PGDATABASE = 'cvexpert_ci'
$env:PGUSER = 'cvexpert_ci'
$env:PGPASSWORD = 'ci-only-disposable-password'
$env:PG_READONLY_PASSWORD = 'ci-readonly-disposable-password'
$env:DB_SSL_MODE = 'disable'
$env:PGSSLROOTCERT = ''
npm run courses:real:demo
```

Tras la demostración, retirar exclusivamente el contenedor dedicado creado arriba:

```powershell
docker stop cvexpert-real-courses-demo-pg17
docker rm -v cvexpert-real-courses-demo-pg17
```

Estas credenciales públicas son fixtures exclusivos del contenedor desechable. El helper
crea/elimina su propia base UUID, aplica 001–005, provisiona Python mediante un lote de
vocabulario **TEST** y lee su nombre real desde `public.skills` de esa base. Eso acredita
el snapshot de pruebas, no un vocabulario operativo. El fixture de autorización está en
`test/fixtures/real-courses.test.ts`, con revisor `TEST automated fixture, no human approval`,
propósito `TEST_ONLY`, tiempo de fixture y batch `TEST-...`.

La prueba prepara CatalogDocument v1 e importa mediante `runCatalogImport` existente,
primero dry-run y luego `--apply` sobre la base UUID; comprueba cursos/relaciones y replay.
El mismo servicio HTTP autenticado y lectores SELECT existentes exponen:

```json
{
  "endpoint": "GET /courses?skillName=Python",
  "course": { "title": "Simple coding", "durationHours": 2, "isPaid": false, "skills": ["Python"] },
  "authorization": "TEST_ONLY"
}
```

Y, con CV vacío y oferta que pide Python/SQL:

```json
{
  "recommendations": [
    { "skillName": "Python", "catalogMatch": "matched", "courseTitles": ["Simple coding"] },
    { "skillName": "SQL", "catalogMatch": "not_found", "courseTitles": [] }
  ],
  "authorization": "TEST_ONLY"
}
```

Los tests imprimen los JSON completos, con URL real e ID interno numérico asignado en
esa base. Se mantienen títulos y URLs auténticos; el marcador TEST corresponde a la
autorización y al lote. Network security aparece en el
catálogo pero no se recomienda por Python. No se crea ningún documento de mercado ni
escala; `public.market_requirements` permanece vacío. Esta recomendación existente usa
habilidades no documentadas en el CV, no compara niveles de dominio.

Los tests bloquean todo fetch que no sea HTTP loopback y nunca consultan páginas externas.
Verifican que el lector no puede actualizar el catálogo y que la ingesta carece de DML
público. Un intento administrativo con la misma URL y título distinto se rechaza sin
sobrescribir. Solo se publican filas de prueba en la base UUID que se elimina al terminar.

## Identidad, duplicados y futuras observaciones RDF

La URL oficial es la clave editorial; no se asigna externalId/RDF ni se introduce en
OpenLearnProvider. Registrar aliases únicamente con evidencia de redirección verificada.
El generador bloquea colisiones URL/alias dentro del registro; no normaliza rutas, barras,
queries o idiomas para forzar equivalencias. El índice único de `public.courses.url` y
el planificador actual detectan conflictos de la URL exacta y asociaciones existentes.

Antes de cada lote, el revisor debe contrastar URLs **y aliases** contra todo el catálogo
y registros editoriales custodiados. El importador actual no conoce aliases históricos;
no se promete deduplicación global de aliases sin esa comprobación. Si aparece una IRI
RDF de uno de estos cursos, dejarla como observación/propuesta y revisar la colisión:
no crear otro curso, cambiar propiedad o enlazarlo automáticamente.

Course Sync lee/escribe staging, no adopta `public.courses` y su rol carece de publicación.
Los IDs públicos numéricos no se reinterpretan como internalID del proveedor. Cualquier
vínculo posterior exige revisión editorial y el procedimiento separado existente; los
registros `origin=manual` de staging ya están protegidos por conciliación/trigger. Esta
fase no cambia esos mecanismos ni convierte cursos editoriales en propiedad del worker.

## Bloqueo y procedimiento operativo plan/sign/apply/verify

No hay aprobación humana, snapshot canónico operativo, revisión final de derechos,
destino autorizado ni **documento real de mercado y escala** para esta entrega.
`prepareInput` exige catálogo + mercado `dataKind=reference` + escala coherente. El flujo
administrativo no admite un reemplazo ficticio para satisfacer esa dependencia. Por eso
la demostración usa el importador local autorizado; no ejecuta ese flujo contra Azure.

Una vez resueltos esos requisitos por personas autorizadas:

1. Generar y custodiar el catálogo mediante el manifiesto real revisado; mantener registro,
   evidencias, snapshot de habilidades y hash. Nunca usar el catálogo TEST de la demostración.
2. Aportar mercado/escala reales revisados, seleccionar destinos lector/escritor limitados
   y preparar estación/CA según [el procedimiento administrativo](admin-import.md).
   El código actual fija exactamente **001–005**; la mención histórica de 001–004 en ese
   documento no sustituye el preflight vigente ni autoriza cambiar checksums o permisos.
3. Ejecutar `db:admin:plan` con los cuatro archivos, ambos targets y salida de propuesta.
   Revisar conflictos, contenido y autorización de cambios; el plan es READ ONLY.
4. Una persona autorizada completa revisión/fechas/decisiones y usa `db:admin:sign` con
   su clave custodiada. Nadie ha realizado esa firma operativa en esta fase.
5. En ventana autorizada ejecutar `db:admin:apply` y `db:admin:verify` con los mismos bytes,
   firma y destinos. Conservar recibo. No se cambian las comprobaciones de TLS, identidad,
   privilegios, entorno, hash, expiración o atomicidad de esos comandos.

No existe un atajo de aprobación editorial que publique por HTTP, ni se amplía el
importador administrativo a catálogo solo como parte de esta fase.

Comandos de esa **ventana futura**, con archivos reales ya revisados y configuración
`ADMIN_IMPORT_*` correspondiente a cada identidad según la documentación administrativa:

```powershell
$base = @('--catalog','local-admin-import/catalogo-revisado.json','--market','local-admin-import/mercado-real.json','--scale','local-admin-import/escala-real.json','--evidence','local-admin-import/evidencia.md')
npm run db:admin:plan -- @base --target local-admin-import/writer-target.json --reader-target local-admin-import/reader-target.json --output local-admin-import/proposal.json
# Intervención humana: revisar y completar la propuesta antes de firmarla.
npm run db:admin:sign -- --proposal local-admin-import/proposal.json --private-key <clave-custodiada> --output local-admin-import/approval.json
npm run db:admin:apply -- @base --approval local-admin-import/approval.json --public-key <clave-publica-revisada> --receipt local-admin-import/receipt.json
npm run db:admin:verify -- @base --approval local-admin-import/approval.json --public-key <clave-publica-revisada> --reader-target local-admin-import/reader-target.json --receipt local-admin-import/verification.json
```

Los nombres mercado-real/escala-real son rutas pendientes, no archivos creados. Ningún
comando de esa ventana se ejecutó contra un destino operativo en esta fase.

## Evidencia de validación y archivos

Verificación local: Node **24.21.0**, PostgreSQL **17.11** (`postgres:17-bookworm`),
contenedor independiente expuesto solo en `127.0.0.1:55438`, bases UUID del helper.
Se configuró TLS local para ejecutar también las suites administrativas existentes.

| Verificación | Resultado |
| --- | --- |
| `npm run build` | Aprobado |
| `npm test` | 172/172, sin omitidas |
| `npm run db:test` | 116/116, sin omitidas |
| Nueva demostración + regresiones editoriales aisladas | 10/10 |
| `node --test .github/scripts/*.test.mjs` | 52/52 |
| `npm audit --audit-level=high` | 0 vulnerabilidades |
| `git diff --check` y comprobación de nuevos archivos | Sin errores |

Entorno: Node 24.21.0, PostgreSQL 17.11 (`postgres:17-bookworm`), TCP loopback en
puerto 55438, credenciales sintéticas. `npm run courses:real:demo` también pasó como
comando independiente. La consulta final encontró **0** bases UUID restantes y se
retiraron el contenedor/volumen creados para esta fase.

Los ejemplos JSON anteriores corresponden a resultados comprobados en la prueba,
incluida la URL oficial, precio/duración y relación con Python. No se probaron páginas
externas durante los tests ni se conectó a bases operativas. GitHub Actions remoto no
se dispara en esta entrega sin push. Las dos comparaciones literales LF preexistentes
en Windows se ejecutaron normalizando temporalmente el Markdown/workflow afectados y
restaurando sus bytes; no se alteraron assertions ni se incluyeron esos archivos en el diff.

Archivos de la entrega:

- `docs/providers/openlearn-real-courses.json`: seis registros oficiales pendientes.
- `docs/providers/openlearn-real-courses-review.pending.json`: revisión vacía, sin identidad o fecha de aprobación.
- `docs/providers/openlearn-real-courses-report.pending.json`: bloqueos actuales, catálogo null.
- `scripts/editorial-courses/review.ts` y `scripts/review-official-courses.ts`: ruta editorial offline y validación CatalogDocument existente.
- `test/fixtures/real-courses.test.ts`: autorización sintética TEST separada de los metadatos reales.
- `test/real-courses.test.ts` y `test/db/real-courses.test.ts`: bloqueos de revisión y recorrido completo HTTP/SQL.
- `package.json`: comandos de revisión y demostración.
- `docs/first-real-courses.md`: este informe, evidencia, comandos y bloqueos operativos.

No se modifican migraciones, adaptadores, conciliación, importadores administrativos,
permisos existentes, repositorios HTTP, REST, Android, FCM o Azure. No hubo publicación
productiva, aprobación humana, firma operativa, push, merge ni despliegue.
