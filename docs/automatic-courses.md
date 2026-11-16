# Cursos automáticos — MVP funcional

**Sí:** se obtuvieron metadatos reales de dos proveedores, se insertaron seis cursos
en PostgreSQL 17 desechable y se consumieron mediante los endpoints existentes.
La [evidencia real](automatic-courses-live-evidence.json) contiene fechas, commit de
freeCodeCamp, hashes, filas SQL y respuestas HTTP. Base `origin/develop` **cb9915e**
(PR #34), rama `codex/courses-automatic-mvp`, worktree independiente.

| Fuente | Encontrados | Insertados | Asociaciones nuevas | Rechazados |
| --- | ---: | ---: | ---: | ---: |
| OpenLearn | 3 | 2 | 2 | 1: ruta heredada sin URL HTTPS verificada |
| freeCodeCamp | 4 | 4 | 6 | 0 |

Segunda ejecución real del CLI compilado: **0 inserciones**, seis existentes, cero
asociaciones nuevas. Se conservó además un curso manual y su asociación SQL, ambos
fixtures **TEST exclusivamente en la base UUID desechable**. Total físico: siete cursos
y nueve asociaciones, de los cuales seis cursos y ocho asociaciones son la ingesta real.

Cursos nuevos: Network security e Information security; Python Certification,
JavaScript Certification, Relational Databases Certification y Responsive Web Design
Certification. `GET /courses` respondió 200 e incluyó ambas plataformas. Para un CV sin
Python y una oferta con Python, `POST /skills-gap/recommendations` devolvió 200 y:

```json
{"skillName":"Python","catalogMatch":"matched","courses":[{"title":"Python Certification","platform":"freeCodeCamp","url":"https://www.freecodecamp.org/learn/python-v9/","durationHours":null,"isPaid":false,"skills":["Python"]}]}
```

El ejemplo omite ID/logo del objeto para abreviar; la respuesta completa e input exacto
están en el JSON de evidencia. No se afirma aprobación editorial humana ni actualización
de Azure. La base de demostración se eliminó mediante el helper existente.

## Fuentes, acceso y asociaciones

**OpenLearn:** el [catálogo público](https://www.open.edu/openlearn/digital/free-courses)
es accesible mediante la herramienta de investigación, pero GET/robots desde el runtime
local respondieron **403**. No se intenta eludir esa protección ni extraer HTML.
Se usa la [interfaz SPARQL oficial](https://data.open.ac.uk/howto), grafo OpenLearn2:
una consulta fija, como máximo diez registros de tipo OpenCourseware, con título, URL y
descripción. No solicita categorías multivaluadas ni lecciones. Excluye identidades con
título/URL/descripción contradictorios; tampoco interpreta la muestra como catálogo completo.
Los límites de este comando son propios, no una cuota contractual del proveedor.

Se exige evidencia individual de curso gratuito en la descripción y evidencia explícita
de enseñanza de la habilidad. Los dos cursos aceptados describen seguridad de información
o de redes, de modo que se asocian a **Ciberseguridad**, sin nivel de dominio implícito.
El RDF conserva rutas históricas: la antigua ruta de Network security dio 404 en la
comprobación del enlace, mientras que su [página oficial vigente](https://www.open.edu/openlearn/digital-computing/network-security/content-section-0)
coincide en título y descripción. [Information security](https://www.open.edu/openlearn/science-maths-technology/information-security/content-section-0)
también se verificó en su página oficial. Hay dos alias explícitos en el conector, comprobados
el 2026-11-16; no se inventan IRIs ni se supone que todo HTTP redirige a HTTPS.
Una tercera ruta HTTP sin correspondencia comprobada se rechaza. No se publican enlaces
HTTP y no se descarga contenido del curso. El RDF no constituye una garantía permanente
de funcionamiento de actividades: un cambio de rutas requiere mantenimiento del conector.

**freeCodeCamp:** se usa exclusivamente el [repositorio oficial](https://github.com/freeCodeCamp/freeCodeCamp),
no crawling de `/learn/`. Sus [condiciones del sitio](https://www.freecodecamp.org/news/terms-of-service/)
restringen la automatización de la web. La implementación resuelve `main` mediante GitHub
y descarga **README.md** e **intro.json**, ambos fijados al mismo SHA. Son descripciones
del currículo e introducciones de bloques, no lecciones ni soluciones. Solo se aceptan
las cuatro rutas de certificaciones tecnológicas delimitadas en código, presentes en el
README oficial y con descripción correspondiente. La declaración explícita de certificaciones
gratuitas en ese README verifica el acceso gratuito; no se generaliza desde un repositorio
que simplemente sea público. No se anuncian prestaciones opcionales ni titulaciones externas.

| Ruta publicada | Habilidades posibles, sujetas a evidencia |
| --- | --- |
| `python-v9` | Python |
| `javascript-v9` | JavaScript |
| `relational-databases-v9` | SQL, Git |
| `responsive-web-design-v9` | HTML, CSS |

Cada asociación exige tecnología exacta y una afirmación de aprendizaje/enseñanza en
una introducción, sin negación/prerrequisito. El informe identifica el campo JSON concreto
que la respalda. Java no es JavaScript; categorías, títulos y menciones genéricas no
otorgan habilidades. Vocabulario cerrado: Python, JavaScript, SQL, Git, Docker,
Ciberseguridad, HTML y CSS. Docker no se crea si ninguna observación lo justifica.
Una coincidencia ambigua en `public.skills` (por ejemplo Python y python) bloquea el curso,
sin crear sinónimos ni elegir un ganador. Si no existe un nombre canónico ni una colisión,
se inserta el nombre explícito del vocabulario, autorizado por esta política automática.

Duración: **null** cuando la interfaz estructurada utilizada no la informa; no se infiere
desde el nombre del curso. No se descargan imágenes. Fuente, fecha, hashes y campos de
evidencia se emiten en el reporte operativo JSON. El esquema actual no tiene columnas
de procedencia/fecha en cursos; no se añade una migración ni se falsea una revisión para
usar `CatalogDocument`. Conservar stdout en logs de aplicación o en un archivo de ejecución.

Derechos: metadatos OpenLearn [CC BY 3.0 según el inventario oficial](https://data.open.ac.uk/datasets),
atribuidos a The Open University. No implica que todo material de los cursos tenga esa
licencia. El software/metadata de `client` de freeCodeCamp usa BSD-3-Clause; se conserva
[su aviso](licenses/freecodecamp-BSD-3-Clause.txt). El README distingue los recursos de
`curriculum`, cuyo contenido no se copia. No se afirma afiliación ni respaldo de las plataformas.

## Configuración mínima y ejecución

Requiere Node 24, PostgreSQL existente con migraciones 001–005, y **otra identidad**
distinta de HTTP, staging y administración. No se usa `PGUSER` para ingesta. Un DBA
autorizado provisiona una sola vez (contraseña propia segura, no la de ejemplo):

```sql
CREATE ROLE cvexpert_course_ingest LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT PASSWORD '<secreto exclusivo de ingesta>';
SET cvexpert.course_ingest_grants_database = '<base destino explícita>';
-- En la misma conexión a esa base, ejecutar db/course-automatic-ingest-grants.sql.
```

El archivo de grants exige confirmación del nombre de base y comprueba los atributos del
LOGIN. Concede únicamente USAGE del esquema/secuencias, SELECT en las tres tablas y
INSERT en columnas necesarias. No concede UPDATE, DELETE, TRUNCATE, DDL ni permisos
de staging. No revoca ni altera permisos de otros roles. El runtime vuelve a verificar
identidad efectiva, ausencia de membresías/privilegios amplios, permisos por columna y
secuencias antes de consultar proveedores. Un propietario, administrador o usuario HTTP
se rechaza. No se ejecutan grants/migraciones desde el comando ni desde el servidor.

Con el destino autorizado ya provisionado, configurar `.env` o variables del proceso:

```dotenv
NODE_ENV=development
COURSES_INGEST_HOST=127.0.0.1
COURSES_INGEST_PORT=55439
COURSES_INGEST_DATABASE=<base local autorizada>
COURSES_INGEST_USER=cvexpert_course_ingest
COURSES_INGEST_PASSWORD=<secreto exclusivo>
COURSES_INGEST_SSL_MODE=disable
COURSES_INGEST_ENABLED=false
```

```powershell
npm ci
npm run build
npm run courses:ingest:once
# Reporte JSON sin cabeceras de npm, opcional:
npm run --silent courses:ingest:once
```

El comando **consulta fuentes reales y escribe en el catálogo**. No tiene modo fixture
oculto, archivo de entrada, flags de force ni credenciales administrativas de fallback.
No invocarlo contra una base que no esté autorizada. Para remoto/producción se exige
`COURSES_INGEST_SSL_MODE=verify-full`; `COURSES_INGEST_SSLROOTCERT` es opcional para
una CA confiable. No se admite TLS deshabilitado en remoto o producción. Las variables
`PG*` del lector API permanecen independientes y con sus permisos actuales.

Por ejecución: una consulta OpenLearn y tres solicitudes GitHub, sin redirects ni reintentos
HTTP automáticos, 15 segundos y 1 MiB máximos por respuesta. Sin scraping ni recorrido
exhaustivo. Un 429 informa backoff/Retry-After; el timer lo respeta en el proceso activo.
La CLI no reintenta por su cuenta: respetar el plazo informado antes de otra ejecución.
`complete` indica que ambos proveedores terminaron; los rechazos individuales siguen
figurando en el reporte. `partial` conserva lo válido del proveedor exitoso y devuelve
código de salida 1; `failed` también devuelve 1. `locked` no consulta fuentes ni escribe.

## Protección del catálogo y ejecución periódica

El mismo flujo sirve a CLI y servidor:

```text
OpenLearn SPARQL / GitHub metadata → validación → INSERT-only, una transacción por fuente
                               → public.courses / public.skills / public.course_skills
                               → repositorios y endpoints actuales → recomendaciones
```

Se omite por completo una URL existente, sus variantes HTTP/HTTPS OpenLearn o un
título/plataforma ya existente. No se adopta el curso ni se agregan habilidades al registro
existente; tampoco se sustituyen título, precio o duración. `ON CONFLICT DO NOTHING`
y la unicidad actual protegen la carrera de URL. Cursos nuevos y sus relaciones se confirman
juntos. Una fuente fallida no revierte a la otra, elimina ausencias ni provoca bajas.
Un COMMIT incierto se resuelve ejecutando de nuevo: si las filas existen, se omiten completas.
Errores de serialización/SQL no reconsultan externamente dentro de la ejecución; se reportan
para la siguiente. Las actualizaciones de cursos preexistentes siguen requiriendo el
procedimiento administrativo autorizado. No se relaja plan/sign/apply/verify, TEST_ONLY,
certificados APIM ni permisos del lector. No hay otro catálogo, staging ni conciliador.

El lock PostgreSQL de sesión `(834921,6)` cubre toda la ejecución, incluyendo red. Un
segundo proceso lo encuentra ocupado y sale sin consultar fuentes. Las escrituras cooperan
además con el lock transaccional `(834921,1)` del importador actual, en SERIALIZABLE.
Si no se puede liberar el lock de sesión se destruye la conexión para no devolverla
al pool con un lock retenido. Una caída de proceso cierra la sesión PostgreSQL.

Para activar periodicidad en el Node desplegado, configurar explícitamente:

```dotenv
COURSES_INGEST_ENABLED=true
COURSES_INGEST_INTERVAL_HOURS=24
```

Se ejecuta al arrancar y luego en el intervalo (entero **6–168 horas**, 24 por defecto).
No se solapan ticks locales ni procesos que usan el mismo PostgreSQL. Se espera la
ejecución activa al apagar. Es un timer del proceso, no un cron durable ni otro scheduler
distribuido. En App Service requiere **Always On**, proceso activo y credenciales
separadas; usar una instancia para una cadencia predecible. Cada instancia tiene su propio
reloj y los reinicios disparan otro intento. El lock evita simultaneidad, no garantiza una
única ejecución por intervalo entre instancias ni una cuota contractual global. No habilitar
otros pilotos en paralelo para multiplicar peticiones. El opt-in queda desactivado por defecto.

## Pruebas y Android

`test/fixtures/automatic-courses.test.json` contiene una copia mínima identificada de
metadatos auténticos, sin lecciones ni supuestas aprobaciones. Las pruebas inyectan el
transporte y prohíben red externa. El demo real adicional usa las fuentes en vivo, no esos
fixtures. Los resultados HTTP de la evidencia se produjeron con certificado/identidad
**TEST** del harness local, sin alterar los guards de seguridad del servicio.

Para repetir la integración con un PostgreSQL 17 desechable configurado como en CI:

```powershell
# Además de los roles existentes del workflow, provisionar en ese servidor de pruebas:
# cvexpert_course_ingest LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
# PASSWORD 'TEST-course-ingest-only'. Nunca usar ese secreto en operación.
$env:NODE_ENV='test'
$env:PGHOST='127.0.0.1'
$env:PGPORT='55439'
$env:PGDATABASE='cvexpert_ci'
$env:PGUSER='cvexpert_ci'
$env:PGPASSWORD='ci-only-disposable-password'
$env:DB_SSL_MODE='disable'
$env:PG_READONLY_PASSWORD='ci-readonly-disposable-password'
node --import tsx --test test/db/automatic-course-ingestion.test.ts
```

El helper crea/elimina solo su UUID; el test aplica 001–005 y grants en esa base,
demuestra primera carga, repetición, protección de datos manuales, ambigüedad canónica,
rollback, exclusión por PostgreSQL, permisos y ambos endpoints. CI agrega únicamente la
identidad local de pruebas; sus validaciones existentes se conservan.

Android ya está conectado: `SkillsGapApi.kt:12` declara el POST,
`JobSkillsGapViewModel.kt:284` usa recomendaciones por defecto (`evaluationOnly=false`),
`ApiJobSkillsGapRepository.kt:39` invoca ese endpoint,
`JobSkillsGapMapper.kt:83` y `:135` consumen grupos/cursos y duración nullable,
y `JobGapResult.kt:192` presenta las tarjetas. `Course.kt:27` admite estos cursos reales.
Se verificó el código en el workspace móvil sin modificarlo; no se ha demostrado aquí
una sesión de Android contra Azure. No se identificó un ajuste de contrato necesario.

Validación local: build correcto; **188/188** pruebas generales; **132/132** PostgreSQL;
**52/52** controles del workflow; auditoría **0 vulnerabilidades**; diff-check correcto.
En Windows se normalizaron temporalmente a LF dos archivos que pruebas existentes
comparan literalmente, restaurando sus bytes al terminar. Los tests HTTP usan sockets
loopback autorizados; no se debilitan assertions ni controles.

## Requisitos externos para Azure

No se recibió destino ni secreto operativo `COURSES_INGEST_*`, ni se desplegó nada.
Para ejecutar allí faltan acciones concretas del operador autorizado:

1. Autorizar/publicar esta versión del servicio mediante el despliegue habitual.
2. Provisionar el LOGIN separado y aplicar los grants a la base autorizada con 001–005.
3. Configurar sus variables/secreto/TLS y permitir salida HTTPS a `data.open.ac.uk`,
   `api.github.com` y `raw.githubusercontent.com`.
4. Ejecutar una vez y conservar el reporte; comprobar ambos endpoints con APIM/identidad
   reales. Activar el timer solo si se desea, con Always On y una cadencia acordada.

No hacen falta credenciales Microsoft Learn, otro motor de recomendaciones ni cambios
Android/APIM para el contrato demostrado. No se hizo push, merge ni despliegue automático.
