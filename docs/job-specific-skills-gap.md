# Análisis de habilidades por oferta laboral

`POST /skills-gap/evaluate` compara las habilidades declaradas en un CV con las habilidades identificadas en una o más ofertas. El backend implementa la operación. Quedan pendientes su publicación en APIM y la integración con Android y Web.

## Flujo de datos

1. Android o Web consulta `GET /cvs/{id}` a través de APIM y toma `id` y los campos `name` y `level` de cada elemento de `skills`. [Contrato de CVs](https://github.com/SoftwareDesignTEC/cvexpert-ms-cvs/blob/main/docs/openapi.yaml)
2. El cliente toma `id` y `skills` de cada oferta devuelta por `GET /jobs` o `GET /jobs/{id}` a través de APIM. Si la respuesta omite `skills`, el cliente envía `[]`. Para evaluación puede agregar opcionalmente `description` y `requirements`; `matchScore` queda fuera de la proyección. [Contrato de Ofertas](https://github.com/SoftwareDesignTEC/cvexpert-ms-ofertas-postulaciones/blob/main/docs/openapi.yaml)
3. El cliente envía las proyecciones como JSON al nuevo endpoint a través de APIM. Cada resultado conserva el ID de la oferta para que el cliente pueda asociarlo con la que seleccionó.

En Android, `CvDto` y `SkillDto` ya exponen los campos del CV. `JobOfferDto` incluye `skills: List<String>?` y `JobOfferMapper` conserva las habilidades en el modelo de dominio. Queda pendiente definir los DTO de solicitud y respuesta de la evaluación, componer la solicitud con las proyecciones del CV y las ofertas, llamar a `POST /skills-gap/evaluate` y presentar el resultado distinguiendo la información insuficiente del 0 % de cobertura. [DTO de ofertas en Android](https://github.com/SoftwareDesignTEC/cvexpert-mobile/blob/main/app/src/main/java/com/cvpro/app/data/remote/dto/JobOfferDto.kt) · [Mapeador de ofertas en Android](https://github.com/SoftwareDesignTEC/cvexpert-mobile/blob/main/app/src/main/java/com/cvpro/app/data/mapper/JobOfferMapper.kt)

## Solicitud y respuesta

Ejemplo de cuerpo para `POST /skills-gap/evaluate` con `Content-Type: application/json`.

```json
{
  "cv": {
    "id": "123",
    "skills": [
      { "name": "Python", "level": "advanced" },
      { "name": "SQL", "level": "intermediate" }
    ]
  },
  "jobs": [
    { "id": "456", "skills": ["Python", "SQL", "Docker"] },
    { "id": "789", "skills": [] }
  ]
}
```

Respuesta `200 OK`.

```json
{
  "cvId": "123",
  "dataSource": "client_request",
  "results": [
    {
      "jobId": "456",
      "status": "partial",
      "requiredSkillsCount": 3,
      "documentedMatchesCount": 2,
      "documentedCoveragePercent": 66.67,
      "matchedSkills": [
        { "name": "Python", "cvLevel": "advanced" },
        { "name": "SQL", "cvLevel": "intermediate" }
      ],
      "notDocumentedSkills": ["Docker"]
    },
    {
      "jobId": "789",
      "status": "insufficient_information",
      "requiredSkillsCount": 0,
      "documentedMatchesCount": 0,
      "documentedCoveragePercent": null,
      "matchedSkills": [],
      "notDocumentedSkills": []
    }
  ]
}
```

| Clasificación | Significado |
| --- | --- |
| `complete` | La oferta contiene habilidades identificables y todos sus nombres figuran en el CV enviado. |
| `partial` | Al menos un nombre de la oferta está ausente del CV enviado. Incluye 0 % de cobertura si el CV viene vacío o si no hay coincidencias. |
| `insufficient_information` | La oferta carece de habilidades identificables. La cobertura es `null`. |

La cobertura divide las coincidencias por el número de habilidades únicas identificadas en la oferta, multiplica por 100 y redondea a dos decimales. `cvLevel` conserva el nivel declarado. La cobertura se limita a coincidencias de nombres. El análisis opcional de niveles explícitos se documenta en [Niveles requeridos por oferta](job-required-skill-levels.md) y no altera esa cobertura. `notDocumentedSkills` señala ausencias en la proyección. `dataSource: client_request` identifica datos aportados por el cliente y sin verificación independiente de contenido o titularidad. El resultado es informativo y queda fuera de decisiones de autorización, contratación y certificación.

El límite es de 1 a 20 ofertas, 500 habilidades en el CV y 200 por oferta, contadas antes de deduplicar. Cada ID y nombre admite hasta 200 caracteres Unicode y el cuerpo hasta 100 KiB. Los IDs se conservan literalmente y se rechazan IDs de oferta repetidos. Los nombres se comparan tras normalizar espacios, mayúsculas y acentos latinos agudos, graves, circunflejos y diéresis. Se preservan la ñ y la puntuación, por lo que Java y JavaScript, así como C y C++, permanecen diferenciados. Se omiten nombres de oferta vacíos. Se agrupan repeticiones normalizadas y se rechazan niveles contradictorios en el CV. La respuesta conserva el orden de las ofertas y, dentro de cada lista de habilidades, el orden y la primera grafía de la oferta con espacios normalizados.

## Seguridad y publicación

APIM deberá publicar el POST y dirigirlo a `/skills-gap/evaluate` en el backend. La política deberá autenticar al usuario, sobrescribir `X-User-Id` con la identidad autenticada y presentar el certificado cliente durante mTLS con App Service. El backend exige un certificado autorizado y un único encabezado válido de identidad. La ruta aplica `Cache-Control: no-store` y rechaza parámetros de consulta y campos adicionales, incluido `userId`. Los errores JSON usan `error` y `message`. Los estados son 400 para entrada inválida, 401 para identidad inválida, 403 para certificado rechazado, 413 para cuerpo excesivo y 503 si falta la configuración de seguridad.

## Recomendaciones por oferta

`POST /skills-gap/recommendations` acepta el JSON original (`cv`, `jobs[].id` y `jobs[].skills`) y sus límites; los nuevos campos textuales son exclusivos de evaluación. Conserva sus resultados por oferta y agrega una recomendación por cada habilidad de `notDocumentedSkills`. La pertinencia depende de la asociación explícita en `course_skills`. Un curso puede aparecer en varias habilidades u ofertas. Cada lista devuelve hasta cinco cursos distintos por ID numérico ascendente. El orden corresponde al ID del catálogo. `durationHours: null` conserva una duración desconocida.

| Resultado | Significado |
| --- | --- |
| `catalogStatus: not_needed` | Ninguna oferta tiene habilidades no documentadas. El catálogo queda sin consultar y todas las recomendaciones están vacías. |
| `catalogStatus: consulted`, `catalogMatch: matched` | El catálogo respondió y se identificó un nombre único. `courses: []` indica que ese nombre carece de cursos elegibles. |
| `catalogStatus: consulted`, `catalogMatch: not_found` | El nombre no figura en el catálogo. La lista de cursos está vacía. |
| `catalogStatus: consulted`, `catalogMatch: ambiguous` | Varios nombres del catálogo comparten la misma clave normalizada. La lista de cursos está vacía. |
| `503 CATALOG_UNAVAILABLE` | Falló una consulta necesaria. El evaluador puro `POST /skills-gap/evaluate` sigue disponible. |

Ejemplo de respuesta para una oferta que pide Python y Docker, con solo Python declarado en el CV. El curso es un fixture ficticio de la base desechable de pruebas.

```json
{
  "cvId": "123",
  "dataSource": "client_request",
  "catalogStatus": "consulted",
  "results": [{
    "jobId": "456",
    "status": "partial",
    "requiredSkillsCount": 2,
    "documentedMatchesCount": 1,
    "documentedCoveragePercent": 50,
    "matchedSkills": [{ "name": "Python", "cvLevel": "advanced" }],
    "notDocumentedSkills": ["Docker"],
    "recommendations": [{
      "skillName": "Docker",
      "catalogMatch": "matched",
      "courses": [{
        "id": "20",
        "title": "Contenedores y consultas",
        "platform": "Catálogo local",
        "url": "https://fixture.catalog.local/20",
        "logoUrl": null,
        "durationHours": null,
        "isPaid": false,
        "skills": ["Docker", "SQL"]
      }]
    }]
  }]
}
```

PostgreSQL ejecuta hasta dos lecturas por solicitud en una transacción de solo lectura con aislamiento `REPEATABLE READ`. La primera lee únicamente ID y nombre de `skills` y usa el normalizador del evaluador para resolver las claves solicitadas y detectar colisiones. La segunda recibe los IDs inequívocos como un parámetro de tipo arreglo y aplica el límite por habilidad con el índice de `course_skills`. El coste de la primera lectura crece con el número de nombres del catálogo. La segunda acota los cursos recuperados y devuelve sus habilidades asociadas.

La consulta excluye marcadores `[DEMO]` y `[TEST]` sin distinguir mayúsculas en los datos del curso y las habilidades asociadas. También excluye enlaces de los dominios reservados `example.com`, `example.net` y `example.org`, incluidos sus subdominios. El esquema del catálogo no conserva toda la evidencia editorial del importador, por lo que la respuesta expresa asociaciones registradas, sin verificación de procedencia, vigencia o calidad.

La operación reutiliza la seguridad y los errores de entrada de la evaluación. Quedan pendientes publicar la nueva ruta en APIM e integrar Android y Web. Las recomendaciones son informativas y quedan fuera de decisiones de contratación y autorización.
