
# CVExpert — Microservicio de Brecha de Habilidades y Cursos

Microservicio de CVExpert encargado de comparar las habilidades documentadas en un currículum con los requisitos de ofertas laborales o de un contexto de mercado, identificar brechas y consultar formación relacionada con esas habilidades.

La API está desarrollada con **Node.js 24, TypeScript y Express 5**. Utiliza **PostgreSQL** para almacenar el catálogo de cursos, sus relaciones con habilidades, los requisitos de mercado y las instantáneas de habilidades de usuarios.

## Funcionalidades

- **Análisis por oferta:** compara las habilidades de un CV con las solicitadas por una o varias ofertas laborales.
- **Evaluación de niveles:** identifica niveles requeridos cuando están expresados explícitamente en la descripción o los requisitos de una oferta; informa los casos desconocidos o ambiguos sin inventar equivalencias.
- **Recomendación de cursos:** consulta cursos asociados en el catálogo a habilidades requeridas que no están documentadas en el CV.
- **Catálogo de formación:** lista cursos con paginación y filtros de plataforma, habilidad y modalidad de pago.
- **Brecha frente al mercado:** compara una instantánea de habilidades del usuario con requisitos de mercado previamente cargados y asociados a un contexto configurado.

El análisis distingue entre **cobertura documental** y **nivel de competencia**. Por ejemplo, que una habilidad aparezca en el CV no significa que alcance el nivel exigido; y que no aparezca no demuestra que la persona carezca de ella.

## Tecnologías

| Componente | Tecnología |
| --- | --- |
| Runtime | Node.js 24 |
| Lenguaje | TypeScript |
| API HTTP | Express 5 |
| Base de datos | PostgreSQL (versión 17 en Docker local y CI) |
| Acceso a PostgreSQL | `pg`, con consultas SQL parametrizadas |
| Documentación de API | OpenAPI 3.0 y Swagger UI |
| Pruebas | Node.js Test Runner y `tsx` |
| Integración y despliegue | GitHub Actions y Azure App Service |

## Arquitectura

El servicio separa la exposición HTTP de la lógica de negocio y de la persistencia:

```text
Web / Android
     |
     | HTTPS + token de Google
     v
Azure API Management
     |  Valida el token y agrega X-User-Id
     |  Presenta un certificado de cliente
     v
Express: middleware y rutas
     |
     v
Controladores HTTP
     |
     v
Servicios y dominio
     |
     +------------------------------+
     |                              |
     | Evaluación contextual        | Operaciones con catálogo,
     | sin acceso a base de datos   | mercado o instantáneas
     |                              v
     |                        Repositorios SQL
     |                              |
     |                              v
     |                          PostgreSQL
     v
Respuesta JSON a través de APIM
```

Las responsabilidades principales se distribuyen así:

| Directorio | Responsabilidad |
| --- | --- |
| `src/routes/` | Registro de operaciones HTTP. |
| `src/controllers/` | Validación de solicitudes, códigos de respuesta y traducción de errores. |
| `src/services/` | Coordinación de los casos de uso y las consultas necesarias. |
| `src/domain/` | Normalización de habilidades, comparación ordinal y reglas de análisis independientes de Express. |
| `src/repositories/` | Persistencia y consultas parametrizadas a PostgreSQL. |
| `src/security/` | Verificación del certificado cliente de APIM. |
| `src/db/` y `db/migrations/` | Configuración de PostgreSQL, migraciones y mantenimiento del esquema. |
| `scripts/` | Importación administrativa y descubrimiento controlado de cursos, separados del servidor HTTP. |
| `test/` | Pruebas HTTP, del dominio, seguridad e integración con bases desechables. |

**No se realizan solicitudes HTTP directas a otros microservicios de CVExpert.** Los clientes consultan CVs y Ofertas mediante APIM y envían al análisis únicamente las proyecciones necesarias de esos recursos.

## API HTTP

El contrato completo se encuentra en [`openapi.yaml`](openapi.yaml).

| Método | Ruta | Descripción |
| --- | --- | --- |
| `GET` | `/health` | Comprueba que el proceso HTTP responde. No verifica la base de datos. |
| `GET` | `/courses` | Consulta el catálogo de cursos, con paginación y filtros opcionales. |
| `PUT` | `/skills-gap/input` | Reemplaza la instantánea de habilidades del usuario autenticado. |
| `GET` | `/skills-gap` | Analiza la instantánea frente a un contexto de mercado configurado. |
| `POST` | `/skills-gap/evaluate` | Evalúa cobertura y niveles explícitos por oferta, sin consultar PostgreSQL. |
| `POST` | `/skills-gap/recommendations` | Compara habilidades por oferta y busca cursos para las no documentadas. |

### Análisis de una oferta

`POST /skills-gap/evaluate` recibe una proyección del CV y entre una y veinte ofertas. Por ejemplo:

```json
{
  "cv": {
    "id": "cv-123",
    "skills": [
      { "name": "Python", "level": "intermediate" },
      { "name": "SQL", "level": "advanced" }
    ]
  },
  "jobs": [
    {
      "id": "job-456",
      "skills": ["Python", "SQL", "Docker"],
      "description": "Se requiere Python avanzado y SQL básico.",
      "requirements": ["Docker intermedio"]
    }
  ]
}
```

La respuesta incluye, por oferta, la cobertura de habilidades documentadas, las habilidades no documentadas y el análisis de niveles cuando existe evidencia textual suficiente. Los resultados diferencian las comparaciones concluyentes de los requisitos desconocidos o contradictorios.

Los niveles de CV utilizan la escala ordinal **`cv-skill-v1`**:

| Valor | Nivel |
| --- | --- |
| `beginner` | Principiante |
| `intermediate` | Intermedio |
| `advanced` | Avanzado |
| `expert` | Experto |

Los déficits de nivel se expresan en **pasos ordinales**, no en porcentajes de conocimiento. `documentedCoveragePercent` mide coincidencias entre nombres de habilidades documentadas y exigidas; no mide competencia ni idoneidad para la contratación.

### Recomendaciones y catálogo

`POST /skills-gap/recommendations` recibe una proyección del CV y de las ofertas con identificadores y listas de habilidades. A diferencia de `/skills-gap/evaluate`, **no admite** `description` ni `requirements`. Las recomendaciones se basan en asociaciones explícitas del catálogo con habilidades **no documentadas**; actualmente no garantizan resolver déficits de nivel de habilidades ya declaradas.

`GET /courses` admite los siguientes parámetros opcionales:

| Parámetro | Uso |
| --- | --- |
| `page` | Página solicitada; predeterminada: `1`. |
| `pageSize` | Cursos por página; predeterminados: `20`, máximo: `100`. |
| `platform` | Coincidencia parcial insensible a mayúsculas por plataforma. |
| `skillName` | Coincidencia parcial insensible a mayúsculas por habilidad. |
| `isPaid` | `true` o `false`; si se omite, incluye ambos tipos. |

El catálogo devuelve `items`, `page`, `pageSize` y `totalRecords`. Un resultado vacío no significa que la API haya fallado. Los cursos deben estar registrados y asociados con habilidades en PostgreSQL para aparecer en las consultas correspondientes.

### Instantánea y mercado

`PUT /skills-gap/input` recibe una lista completa de habilidades `{ skillName, level }`, la reemplaza de forma atómica y responde `204 No Content` si se guarda correctamente. El usuario se identifica mediante `X-User-Id` verificado detrás de APIM; el servicio almacena una clave derivada por SHA-256, no el correo, el token ni el CV original.

`GET /skills-gap` utiliza esa instantánea y el contexto configurado en `SKILLS_GAP_MARKET_KEY`. Si aún no existe una instantánea responde `409 SKILLS_INPUT_REQUIRED`; si faltan la configuración o los recursos necesarios, puede responder `503`.

## Requisitos previos

- **Node.js 24** y npm.
- **Docker Engine / Docker Desktop** con Docker Compose para ejecutar PostgreSQL localmente, o una instancia PostgreSQL de desarrollo configurada explícitamente.
- Acceso a las variables de configuración necesarias para cada entorno.

## Ejecución local

1. Clonar el repositorio e instalar las dependencias:

   ```bash
   git clone https://github.com/SoftwareDesignTEC/cvexpert-ms-brecha-cursos.git
   cd cvexpert-ms-brecha-cursos
   npm ci
   ```

2. Crear el archivo de configuración local:

   ```bash
   cp .env.example .env
   ```

   En PowerShell se puede usar `Copy-Item .env.example .env`. Editar `.env` y establecer una **contraseña local propia** en `PGPASSWORD`. No versionar este archivo.

3. Iniciar PostgreSQL y aplicar las migraciones:

   ```bash
   docker compose config --quiet
   docker compose up -d --wait postgres
   npm run db:migrate
   npm run db:check
   ```

   El archivo `compose.yaml` publica PostgreSQL únicamente en `127.0.0.1:5433`; el contenedor utiliza el puerto interno `5432`. Los datos se conservan en un volumen de Docker.

4. Iniciar la API:

   ```bash
   npm run dev
   ```

   El puerto predeterminado es `3000`. Con la configuración local de ejemplo (`NODE_ENV=development` y `APIM_ALLOW_INSECURE_LOCAL=true`), el servidor escucha únicamente en `127.0.0.1`.

5. Comprobar salud y catálogo:

   ```bash
   curl http://127.0.0.1:3000/health
   curl 'http://127.0.0.1:3000/courses?page=1&pageSize=20'
   ```

   La ruta de salud devuelve `{"status":"ok","service":"brecha-cursos"}` cuando el proceso responde. El catálogo puede estar vacío si no se han cargado cursos.

> **Seguridad del entorno local:** el bypass de certificado habilita únicamente el entorno local de desarrollo/pruebas. **No permite ejecutar directamente** `/skills-gap`, `/skills-gap/input`, `/skills-gap/evaluate` o `/skills-gap/recommendations` sin un certificado APIM verificado e identidad válida. Para probar esos flujos sin infraestructura Azure, se utilizan las pruebas automatizadas con el entorno y los certificados de prueba controlados. No se deben falsificar encabezados de identidad en un entorno real.

### Datos de demostración (opcional)

En una **base local de desarrollo**, después de aplicar las migraciones, se puede ejecutar:

```bash
npm run db:seed
npm run db:check
```

El seed contiene datos de demostración, no cursos ni requisitos de mercado verificados. No debe ejecutarse sobre una base de producción.

Para compilar y ejecutar el resultado generado:

```bash
npm run build
npm start
```

## Configuración

Las variables disponibles para la ejecución local se documentan en [`.env.example`](.env.example).

| Variable | Función |
| --- | --- |
| `PORT` | Puerto HTTP, predeterminado `3000`. |
| `NODE_ENV` | Entorno de ejecución. |
| `APIM_ALLOW_INSECURE_LOCAL` | Omite la comprobación del certificado únicamente en desarrollo/pruebas locales permitidas. |
| `APIM_CERT_THUMBPRINTS` | Huellas autorizadas de certificados cliente APIM. |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | Conexión PostgreSQL. |
| `DB_SSL_MODE`, `PGSSLROOTCERT` | Configuración de verificación TLS para PostgreSQL. |
| `SKILLS_GAP_MARKET_KEY` | Contexto de mercado seleccionado por el servidor para `GET /skills-gap`. |

Fuera del entorno local se requiere la configuración de seguridad apropiada. La conexión PostgreSQL productiva exige verificación TLS, y el certificado cliente de APIM debe ser autorizado por el backend.

## Seguridad e integración con APIM

En CVExpert, la web y Android llaman al gateway con su token de Google. APIM valida la autenticación, sobrescribe `X-User-Id` y `X-User-Email`, selecciona este backend y presenta un certificado cliente durante la conexión HTTPS.

En el backend, el middleware valida el certificado reenviado por la infraestructura de Azure. Las rutas `/skills-gap*` comprueban, además, la identidad del usuario. El backend no valida directamente el token de Google ni debe aceptar los encabezados de identidad enviados por un cliente externo sin esa frontera de confianza.

La ruta `/health` se declara antes del middleware de certificado, pero una configuración TLS de Azure que exija certificado puede impedir que una llamada anónima alcance siquiera Express. Que `/health` responda tampoco demuestra disponibilidad de PostgreSQL.

La publicación de operaciones en APIM, los certificados y los datos del entorno deben verificarse por separado del código de la API. Véase [seguridad y preparación de APIM](docs/apim-security.md).

## Base de datos

Las tablas principales son `skills`, `courses`, `course_skills`, `market_requirements` y `user_skill_snapshots`. `course_skills` modela la relación muchos-a-muchos entre cursos y habilidades. Las migraciones incluyen además el registro `admin_import_runs` para el mantenimiento administrativo.

Las migraciones están en [`db/migrations/`](db/migrations/). No se ejecutan automáticamente al iniciar el servidor: deben aplicarse mediante un proceso de mantenimiento autorizado. Las operaciones del catálogo utilizan consultas parametrizadas; los procedimientos de importación se encuentran separados de las rutas HTTP.

## Pruebas

```bash
npm run build
npm test
```

Las pruebas de dominio y HTTP se ejecutan mediante el runner de Node.js. Para las pruebas de integración con PostgreSQL:

```bash
npm run db:test
```

`db:test` requiere un PostgreSQL **local de pruebas**, permisos adecuados para crear bases desechables y, para determinadas pruebas, un rol de aplicación de solo lectura. La preparación y los controles se detallan en [la documentación de PostgreSQL y mantenimiento](docs/catalog-import.md). No debe apuntarse a una base de datos operativa.

La carpeta [`postman/`](postman/) incluye una colección y entornos para comprobaciones HTTP. Las pruebas directas del servicio no equivalen por sí solas a una verificación completa mediante APIM.

## Mantenimiento del catálogo y del mercado

El repositorio contiene herramientas separadas del servidor para revisar e importar información:

| Comando | Propósito |
| --- | --- |
| `npm run db:catalog:import` | Revisar o importar lotes del catálogo, según la configuración y autorización local. |
| `npm run db:market:import` | Revisar o importar requisitos de mercado en un contexto definido. |
| `npm run courses:discover -- --dry-run --fixture` | Ejecutar una demostración reproducible del descubrimiento de cursos con datos de prueba. |
| `npm run db:admin:preview` | Examinar un lote administrativo antes de su aplicación. |

Estas herramientas tienen controles de permisos y procedimientos específicos. Consultar su documentación antes de utilizar opciones de escritura. El descubrimiento con fuentes externas **no publica automáticamente los resultados** en la base de datos: los candidatos requieren revisión.

La actualización automática periódica del catálogo y la publicación del evento `course.recommended` hacia Azure Service Bus **no están integradas como funcionalidades productivas** en este repositorio.

## CI/CD

El workflow [`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml) verifica el proyecto en las ramas `develop` y `main`, ejecutando compilación, pruebas y controles del paquete de producción según los archivos modificados.

El despliegue en Azure App Service requiere habilitación explícita mediante `ENABLE_AZURE_DEPLOY` y configuración autorizada del entorno. Una ejecución correcta de CI no confirma por sí sola que una revisión esté desplegada o que se haya probado todo el flujo de APIM a PostgreSQL.

## Documentación adicional

- [Contrato OpenAPI](openapi.yaml): operaciones, parámetros, ejemplos y respuestas.
- [Análisis de brechas por oferta](docs/job-specific-skills-gap.md): cobertura y recomendaciones contextualizadas.
- [Extracción y comparación de niveles](docs/job-required-skill-levels.md): reglas, evidencia y casos no concluyentes.
- [Análisis frente al mercado](docs/skills-gap-http.md): instantáneas, resultados y errores.
- [Seguridad y certificado APIM](docs/apim-security.md): frontera de confianza y configuración.
- [Catálogo e importaciones](docs/catalog-import.md): estructura, validaciones y mantenimiento.
- [Importación de requisitos de mercado](docs/market-import.md): contexto y revisión de fuentes.
- [Descubrimiento de cursos](docs/course-discovery.md): proveedores, candidatos y límites de automatización.
- [Pruebas con Postman](postman/README.md): colección, entornos y escenarios.

---

**CVExpert — Proyecto de Diseño de Software.**
