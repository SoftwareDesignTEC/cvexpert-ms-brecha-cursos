# Saylor University — viabilidad y adaptador de Fase 2A

Revisión: **15 de noviembre de 2026**. Rama `codex/course-sync-saylor-phase2a`,
creada desde `origin/develop` `88d41e3`, que fusionó el PR #27.
Trabajo aislado en `.worktrees/course-sync-saylor-phase2a`; los tres archivos
ajenos preparados para commit y los otros worktrees se conservaron intactos.

Estado: **solo fixtures sintéticos TEST; acceso real deshabilitado**. No se
solicitaron tokens, no se consultó el endpoint de la API ni se implementó scraping.
Las lecturas de páginas/documentación durante la investigación no constituyen
autorización para automatizar su extracción, almacenar metadatos o publicarlos.

## Fuentes consultadas y límites de la investigación

| Fuente oficial | Hallazgo / límite |
| --- | --- |
| [Catálogo público](https://www.saylor.org/CourseCatalog) | La apertura no proporcionó contenido textual legible; no se obtuvo un inventario ni se comprobó exhaustividad |
| [API: autenticación](https://saylordotorg.github.io/api-docs/#authentication) | Documentación accesible; requiere token, describe POST al servicio REST Moodle y formato JSON opcional. El texto advierte que está en desarrollo |
| [API: cursos visibles](https://saylordotorg.github.io/api-docs/#local_wsfunc_get_visible_courses) | Describe `cat` recursivo, cero para todas las categorías y un objeto `courses`. Campos: `id`, `category`, `shortname`, `fullname`, opcionales `startdate` y `summary`. No describe paginación, totales, duración, precio, idioma docente ni niveles |
| [Inscripción](https://www.saylor.org/GettingStarted/EnrollInCourse) y [FAQ general](https://www.saylor.org/GettingStarted/FAQ) | Las aperturas no devolvieron texto legible. El índice de búsqueda recuperó una versión del FAQ sobre cursos gratuitos y a ritmo propio; no se toma como contrato actual de toda la oferta |
| [Curso BUS101](https://learn.saylor.org/course/bus101) y [syllabus oficial](https://learn.saylor.org/mod/page/view.php?id=89177) | Ejemplo público de curso con estimación de horas, acceso gratuito y certificado gratuito; el examen opcional de crédito tiene un servicio de supervisión con cargo. No se extrapola a todos los cursos |
| [FAQ de programas](https://www.saylor.org/faq) y [admisiones](https://saylor.org/Admissions) | Presentan programas sin matrícula con cargos por supervisión. Curso, programa y servicio adicional no equivalen a una sola afirmación de gratuidad |
| [Términos de uso](https://www.saylor.org/TermsOfUse), [licencias](https://www.saylor.org/LicensingInformation) y [contenido abierto](https://saylor.org/OpenContent) | Los textos indexados remiten a las licencias aplicables, atribución y derechos particulares de materiales de terceros. Una licencia de contenido no demuestra acceso API concedido a CVExpert, cuotas ni cobertura |

La documentación relaciona el servicio con Program Partners y entrega de token por
Saylor. No se comprobó elegibilidad de CVExpert, vigencia operativa, contrato JSON
autenticado, estabilidad del ID entre instalaciones/versiones ni acuerdo de uso.
Tampoco se verificaron cuotas o frecuencia permitida. No se hicieron solicitudes
autenticadas, sondas del servicio ni intentos de crear o conseguir credenciales.

La ruta Moodle [course/view.php?id=4](https://learn.saylor.org/course/view.php?id=4)
respondió con una página de curso no disponible; comprueba la existencia del
formato de ruta, no disponibilidad de cursos ni acceso automatizado. Los enlaces
de fixtures son inventados, no corresponden a cursos verificados.

No hay un mecanismo automatizado autorizado y operativo verificado para CVExpert.
La alternativa futura sería acordar acceso oficial o recibir un inventario/exportación
con licencia y alcance explícitos del proveedor. Esa alternativa tampoco está
autorizada ni implementada. No se contactó a Saylor en nombre del usuario.

## Contrato del adaptador

`scripts/course-discovery/saylor-provider.ts` implementa el puerto existente
`CourseDiscoveryProvider<SaylorQuery>` y produce `CourseCandidate`. No se añade
otra interfaz de proveedor ni se cambia el contrato Learn.

La forma sintética imita los campos documentados, **no** una captura de respuesta
real. Se aceptan solamente esos campos y el sobre `courses`; propiedades ajenas,
excepciones Moodle o un supuesto cursor causan rechazo explícito. Esto es una
política conservadora: habrá que revisar el parser mediante una prueba de contrato
autorizada antes de interpretar cualquier respuesta real.

| Dato | Transformación y significado |
| --- | --- |
| `id` | Entero seguro positivo, convertido a string; identidad `(saylor, externalId)`, dentro de esta instalación. Durabilidad futura pendiente de confirmación |
| `fullname` | Título explícito validado; no permite deducir habilidades, idioma o nivel |
| `shortname` | Se valida como dato obligatorio; no se usa como identidad ni para inventar un slug |
| `category` | ID temático en `evidence.subjects` con prefijo `saylor:category:`; no se inventa etiqueta, competencia o nivel académico |
| `query.skill` | Contexto requerido por el puerto existente; no se asigna a `associatedSkills` |
| Habilidades | `associatedSkills=[]`, pendiente de revisión editorial del temario y sus derechos de uso |
| Idioma, duración, precio | `language=null`, `durationMinutes=null`, `isPaid=null`; no se infieren del título, categoría, código ni de una FAQ general |
| Nivel | `levels=[]`, sin nivel verificado conforme al vocabulario existente |
| URL | Construida desde el ID con la ruta fija `https://learn.saylor.org/course/view.php?id=…`; no la devuelve el contrato consultado. Se marca `COURSE_URL_DERIVED_FROM_ID`; disponibilidad y redirecciones del enlace quedan pendientes |
| Evidencia | Endpoint fijo sin secretos, hash de los bytes sintéticos, título, URL derivada, categoría y fecha. El campo heredado `returnedUrl` guarda esa URL derivada, no una afirmación de que la API la devolvió |
| `summary`, `startdate` | Se valida el tipo opcional, pero no se copia contenido educativo ni se crea una convocatoria a partir de una fecha Moodle sin semántica comprobada |
| Modalidad, geografía y disponibilidad | `fromDiscovery` conserva los estados desconocidos del núcleo; no infiere retirada, modalidad ni disponibilidad por aparecer en la respuesta |

No se admiten URLs de programas, matrículas o servicios de pago como si fueran
enlaces directos de cursos. El contrato no permite establecer el coste completo
de esos productos; toda gratuidad permanece desconocida. Una futura extensión
debe distinguir el acceso al curso y certificado de servicios/exámenes opcionales
y revisar evidencia individual. No se convierten desconocidos a false o cero.

## Transporte, seguridad y presupuestos

El constructor no usa `fetch` global por defecto ni lee variables de entorno,
`.env`, tokens o archivos de credenciales. Sin `mode: fixture` y un transporte
inyectado, falla con `SAYLOR_LIVE_DISABLED`; `mode: live` también falla, incluso
con transporte inyectado. No existe flag o variable que habilite el acceso real.

El transporte fixture es una frontera de confianza para pruebas, no un permiso
de red. El adaptador prepara una solicitud simulada POST a un único endpoint
constante, con la función y categoría documentadas, pero **sin token**. Nunca se
envía esa petición a Saylor desde la CLI. No se implementa todavía un transporte
autenticado; un cambio separado y revisado será necesario si se confirma acceso.
El secreto futuro no debe pasarse por CLI, URLs, informes, errores o registros.

Controles implementados y probados con dobles:

- Una solicitud por búsqueda, con `beforeRequest` reservado antes del intento.
  El coordinador `discoverCourses` existente conserva presupuestos por ejecución
  y día UTC, caché y backoff. La configuración de demo permite una petición por
  ejecución y tres por día; son límites sintéticos locales, no cuotas de Saylor.
- Timeout de solicitud y lectura: 10 segundos, máximo configurable 30 segundos.
  AbortSignal y carrera de timeout acotan también un doble que ignore cancelación.
- Cuerpo máximo de 1 MiB, lectura por stream, UTF-8 fatal y JSON reconocido.
  Límite adicional de 1000 registros por defecto, configurable hasta 10000;
  excederlo rechaza el lote en lugar de declarar cobertura completa.
- Endpoint fijo sin parámetros de destino, `redirect: error`, rechazo de 3xx,
  `redirected` y URL efectiva diferente. URLs de curso estrictas: HTTPS, host y
  ruta exactos, ID positivo, sin tracking, fragmentos, credenciales o puertos.
- 401/403 → `PROVIDER_UNAUTHORIZED`; 429 → `RATE_LIMITED`, respetando Retry-After
  saneado entre un minuto y un día; 5xx → `PROVIDER_UNAVAILABLE` con espera mínima
  de cinco minutos. No hay reintentos inmediatos. El coordinador guarda el bloqueo
  en su store en memoria; consultas posteriores lo respetan.
- Fallos inesperados de transporte se convierten a códigos seguros. No se imprimen
  cuerpos de error, detalles de red o datos del driver. Los informes solo contienen
  datos TEST y evidencia sin credenciales.

La demo mantiene un store en memoria exclusivo de Saylor. Se pierde al terminar:
no sirve para coordinar cuotas entre procesos o máquinas y no se presenta como
almacenamiento productivo. La espera entre peticiones del coordinador se sustituye
por un no-op **solo en esta composición fixture**. Antes de tráfico real harán
falta cuotas autorizadas, espera efectiva, persistencia de presupuesto y locks.

## Cobertura y conciliación

La API describe visibilidad relativa a un usuario; `cat=0` no prueba cobertura
completa para una identidad que ni siquiera se ha autorizado. No se inventan
páginas, cursores, totales o una garantía de ausencia de truncamiento.

Toda respuesta de este adaptador lleva `truncated=true`, con significado explícito
de **cobertura no verificada** para el puerto existente. El flujo usa siempre
`scope=query`; un array vacío, categoría completa aparente o resultado válido no
habilitan ausencias. No hay modo `full_catalog`. Un sobre con paginación inesperada
se rechaza y no se sigue su URL.

`scripts/course-sync/saylor.ts` llama a `discoverCourses` con el store en memoria;
reutiliza su caché, presupuestos, manejo de errores y consolidación. Después transforma
con `fromDiscovery` y llama a `reconcile`. No duplica la conciliación ni modifica el
motor. El coordinador consolida IDs repetidos y marca conflictos para revisión.
Un ID igual conserva el ID interno aunque cambie título o URL. Los registros de
otras fuentes y la protección manual/inactiva del núcleo se mantienen.

`discovery.status=completed` significa que terminó la operación de descubrimiento,
no que se recorrió el catálogo: se debe leer también `queries[].truncated`.
La conciliación conserva `absenceEligible=false` incluso ante resultados vacíos,
cuotas o errores. Un cambio propuesto en `next` nunca publica el curso: **es staging
simulado, no debe persistirse directamente sobre el catálogo publicado**. Cualquier
aplicación futura exige política editorial, aprobación y procedimiento autorizado.

## Demo local

Desde el worktree `course-sync-saylor-phase2a`, usando Node 24 y las dependencias
existentes (no se añadieron paquetes):

```sh
npm run courses:sync -- --provider saylor --dry-run --fixture
```

La CLI original sin `--provider` sigue funcionando. `--live`, `--apply`, un proveedor
desconocido y opciones repetidas se rechazan. La salida es JSON a stdout; la CLI
no crea archivos, publica datos ni accede a PostgreSQL. No usarla como lote de importación.

Resumen de la salida comprobada (campos de acciones resumidos para lectura):

```json
{
  "dataSource": "TEST_SYNTHETIC_ONLY",
  "liveEnabled": false,
  "databaseAccess": false,
  "publicationApproved": false,
  "coverage": "unverified",
  "batch": { "received": 8, "accepted": 8, "rejected": 0, "duplicateIds": 1 },
  "proposals": { "insert": 6, "update": 1 },
  "absenceEligible": false
}
```

Siete cursos ficticios: administración, inglés, humanidades, ciencias, comunicación,
informática y desarrollo profesional; uno se repite. El catálogo inicial tiene un
curso Saylor TEST con título anterior y otro de una fuente distinta. El plan actualiza
el primero, propone seis borradores y conserva el de la otra fuente. Identificadores,
fechas y hash son deterministas; ningún enlace fixture afirma que un curso exista.

## Archivos y validación

| Archivo | Responsabilidad |
| --- | --- |
| `scripts/course-discovery/saylor-provider.ts` | Adaptador fixture, validación del contrato y controles de transporte |
| `scripts/course-sync/saylor.ts` | Composición del descubrimiento y conciliación existentes; store/config fixture |
| `scripts/course-sync/saylor-demo.ts` | Demo local del proveedor |
| `scripts/sync-courses.ts` | Opción compatible `--provider saylor`, manteniendo el fixture anterior |
| `test/fixtures/saylor.test.ts` | Registros y snapshot inventados, marcados TEST; sin contenido copiado |
| `test/saylor-provider.test.ts` | 17 pruebas del adaptador, límites, composición y CLI |
| `docs/providers/saylor.md` | Viabilidad, límites y evidencia de esta fase |
| `docs/course-sync-architecture.md` | Enlace a esta extensión sin alterar políticas del núcleo |

Comandos ejecutados y resultados reales:

| Comando | Resultado |
| --- | --- |
| `git fetch origin develop` y `git worktree add -b codex/course-sync-saylor-phase2a .worktrees/course-sync-saylor-phase2a origin/develop` | Worktree limpio desde el merge del PR #27 |
| `npm run build` | Aprobado |
| `node --import tsx --test test/saylor-provider.test.ts test/course-sync.test.ts` | 38/38 aprobadas: 17 de Saylor y 21 del núcleo |
| `npm test` | 128/129 aprobadas; único fallo preexistente: comparación documental sensible a CRLF en `test/documentation.test.ts:78` |
| `npm run courses:sync -- --provider saylor --dry-run --fixture` | Salida TEST comprobada, sin acceso externo ni publicaciones |
| `docker info --format '{{.ServerVersion}}'` | Motor Docker Linux no disponible; no se pudo verificar PostgreSQL desechable seguro |
| `npm run db:test` | No ejecutado; no se utiliza una base real o compartida como sustituto |
| `git diff --check` | Sin errores |

La suite completa se ejecutó fuera del bloqueo de loopback del sandbox; se capturó
con `npm test 2>&1 | Select-Object -Last 44`. No se modificó la prueba documental
ajena ni su documento para esconder el fallo. Se realizaron también búsquedas `rg`,
lecturas `Get-Content` y verificaciones `git status/log/diff/worktree list`.

Las pruebas específicas no hacen llamadas externas ni usan credenciales reales.
Una prueba ejecuta la demo con `node --permission --allow-fs-read=*`, sin permisos
de red, escrituras, workers o procesos hijos y con entorno mínimo sin credenciales.
Se prueban explícitamente 401/403/429/5xx, redirecciones, tamaño, timeout durante
transporte/lectura, esquema desconocido, vacíos, nulos, duplicados, conflictos,
presupuestos, backoff, caché, identidad y preservación de otras fuentes.
La prueba de duración conserva `null` cuando falta evidencia; no afirma que la API
devuelva duración ni acepta una extensión inventada como si fuera contrato oficial.

## Revisión y pendientes

Revisar el diff de esta rama respecto de `origin/develop`, comenzando por el adaptador,
sus pruebas, la composición y la documentación. El código HTTP, las migraciones y
los workflows deben seguir intactos. Cuando un mantenedor autorice y publique la
rama, el PR debe apuntar a `develop`, describir el alcance fixture y declarar el
fallo documental y la integración DB no ejecutada. No se realiza push ni merge
automático desde esta tarea.

Antes de datos reales: confirmar acceso/credenciales institucionales, licencia de
metadatos y enlaces, atribución/retención, cuotas, vigencia del servicio, respuesta
autenticada saneada, categorías, estabilidad de IDs y cobertura completa. Resolver
la distinción de coste de curso/programa/servicios y la revisión editorial de habilidades.
Solo después diseñar e implementar transporte autenticado explícito y validarlo
con autorización; no basta cambiar un flag o aportar un token personal.

Antes de PostgreSQL: aprobar migraciones aditivas, staging durable, auditoría,
versionado/checkpoints atómicos, concurrencia, propiedad y publicación revisada.
Antes de Azure: nueva autorización de infraestructura, identidad, red, secretos,
observabilidad, presupuestos globales y programación. No se implementó ninguna de
estas piezas ni se inició otro proveedor.
