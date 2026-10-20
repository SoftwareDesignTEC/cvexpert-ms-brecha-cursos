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

## PostgreSQL local — Etapa A

Requisitos adicionales: Docker Engine o Docker Desktop con contenedores Linux
y Docker Compose. No hace falta instalar PostgreSQL en el host.
Esta etapa no implementa `GET /courses` ni cambia el contrato HTTP existente.

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
etapa no cambia OpenAPI ni los modelos de la API y no decide esa conversión.

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

Pendientes: revisión del modelo con el equipo, endpoint `GET /courses`, política
de URLs y nombres, roles de mínimo privilegio, respaldo/restauración, credenciales
administradas y validación TLS remota. Las pruebas normales (`npm test`) no
necesitan PostgreSQL; las de integración (`npm run db:test`) sí lo necesitan.
