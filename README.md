# cvexpert-ms-brecha-cursos
Microservicio de brecha de habilidades y recomendación de cursos de CVExpert

## Ejecución local

Requiere Node.js 24 y npm. Instalar dependencias con `npm ci`, copiar
`.env.example` a `.env` y ejecutar `npm run dev`. Para ejecutar el compilado:
`npm run build` y `npm start`. Se usa `PORT=3000` de forma predeterminada.

`npm test` ejecuta las pruebas de integración con el runner de Node y `tsx`;
cada servidor de prueba usa un puerto temporal en loopback y se cierra al finalizar.
`npm run build` comprueba tipos y genera los archivos de producción en `dist`.
Los tests TypeScript se ejecutan con `tsx` y no se incluyen en `dist`.

## Primera versión de skills-gap: solo demostración

- `GET /health` devuelve `{ "status": "ok", "service": "brecha-cursos" }`.
- `GET /skills-gap?page=1&pageSize=20` devuelve `items`, `page`, `pageSize`
  y `totalRecords`. Hay tres registros ficticios en orden fijo.
- `page` y `pageSize` son opcionales e independientes: valores predeterminados
  1 y 20. Deben ser enteros positivos seguros; `pageSize` tiene máximo 100.
  Se rechazan valores vacíos, decimales, signos, espacios, notación exponencial,
  parámetros repetidos, arreglos y objetos con HTTP 400. Los parámetros ajenos
  a la paginación se ignoran.
- Una página posterior al último registro devuelve HTTP 200 e `items: []`,
  conservando el total de registros, independiente del tamaño de página.

La ruta solo está habilitada con `NODE_ENV=development` o `NODE_ENV=test`.
En producción, sin `NODE_ENV` o con cualquier otro valor devuelve HTTP 503,
sin registros. `/health` continúa disponible. Configurar correctamente
`NODE_ENV=production` al desplegar; no usar el `.env` local en producción.

Las habilidades y títulos llevan `[DEMO]`, los enlaces apuntan a `example.org`
y la respuesta incluye `X-Data-Mode: demo` y `Cache-Control: no-store`.
Los números de nivel son ilustrativos: la escala sigue pendiente de acuerdo.
No hay análisis de usuarios, demanda real ni recomendaciones auténticas.
React y Android deben mostrar el carácter demostrativo de estos registros;
las etiquetas del cuerpo permiten reconocerlo incluso sin leer encabezados.

## Organización

- `src/app.ts`: construye Express y conserva `/health`, sin abrir puertos.
- `src/server.ts`: carga `.env` y abre el servidor HTTP.
- `src/routes/skills-gap.routes.ts`: registra la ruta.
- `src/controllers/skills-gap.controller.ts`: controla disponibilidad,
  valida query strings y traduce el resultado a HTTP.
- `src/services/skills-gap.service.ts`: tipos del contrato y paginación
  de datos ficticios, sin dependencia de Express.
- `test/app.test.ts`: pruebas HTTP de salud, contrato, paginación,
  parámetros inválidos y bloqueo de demostración.

`openapi.yaml` conserva los esquemas preliminares y documenta el modo demo.
La autenticación descrita mediante APIM es una intención del contrato:
esta versión no valida identidades ni utiliza `X-User-Id`.
No se han implementado Azure ni Service Bus. El catálogo PostgreSQL descrito
abajo es independiente del endpoint demo: `/skills-gap` no consulta la base.

## Contrato del catálogo — implementado, pendiente de ratificación

`openapi.yaml` distingue el comportamiento disponible del diseño propuesto.
Según el contexto confirmado del proyecto, Fase I ya contempla cursos sugeridos
en `/skills-gap` y el documento de responsabilidades también exige documentar
el catálogo. No se encontraron esos documentos fuente en este repositorio;
no se atribuyen aquí otros requisitos a ellos.

| Contrato o capacidad | Estado comprobado |
| --- | --- |
| `GET /health` | Implementado y documentado en OpenAPI. |
| `GET /skills-gap` y cursos sugeridos | Implementado solo con datos demo en development/test; bloqueado en otros entornos. |
| `page` y `pageSize` en `/skills-gap` | Implementados; nombres, valores predeterminados, límites y esquemas existentes se conservan. |
| Catálogo PostgreSQL | Esquema, migraciones y seed opcional implementados; consultado por `/courses`. |
| `GET /courses`, filtros y esquemas `CoursesPage`/`CatalogCourse` | Implementados conforme al borrador; sus decisiones contractuales requieren ratificación del equipo antes de fusionar el PR. No desplegado a Azure. |
| Recomendaciones personalizadas reales e integración de identidad/APIM | No implementadas. No se introduce una política nueva de autenticación. |

La web y Android continúan consumiendo `/skills-gap`. Documentar `/courses`
no exige otra llamada para obtener sus recomendaciones ni sustituye el arreglo
`courses` de cada brecha. No se crean endpoints administrativos ni contratos
con otros microservicios. Los ejemplos del nuevo contrato son ficticios y no
constituyen una prueba de que la ruta funcione.

### Consulta implementada conforme al borrador

`GET /courses` consulta el catálogo general, sin seleccionar un usuario.
Se propone conservar el sobre `items`, `page`, `pageSize`, `totalRecords`, con
valores predeterminados 1 y 20 y máximo `pageSize=100`. El total cuenta cursos
únicos después de filtrar y antes de paginar. No se repite un curso por cada
habilidad asociada. Una consulta sin coincidencias o una página fuera de rango
devuelve, en la propuesta, HTTP 200 con `items: []` y el total correspondiente.

Se propone ordenar por ID SQL ascendente, como entero. Ordenar las cadenas
públicas pondría por ejemplo `"10"` antes de `"2"`. La paginación por página no
garantiza una instantánea si el catálogo cambia entre solicitudes. No se añade
un parámetro de orden configurable ni paginación por cursor en este borrador.

| Filtro opcional propuesto | Respaldo en el modelo | Semántica propuesta |
| --- | --- | --- |
| `platform` | `courses.platform` | Coincidencia exacta sensible a mayúsculas, sin recortar o normalizar el valor. |
| `isPaid` | `courses.is_paid` | Literal `true` o `false`; omitirlo incluye ambos. |
| `skillName` | `skills.name` y `course_skills` | Una habilidad por nombre exacto sensible a mayúsculas. No requiere otro endpoint para resolver IDs. |

Los filtros se combinan con AND. Se propone rechazar con HTTP 400 parámetros
reconocidos repetidos, objetos, arreglos, vacíos o solo espacios; en paginación
tampoco se aceptan signos, decimales, notación exponencial o números inseguros.
Los parámetros desconocidos se ignoran, siguiendo el comportamiento existente
de `/skills-gap`. También se rechaza NUL, no representable en `text` de PostgreSQL.
Los errores implementados son 400 con `{ "error": "INVALID_QUERY", "message":
"Parámetros de consulta inválidos." }` y 503 con `{ "error": "CATALOG_UNAVAILABLE",
"message": "El catálogo no está disponible temporalmente." }`. Estos cuerpos
concretan una parte no definida del borrador y requieren ratificación. No se
exponen consultas, mensajes del driver, hosts ni contraseñas. Las respuestas de
`/courses` llevan `Cache-Control: no-store`.

Estos filtros son opciones de diseño respaldadas por las tablas, no requisitos
confirmados de web o Android. No se proponen filtros de usuario, afinidad,
nivel de mercado, idioma, puntuación o precio: no tienen respaldo en este modelo.

### Curso de catálogo y curso sugerido

Se mantienen esquemas independientes, evitando extender `CourseSuggestion`
mediante `allOf`: ese esquema no permite la duración desconocida del catálogo.
Los tipos y esquemas existentes de `/skills-gap` no cambian. Los nuevos modelos
de catálogo están separados en `src/models/courses.ts`.

| Campo | `CourseSuggestion` existente | `CatalogCourse` propuesto |
| --- | --- | --- |
| `id` | Cadena, sin exigir formato decimal; los IDs demo actuales siguen válidos. | Cadena opaca para clientes; se propone `String(courses.id)`, pendiente de aprobación. |
| `title`, `url`, `platform` | Obligatorios. | Obligatorios, mapeados a las columnas homónimas. |
| `logoUrl` | Obligatorio, nullable. | Obligatorio, nullable; procede de `logo_url`. |
| `durationHours` | Obligatorio, entero no nullable. | Obligatorio, entero nullable; procede de `duration_hours`. |
| `isPaid` | No forma parte del esquema actual. | Booleano obligatorio, procede de `is_paid`. |
| `skills` | No forma parte del esquema actual. | Arreglo obligatorio de nombres de habilidades, sin duplicados; admite `[]`. |

Convertir un ID SQL a cadena no genera una identidad nueva ni ofrece secreto
o autorización. Se propone que los clientes lo almacenen sin interpretarlo;
no se cambia la PK ni se impone un formato nuevo sobre `/skills-gap`.

En el catálogo, `null` conserva el significado de duración desconocida.
No se debe inventar una duración, sustituirla por cero ni enviar null en
`CourseSuggestion`: rompería el contrato que consumen web y Android.
La integración futura de recomendaciones deberá esperar una política acordada
para cursos sin duración, o una evolución explícita del contrato con clientes.

### Decisiones para consultar al equipo

1. ¿Se aprueban los filtros propuestos y su coincidencia exacta, o existe una
   necesidad confirmada de búsqueda parcial o normalización?
2. ¿Se aprueba la cadena decimal como ID público, y cómo se coordinará la
   identidad de cursos entre catálogo y recomendaciones futuras?
3. ¿Se aprueban `durationHours: null` y los campos `isPaid`/`skills` en el catálogo?
4. ¿Qué política tendrá `/skills-gap` ante cursos persistidos sin duración,
   manteniendo compatible el contrato actual de web y Android?
5. ¿Qué política de acceso al catálogo se acordará y se ratifican los cuerpos
   JSON 400/503 implementados y el rechazo de NUL?
   La ausencia de `security` en el borrador no aprueba acceso anónimo.
6. ¿Se aprueban el orden, los límites, las reglas de filtros combinados y los
   estados HTTP propuestos antes de implementar la ruta?

Todas las reglas nuevas de `/courses` requieren ratificación antes de fusionar.
Implementarlas y documentarlas no las convierte en requisitos aprobados ni
autoriza acceso público, autenticación nueva o despliegue.

### Organización y consistencia de la consulta

- `routes/courses.routes.ts`: registra solo `GET /courses`.
- `controllers/courses.controller.ts`: valida los parámetros originales de la
  URL, incluidos repetidos y claves con corchetes que un parser podría omitir.
  Los desconocidos se ignoran. No se recortan valores para alterar coincidencias.
- `services/courses.service.ts`: adapta filas SQL al modelo público, convirtiendo
  IDs a cadenas y conservando los NULL de logo y duración.
- `repositories/courses.repository.ts`: contiene una sentencia SQL fija con
  parámetros para todos los valores del cliente, incluido LIMIT/OFFSET.

La consulta usa un CTE filtrado y `EXISTS` para habilidades: cada curso aparece
una vez. El arreglo de habilidades contiene todas las del curso, aunque el
filtro seleccione una de ellas. Conteo y página salen del mismo SELECT y ven
la misma instantánea, sin necesitar transacciones de escritura o permisos
administrativos. El offset se calcula con `BigInt`, se envía como texto decimal
y PostgreSQL lo recibe como `bigint`. Se aceptan páginas hasta el máximo entero
seguro de JavaScript; incluso su offset con tamaño 100 cabe en bigint SQL.
Una página enorme válida devuelve un arreglo vacío con el total real, sin
redondeos ni multiplicaciones inseguras. El conteo exacto requiere recorrer el
conjunto filtrado: evaluar planes y tiempos si el catálogo crece sustancialmente.

El repositorio crea el pool solo ante una consulta válida de `/courses`. Iniciar
Express, `/health` y `/skills-gap` no requieren PostgreSQL. Configuración inválida
o base caída producen 503 solo en el catálogo, sin recurrir a datos ficticios.
Al recibir SIGTERM/SIGINT, el servidor deja terminar peticiones y cierra el pool.
No se llaman otros microservicios; los clientes transportan la información que
corresponda entre dominios. Cálculo real de brechas y Service Bus siguen fuera
de este PR.

### Uso local y permisos de aplicación

Usar un dueño local para migraciones/seed y `cvexpert_brecha_app` para HTTP.
No ejecutar migraciones con el usuario de aplicación. Sobre PostgreSQL local,
un administrador puede crear el rol si todavía no existe, asignarle una
contraseña local mediante `\password cvexpert_brecha_app` en psql y conceder:

```sql
CREATE ROLE cvexpert_brecha_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT CONNECT ON DATABASE cvexpert_catalog TO cvexpert_brecha_app;
GRANT USAGE ON SCHEMA public TO cvexpert_brecha_app;
GRANT SELECT ON public.courses, public.skills, public.course_skills TO cvexpert_brecha_app;
```

Son instrucciones para desarrollo local, no un script ejecutado por HTTP o
una instrucción para modificar Azure. Si el rol existe, revisar sus permisos;
no recrearlo. Para arrancar la app en otra terminal, configurar las variables
existentes con `PGUSER=cvexpert_brecha_app` y su contraseña local. Las variables
del proceso tienen prioridad sobre `.env`; no versionar contraseñas. Mantener
TLS verificado donde ya sea obligatorio; el modo sin TLS del PostgreSQL de
pruebas local no se extiende a producción.

Ejemplo de consulta local (no requiere agregar autenticación nueva):

```sh
curl 'http://127.0.0.1:3000/courses?page=1&pageSize=20&isPaid=false'
```

Para una demostración **local opcional**, usar el mecanismo separado ya existente:
con cuenta dueña, `NODE_ENV=development`, `PGHOST=127.0.0.1` y base local,
ejecutar `npm run db:migrate` y luego `npm run db:seed`. Después consultar con
la cuenta SELECT. El seed usa `[DEMO]`, plataforma ficticia y `example.org`,
es repetible y no se ejecuta automáticamente al arrancar ni en CI/producción.
No ejecutarlo con credenciales o contra una base Azure. Los fixtures `[TEST]`
de pruebas son diferentes y solo existen en bases desechables; ningún registro
de demostración o prueba representa recomendaciones reales de `/skills-gap`.

## PostgreSQL local — Etapa A

Requisitos adicionales: Docker Engine o Docker Desktop con contenedores Linux
y Docker Compose. No hace falta instalar PostgreSQL en el host.
La etapa de infraestructura precedió a `/courses`, implementado ahora según el
borrador sin cambiar el contrato de `/skills-gap`.

### Preparación y variables

1. Ejecutar `npm ci`.
2. Copiar `.env.example` a `.env` (si ya existe, completar sus variables sin
   sobrescribir la configuración local).
3. Completar `PGPASSWORD` en `.env` con una contraseña local propia.
   El ejemplo versionado deja ese valor vacío deliberadamente.
4. Ejecutar `docker compose config --quiet` para validar Compose sin imprimir
   la configuración resuelta, que contiene la contraseña.

| Variable | Uso |
| --- | --- |
| `NODE_ENV` | `development` local; el seed solo acepta `development` o `test`. |
| `PGHOST` | `127.0.0.1` desde Node en el host. |
| `PGPORT` | `5433` desde el host; el contenedor escucha en `5432`. |
| `PGDATABASE` | Nombre de la base local, también usado por Compose al inicializar. |
| `PGUSER` | Usuario local, también usado por Compose al inicializar. |
| `PGPASSWORD` | Contraseña local obligatoria; no colocar en Git ni en comandos compartidos. |
| `DB_SSL_MODE` | `disable` local; `verify-full` valida TLS, certificado y hostname. Por defecto es `verify-full`. |
| `PGSSLROOTCERT` | Ruta opcional a una CA PEM confiable; vacío usa las CA de Node. |

Compose lee `.env` para sustituir variables y envía únicamente las variables
`POSTGRES_*` al contenedor. Los comandos de Node cargan `.env` mediante dotenv;
las variables que ya existan en el proceso tienen prioridad. La app HTTP no
crea el pool ni requiere estas variables mientras no use el catálogo.

`.env` está excluido por `.gitignore`; `.env.example` contiene nombres y valores
no secretos. Comprobar con `git check-ignore .env` y revisar el diff antes de
versionar. No usar una URL de conexión con contraseña: esta implementación
usa variables separadas y no imprime la configuración de conexión.

### Arranque, migraciones y seed opcional

```sh
docker compose up -d --wait postgres
npm run db:migrate
npm run db:check
# Opcional, exclusivamente para demostración local:
npm run db:seed
npm run db:check
# Pruebas de integridad y migraciones en bases desechables:
npm run db:test
```

`db:check` consulta el servidor y las tres tablas, muestra conteos y hasta diez
cursos con sus habilidades. Si falta migrar, falla con código de salida 1.
`db:test` requiere PostgreSQL local en loopback, `NODE_ENV=development` o `test`
y un usuario con permiso `CREATEDB` (el usuario del Compose local lo tiene).
Las pruebas HTTP del catálogo requieren además el rol local `cvexpert_brecha_app`
sin privilegios administrativos y `PG_READONLY_PASSWORD` con su contraseña solo
para estas pruebas. Cada base aislada concede únicamente USAGE de schema y SELECT
en las tres tablas a ese rol. En CI, ambos roles se crean en el contenedor
desechable con contraseñas ficticias exclusivas de prueba; nunca en Azure.
Se conecta a la base administrativa `postgres` para crear bases vacías con
`TEMPLATE template0`, nombradas `cvexpert_test_<UUID>`. Nunca usa `PGDATABASE`
como destino de las pruebas ni modifica sus tablas o secuencias.

Cada base creada pertenece a una ejecución: al finalizar, incluso ante errores,
se cierran sus pools y se intenta eliminar exclusivamente esa base mediante
`DROP DATABASE`, sin `FORCE` ni terminación de conexiones ajenas. Si no se puede
crear o limpiar, las pruebas fallan; no se recurre a la base de desarrollo.
Una interrupción abrupta del proceso puede dejar una base de prueba pendiente
de revisión y limpieza manual. No se borra ni restablece el volumen Docker.

Las pruebas del catálogo migran su base aislada y prueban restricciones y
eliminaciones reales sobre fixtures dentro de transacciones revertidas. Las
del ejecutor usan copias temporales de los SQL para probar primera aplicación,
repetición, checksum alterado, rollback completo de DDL y concurrencia. Esta
última observa dos ejecutores esperando el advisory lock antes de liberarlo;
no depende de suponer que un sleep causó una carrera. También se simula un
fallo de `pool.connect()` y se comprueba que el pool quede cerrado.

Los comandos npm usan `tsx` como herramienta de desarrollo. Tras compilar,
también se pueden ejecutar `node dist/db/cli.js migrate`, `seed` o `check`,
conservando la carpeta `db/` junto a `dist/` en la raíz. Los archivos SQL no
son copiados por TypeScript.

### Docker, red y persistencia

`compose.yaml` usa la imagen oficial `postgres:17-bookworm`, fijando la versión
mayor 17 y la familia Debian. La etiqueta recibe parches; para fijar exactamente
los mismos binarios se podría elegir un digest en una etapa posterior.

El servicio vive en la red predeterminada de este proyecto Compose. Solo
publica `127.0.0.1:5433:5432`: Node conecta a `127.0.0.1:5433`, Docker dirige
esa conexión al puerto `5432` del contenedor y no publica el servicio en otras
interfaces del host. Si Node se contenedorizara después, usaría el nombre de
servicio `postgres` y el puerto interno `5432`; eso no se implementa aquí.

El healthcheck usa `pg_isready` para comprobar que el motor acepta conexiones;
no certifica que las tablas existan o que el seed se haya cargado. Por eso
existe `db:check`. `--wait` espera el estado saludable antes de terminar.

El volumen nombrado `postgres_data` se monta en `/var/lib/postgresql/data`,
la ruta de datos de esta imagen PostgreSQL 17. Compose lo identifica como
`cvexpert-brecha-cursos_postgres_data`. El volumen existe independientemente
del proceso y del contenedor: reiniciar o recrear el contenedor conserva los
datos si se conecta el mismo volumen. No reemplaza una copia de seguridad.

Las variables `POSTGRES_DB`, `POSTGRES_USER` y `POSTGRES_PASSWORD` inicializan
un volumen vacío. Cambiarlas después en `.env` no renombra la base ni cambia
la contraseña almacenada: eso requiere una operación explícita en PostgreSQL,
no borrar el volumen. El usuario inicial de la imagen tiene privilegios de
administrador; es una simplificación local, pendiente de separar roles antes
de cualquier despliegue real.

Para comprobar persistencia sin borrar datos:

```sh
npm run db:check
docker compose stop postgres
docker compose up -d --wait postgres
npm run db:check
```

Los conteos y los cursos deben mantenerse. Para dejarlo detenido:
`docker compose stop postgres`. `docker compose down` retira contenedor y red
y conserva el volumen nombrado por defecto. No agregar opciones para borrar
volúmenes ni ejecutar comandos de limpieza destructiva sin autorización.

### Modelo y restricciones

La relación es `courses 1 — N course_skills N — 1 skills`: un curso enseña varias
habilidades y una habilidad puede enseñarse en varios cursos. Separar las tres
tablas evita repetir cursos o guardar listas de IDs en una columna.

- `skills.id` y `courses.id`: `integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY`.
  PostgreSQL genera IDs; la PK identifica cada fila sin duplicados ni NULL.
  Un entero de 32 bits es suficiente para este catálogo universitario y llega
  a Node como `number`. UUID permitiría generar IDs distribuidos, pero hoy no
  existe ese requisito; `bigint` agregaría conversión porque `pg` lo devuelve
  como texto para evitar pérdida de precisión.
- Nombres, títulos, plataformas y URLs: `text`, sin máximos arbitrarios.
  Campos obligatorios usan `NOT NULL`; los nombres, títulos y plataformas
  rechazan vacío y espacios exteriores. `skills.name` es único con comparación
  sensible a mayúsculas. Normalización de nombres y sinónimos queda pendiente.
- `courses.url` es única por URL exacta: primera regla local de deduplicación.
  Título y plataforma no son únicos; dos cursos pueden compartirlos.
  Una restricción básica exige enlaces HTTP(S) sin espacios, sin prometer que
  la URL exista. Canonicalización y validación completa quedan pendientes.
- `is_paid`: `boolean NOT NULL`, sin valor predeterminado para exigir una decisión
  explícita al insertar. `duration_hours`: `integer NULL` con `CHECK >= 0`;
  NULL significa desconocido y 0 no significa desconocido. Se mantienen horas
  enteras en línea con el contrato preliminar; fracciones requerirían revisión.
  `logo_url` admite NULL o un enlace HTTP(S).
- `course_skills`: PK `(course_id, skill_id)` impide repetir una asociación.
  Las FK exigen que ambos extremos existan. `ON DELETE CASCADE` en `course_id`
  limpia solo asociaciones al eliminar un curso; no elimina habilidades.
  `ON DELETE RESTRICT` en `skill_id` impide borrar una habilidad aún utilizada.
  Actualizar IDs utiliza la regla predeterminada `NO ACTION`.
- PostgreSQL crea índices para las PK y los `UNIQUE`. La PK compuesta cubre
  búsquedas por curso; el índice `(skill_id, course_id)` cubre consultas por
  habilidad y comprobaciones de su FK. No se añaden índices especulativos para
  búsquedas HTTP que aún no existen.

No se agregan tablas de usuarios, habilidades personales, mercado o recomendaciones.
Los IDs SQL son internos; no establecen cómo se expondrán en un futuro contrato HTTP.

**Incompatibilidad pendiente entre persistencia y contrato HTTP:** PostgreSQL
permite `courses.duration_hours = NULL`, pero el esquema `CourseSuggestion` de
OpenAPI exige `durationHours` entero no nullable (el modelo TypeScript usa
`number`). Además, PostgreSQL genera IDs enteros y ese contrato exige `id` de
tipo cadena (`string`). No es correcto devolver directamente una fila SQL como
respuesta HTTP ni convertir una duración desconocida en cero arbitrariamente.
Antes de conectar el catálogo a la API debemos acordar con el equipo la
nulabilidad, la representación de IDs y el mapeo entre ambos modelos. Esta
etapa de PostgreSQL no modificó los esquemas existentes de la API. El borrador
de `/courses` propone un mapeo independiente, todavía sin aprobar; no modifica
`CourseSuggestion` ni los modelos TypeScript implementados.

### Migraciones y datos de demostración

Una migración cambia la estructura de la base. `db/migrations/NNN_descripcion.sql`
se ejecuta en orden y queda registrada en `schema_migrations` con fecha y SHA-256.
El ejecutor normaliza CRLF/LF para evitar diferencias entre Windows y Linux.
Todas las migraciones pendientes y sus registros se aplican en una transacción:
si alguna falla, se revierte el lote. Un advisory lock transaccional serializa
nuestros comandos de migración y seed; un timeout evita esperas indefinidas.

Repetir `npm run db:migrate` no reaplica lo registrado. Si cambia o desaparece
un archivo aplicado, o se inserta otro antes del historial ya aplicado, el comando
falla. Nunca editar migraciones aplicadas: agregar `002_...sql` y siguientes.
Los archivos deben contener SQL transaccional, sin `BEGIN`/`COMMIT` propios ni
operaciones como `CREATE INDEX CONCURRENTLY`. No hay comando `down`, reset,
`DROP` ni rollback destructivo. Las migraciones futuras aún requieren revisión
y respaldo: un ejecutor no convierte cualquier SQL en seguro.

Consideramos `node-pg-migrate` (más funciones, otra dependencia) y SQL con un
ejecutor pequeño. Se eligió la segunda opción para mantener el esquema legible
y defendible. Si aumentan las necesidades operativas, conviene adoptar una
herramienta mantenida en lugar de ampliar indefinidamente este ejecutor.

Un seed inserta datos, no estructura. `db:seed` es opcional, no lo llama la
migración ni el arranque de Express o Docker. Solo permite `development`/`test`,
incluso si falta `NODE_ENV` lo rechaza. Los ejemplos usan `[DEMO]` y enlaces
`example.org`; `ON CONFLICT DO NOTHING` y las restricciones únicas evitan
duplicados al repetirlo sin sobrescribir filas existentes. No usar una base de
producción con `NODE_ENV=development`: la aplicación confía en esa configuración.

### Pool, TLS y límites de esta etapa

`src/db/config.ts` valida variables y configura conexión; `pool.ts` crea un
pool bajo demanda. Un pool reutiliza conexiones en vez de abrir una por consulta;
se limita a cinco, con espera de conexión de cinco segundos, timeout de consulta
de quince segundos y cierre de conexiones inactivas tras treinta segundos.
Los comandos liberan los clientes de transacción y cierran el pool al terminar.
No existe conexión global abierta al importar Express.

Para un servidor futuro con TLS, usar `DB_SSL_MODE=verify-full`, hostname real
y, si es necesario, `PGSSLROOTCERT`. Nunca se usa `rejectUnauthorized: false`.
Fuera de desarrollo/pruebas el código rechaza TLS deshabilitado. Esta preparación
no provisiona Azure ni comprueba todavía certificados contra un servidor remoto.

PostgreSQL encaja porque este dominio necesita relaciones muchos a muchos,
integridad referencial, unicidad y transacciones. SQLite simplificaría el arranque,
pero no verificaría el motor PostgreSQL solicitado; un almacén documental haría
menos directa la integridad de estas asociaciones.

Pendientes: ratificación del contrato `/courses` con el equipo, política
de URLs y nombres, roles de mínimo privilegio, respaldo/restauración, credenciales
administradas y validación TLS remota. Las pruebas normales (`npm test`) no
necesitan PostgreSQL; las de integración (`npm run db:test`) sí lo necesitan.

## CI/CD con GitHub Actions

El workflow `.github/workflows/ci-cd.yml` ejecuta CI para PR cuyo destino sea
`develop` o `main`, y para pushes a `develop` y `main`. Las acciones oficiales están fijadas
por SHA de commit. No usa `pull_request_target`, publish profiles ni credenciales
de Azure para validar contribuciones.

### CI: Node 24 y PostgreSQL 17 desechable

En Ubuntu 24.04, con Node.js 24, el job ejecuta en orden:

```sh
npm ci
npm audit --audit-level=high
npm run build
npm test
npm run db:test
```

PostgreSQL 17 se crea como service container, sin volumen persistente, con
credenciales públicas exclusivamente de prueba y `PGHOST=127.0.0.1`, puerto
5432, `NODE_ENV=test` y TLS desactivado solo para esta conexión local.
El usuario bootstrap `postgres`, exclusivo de ese contenedor, crea un rol de
pruebas distinto con LOGIN y CREATEDB, sin SUPERUSER ni CREATEROLE. Crea también
`cvexpert_brecha_app` sin CREATEDB, SUPERUSER o CREATEROLE para probar SELECT
y la denegación efectiva de escrituras. No se añaden privilegios al rol HTTP.
Las pruebas crean y eliminan únicamente sus bases
`cvexpert_test_<UUID>`; el contenedor completo desaparece al terminar el job.
No se usa `.env`, Key Vault ni Azure PostgreSQL, no se ejecuta el seed y no se
llama a `db:migrate` sobre ninguna base compartida o de producción.

El filtro de rutas está dentro del workflow, no en `on.paths`, para no dejar un
check requerido pendiente en PR de documentación. Solo omite el job Node/PG
cuando TODOS los archivos modificados son `README.md` o Markdown bajo `docs/`.
Cambios de código, tests, SQL, dependencias, `.github`, OpenAPI, configuraciones
y cualquier ruta desconocida ejecutan la suite. Los renombrados consideran tanto
la ruta antigua como la nueva. Incluso un PR solo documental prueba los guards.
Los pushes a `develop` y `main` siempre ejecutan CI completo, independientemente
de las rutas, incluida la comprobación del ZIP de producción.

El job final **CI** siempre se evalúa y falla si fallaron la clasificación o las
pruebas requeridas o la comprobación del paquete de producción. Configurar ese check como obligatorio en las reglas de
protección de `develop` y `main`; el workflow no modifica esas reglas. Requerir
también revisión de cambios en `.github/`. Los runs anteriores del mismo PR se
cancelan; un despliegue en ejecución no se cancela por un push posterior.

Para probar localmente los guards sin Azure ni PostgreSQL:

```sh
node --test .github/scripts/*.test.mjs
```

El job de clasificación también valida los workflows con `actionlint` 1.7.12,
descargado de la release oficial y comprobado contra un SHA-256 fijo en
`.github/scripts/actionlint.sh`. No ejecuta un instalador `latest`. Esta
validación y los tests de guards se ejecutan también en PR solo documentales.

La auditoría npm incluye dependencias de desarrollo y bloquea CI ante severidad
alta o crítica; no hay `continue-on-error`, excepciones de avisos ni arreglos
forzados. Un fallo del servicio de auditoría tampoco se convierte en éxito.
La revisión de GHSA-27r3-jxmh-p828 actualizó el lockfile de `body-parser` 2.3.0
a 2.4.0, compatible con `express@5.3.0` y su rango `^2.3.0`. No se añadieron
dependencias directas, overrides o cambios mayores. Para auditar solo runtime:

```sh
npm audit --omit=dev
```

### Comprobación del ZIP sin desplegar

Después de las pruebas, el job `Verify production ZIP (no deployment)` descarga
el compilado del mismo run y ejecuta `.github/scripts/package-app.sh`. Construye
el ZIP desde una lista permitida, no desde todo el workspace, y elimina de la
copia los CLI compilados de migraciones y seeds. El verificador
`verify-package.mjs` comprueba las rutas del ZIP, la presencia de `dist/server.js`,
`dist/app.js`, manifiestos y dependencias de producción; rechaza `.env`, SQL,
directorios de migraciones/seeds, los CLI administrativos, archivos de claves,
credenciales con nombres conocidos y rutas que intenten salir del directorio.
Los tests negativos comprueban que esas entradas sean rechazadas.

Luego extrae ese mismo ZIP en un directorio temporal y ejecuta el servidor
compilado real con `NODE_ENV=production` y un puerto local temporal, sin heredar
variables PG, Azure o tokens GitHub. Exige `/health=200` con su JSON exacto y
`/skills-gap=503` y `/courses=503` sin configuración PostgreSQL, manteniendo
`/health=200`. Cierra el proceso y elimina únicamente los archivos temporales.
La verificación forma parte del check obligatorio CI; no necesita OIDC o Azure.
El filtrado de archivos no es un detector exhaustivo de secretos incrustados en
código: sigue siendo necesario revisar que no se versionen credenciales.

### CD: preparado, desactivado por defecto

No se ha desplegado a Azure como parte de esta implementación. El destino está
fijado a App Service Linux `cvexpert-ms-brecha-cursos` en `rg-cvexpert`.
Solo un push a `main`, después de CI exitoso para ese mismo commit y con la
variable de repositorio `ENABLE_AZURE_DEPLOY` exactamente igual a `true`, puede
publicar el artefacto destinado a Azure e iniciar el job de despliegue. Ausente o con cualquier otro valor,
CD permanece desactivado. No hay disparador manual ni despliegue desde PR,
`develop` o `workflow_run` de otro workflow.

Se empaqueta el `dist` que pasó las pruebas junto a `package.json`, el lockfile
y dependencias de producción instaladas con `npm ci --omit=dev --ignore-scripts`.
El ZIP tiene los archivos en su raíz y no incluye `.env`, fuentes, archivos SQL, datos de seed,
tests o credenciales locales. La instalación sin scripts sirve para las
dependencias actuales; si se agregan dependencias que compilan código nativo,
habrá que revisar este paso y su compatibilidad con el runtime de App Service.
Los artefactos duran un día y se consumen en el mismo run, identificados por SHA.
No se ejecutan migraciones, seeds o pruebas de base de datos en el job Azure.
La creación y comprobación local del ZIP sí ocurre en los PR de código y pushes
a ambas ramas, aunque el despliegue esté desactivado.

El job usa `azure/login` con OIDC y `az webapp deploy` con autenticación Entra;
no genera ni descarga credenciales de publicación. Solo ese job recibe
`id-token: write`; los demás tienen únicamente `contents: read`. El token OIDC
es efímero. La autenticación GitHub-Azure no lee secretos de Key Vault.

### Preparación administrativa pendiente (no automatizada)

1. Crear una aplicación de Entra/service principal **exclusiva para despliegue**.
   No reutilizar la identidad administrada de la aplicación que consume Key Vault.
   Conceder, como punto de partida, Website Contributor limitado al recurso
   App Service, no a la suscripción ni a todo `rg-cvexpert`. Revisar si un rol
   personalizado puede reducirlo más. No conceder permisos de lectura de secretos
   de Key Vault a esta identidad de despliegue.
2. Configurar su federación con issuer `https://token.actions.githubusercontent.com`,
   audience `api://AzureADTokenExchange` y subject
   `repo:SoftwareDesignTEC/cvexpert-ms-brecha-cursos:environment:azure-production`.
   Al usar un environment el subject no es `ref:refs/heads/main`: la restricción
   de rama se configura además en GitHub y ya se verifica en el workflow.
3. Crear el environment GitHub `azure-production`, permitir despliegue solamente
   desde `main` y exigir revisión/aprobación del equipo (según capacidades del plan).
   Mantener las protecciones de rama y del environment; el YAML no las crea.
4. Registrar las variables no secretas `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` y
   `AZURE_SUBSCRIPTION_ID` en ese environment. Son identificadores, no client
   secrets. Mantener por separado los secretos reales de runtime en Key Vault,
   accesibles solo mediante la identidad administrada y sus referencias existentes.
5. Proveer un runner Linux dedicado y confiable con acceso al endpoint SCM privado,
   Node 24 compatible y Azure CLI; registrar su label en la variable **de repositorio**
   `AZURE_DEPLOY_RUNNER`. Nunca usar ese runner para PR no confiables. Sin label,
   el job falla antes de iniciar sesión; no intenta abrir firewalls para desplegar.
6. Revisar y preparar la conectividad privada de App Service/SCM y APIM, DNS y
   certificados. El preflight exige `publicNetworkAccess=Disabled`, HTTPS y TLS
   >=1.2 tanto en la aplicación como en SCM. No basta `clientCertMode=Required`:
   App Service reenvía certificados y el código actual no los valida. Esta
   implementación no abre acceso público ni implementa validación de certificados
   o integración APIM; una alternativa pública restringida requerirá otro diseño
   y aprobación. Un runner hospedado estándar no alcanza un SCM solo privado.
7. Preparar en App Service `NODE|24-lts`, comando de arranque `npm start` o
   `node dist/server.js`, `NODE_ENV=production`, y las opciones
   `SCM_DO_BUILD_DURING_DEPLOYMENT=false` y `ENABLE_ORYX_BUILD=false`.
   Deshabilitar publicación básica tanto en SCM como FTP. El workflow consulta
   y verifica estas opciones; no modifica configuración, red, roles o identidades.
8. El preflight compara el `oid` del principal autenticado con los principal IDs
   de las identidades administradas asignadas al App Service y rechaza reutilizarlas.
   La lectura del token queda en memoria, sin imprimirlo ni guardarlo. Confirmar
   además administrativamente que el principal de despliegue no tiene permisos
   heredados sobre Key Vault.
9. Solo después de revisar estos puntos, habilitar `ENABLE_AZURE_DEPLOY=true`
   a nivel de repositorio y promover cambios a `main` mediante PR. Los workflows
   deben estar presentes en `main` para que un push a esa rama active el proceso.
   Este PR hacia `develop` por sí solo no despliega.

La seguridad del acceso y la verificación funcional a través de APIM quedan
pendientes. El preflight falla cerrado si falta alguna condición; no hace un
smoke test anónimo contra el backend ni transforma un despliegue en aprobación
de sus endpoints de negocio. `/skills-gap` sigue bloqueado en producción mientras
solo existan recomendaciones demo; `/courses` está implementado pero no se
despliega ni se conecta a Azure como parte de este PR.

### Alcance limitado del preflight Azure

El preflight es una consulta de **configuración de control plane**, no una prueba
de APIM, mTLS ni salud funcional de la aplicación desplegada. No realiza ni
modifica conexiones a Azure PostgreSQL, red, identidades o datos de negocio.
Sus condiciones se mantienen sin relajarlas para permitir un despliegue.

Quedan sin comprobar y requieren validación independiente antes de habilitar CD:

- Certificados: cadena de confianza, vigencia, revocación y validación efectiva
  del certificado cliente y su identidad. Leer opciones HTTPS/TLS o exigir red
  privada no demuestra mTLS; el código actual no valida certificados cliente.
- Conectividad APIM-backend: DNS privado, rutas, reglas de acceso y negociación
  TLS desde APIM hacia el backend real.
- Funcionamiento desplegado: arranque efectivo, health check a través del camino
  autorizado y comportamiento de las operaciones reales. El smoke test del ZIP
  solo demuestra arranque local del paquete, no la integración con Azure/APIM.
- Autorización: comparar principal IDs evita reutilizar la identidad administrada,
  pero no demuestra ausencia de privilegios excesivos o heredados sobre Key Vault.

Un preflight exitoso no sustituye estas pruebas ni constituye aprobación para
abrir el backend o activar el despliegue.

Referencias: [PostgreSQL en Actions](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers),
[OIDC y mínimo alcance en App Service](https://learn.microsoft.com/en-us/azure/app-service/deploy-github-actions),
[certificados cliente en App Service](https://learn.microsoft.com/en-us/azure/app-service/app-service-web-configure-tls-mutual-auth).
