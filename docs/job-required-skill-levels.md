# Niveles requeridos por oferta

La extensión de POST /skills-gap/evaluate es aditiva. El cliente puede proyectar description y requirements desde las ofertas que ya obtiene por APIM. Brecha no consulta otros microservicios, JSearch ni sitios externos. No cambia Android, Web ni la configuración de APIM.

Cada oferta con al menos uno de esos campos, incluso vacío, incorpora skillLevelAssessments y levelAnalysis. Una oferta sin esos campos conserva exactamente la respuesta anterior. Los contadores, listas, status y porcentaje de cobertura documental siguen comparando nombres. Un 100 % de cobertura puede coexistir con déficits de nivel; no es porcentaje de conocimiento ni cumplimiento de competencias.

## Contrato

- description: string opcional, máximo 20 000 puntos de código Unicode.
- requirements: string[] opcional, hasta 100 elementos de máximo 2 000 puntos de código cada uno.
- Se conserva skills: string[], entre 1 y 20 ofertas, hasta 200 habilidades por oferta y 500 del CV, antes de deduplicar. Todo el JSON sigue limitado a 100 KiB en HTTP, aunque cada campo quepa individualmente.
- No se admite null ni tipos alternativos para texto; se rechazan propiedades desconocidas. Se admiten Unicode válido, tabulaciones y saltos de línea. Se rechazan controles restantes y sustitutos Unicode aislados en los nuevos campos. Los errores no reflejan el texto de entrada.
- La identidad y el certificado autorizado de APIM siguen siendo obligatorios. Cache-Control sigue siendo no-store.

Cada evaluación por habilidad contiene name, cvLevel, requiredLevel, evidenceSource, evidenceText, detectionStatus, reason, status y deficitSteps. evidenceSource es description o requirements solo para detecciones explicit; evidenceText es un fragmento literal de hasta 300 unidades UTF-16 (y como máximo 300 puntos de código). En unknown o conflict, nivel requerido y evidencia son null.

| status | Interpretación |
| --- | --- |
| documented_skill_below_required | Nivel declarado inferior al requerido explícito. |
| documented_skill_meets_required | Nivel declarado igual o superior al requerido explícito. |
| not_documented | Nombre ausente en la proyección del CV. cvLevel y deficitSteps son null; no prueba que la persona carezca de la habilidad. |
| unknown_required_level | Habilidad documentada sin nivel obligatorio inequívoco. |

cv-skill-v1 ordena beginner=1, intermediate=2, advanced=3, expert=4. deficitSteps es max(0, requerido menos CV), únicamente para pares evaluables; en los demás casos es null. El contrato vigente exige un nivel válido para cada habilidad del CV y rechaza null, por lo que no se añade unknown_cv_level.

levelAnalysis contiene scale, comparedSkillsCount, belowRequiredCount, meetsRequiredCount, notDocumentedCount, unknownRequiredLevelCount y conflictCount. Los cuatro conteos de status particionan las habilidades; comparedSkillsCount suma belowRequiredCount y meetsRequiredCount. conflictCount cuenta detecciones conflict y puede solaparse con notDocumentedCount o unknownRequiredLevelCount.

## Extracción y límites

El módulo puro src/domain/job-required-skill-levels.ts solo examina las habilidades conocidas de jobs[].skills. Normaliza espacios, mayúsculas y los acentos que ya normalizaba el evaluador, preservando ñ y puntuación. Usa límites de tecnología para distinguir Java de JavaScript y C de C++. Reconoce vocabulario básico/principiante/inicial/basic/beginner/foundational, intermedio/intermediate, avanzado/advanced y experto/expert, incluidas formas femeninas y plurales españolas comunes. Acepta adyacencia y conectores acotados como Python nivel avanzado o advanced proficiency in Python.

Se separan frases, líneas, punto y coma, comas y conjunciones y/and/pero/but. El nivel debe estar asociado por la gramática local a la habilidad; no se copia un adjetivo de otra cláusula. Las negaciones y preferencias se consideran conservadoramente en toda la frase o línea para no perder calificadores después de una coma o conjunción. Los encabezados terminados en dos puntos que expresen opcionalidad o negación se aplican a las líneas siguientes del mismo campo hasta otro encabezado. Este alcance conservador puede dejar sin resolver una habilidad obligatoria situada junto a otra opcional. No se heredan calificadores entre elementos de requirements.

Sin evidencia: unknown/no_explicit_evidence. Evidencia solo deseable: unknown/optional. Evidencia negada: conflict/negated. Distintos niveles explícitos en description y/o requirements: conflict/contradictory. Varios niveles en la misma cláusula: conflict/ambiguous. Nunca se elige un máximo para resolver conflictos. Si hay una exigencia explícita y otra mención opcional, se usa la exigencia; las menciones negadas o ambiguas fuerzan conflicto. Con varias evidencias del mismo nivel se devuelve la primera, recorriendo primero description y después requirements en orden.

No se deducen niveles de años de experiencia, seniority o títulos del puesto. Tampoco se resuelven sinónimos de tecnologías, pronombres, niveles compartidos en listas, HTML ni lenguaje arbitrario. Una cláusula de más de 300 unidades UTF-16 se ignora para evitar atribuir evidencia truncada. Una habilidad desconocida para skills no se añade por aparecer en el texto. Las reglas pueden producir falsos negativos y no constituyen comprensión general del lenguaje. No se ha medido precisión estadística.

El texto se procesa como datos mediante reglas fijas; no se ejecuta ni se envía a un modelo o servicio externo. La evidencia conserva texto no confiable: los clientes deberán presentarla como texto, sin interpretar HTML.

POST /skills-gap/recommendations conserva su contrato anterior y rechaza description/requirements. Solo recomienda por habilidades no documentadas, con las mismas consultas existentes. selectDocumentedLevelDeficits exporta una selección pura para una integración posterior de déficits de nivel. Esta entrega no conecta esa selección al catálogo ni añade SQL. Tampoco cambia GET /skills-gap, PUT /skills-gap/input, GET /courses ni persistencia de mercado.

## Ejemplo ejecutado con datos de prueba

Solicitud:

```json
{
  "cv": {
    "id": "cv:test",
    "skills": [
      {
        "name": "Python",
        "level": "intermediate"
      },
      {
        "name": "SQL",
        "level": "advanced"
      }
    ]
  },
  "jobs": [
    {
      "id": "job:test",
      "skills": [
        "Python",
        "SQL",
        "Docker"
      ],
      "description": "Python avanzado y SQL básico.",
      "requirements": [
        "Docker intermediate"
      ]
    }
  ]
}
```

Respuesta obtenida de `evaluateJobSkillsGap` y verificada por HTTP en las pruebas:

```json
{
  "cvId": "cv:test",
  "dataSource": "client_request",
  "results": [
    {
      "jobId": "job:test",
      "status": "partial",
      "requiredSkillsCount": 3,
      "documentedMatchesCount": 2,
      "documentedCoveragePercent": 66.67,
      "matchedSkills": [
        {
          "name": "Python",
          "cvLevel": "intermediate"
        },
        {
          "name": "SQL",
          "cvLevel": "advanced"
        }
      ],
      "notDocumentedSkills": [
        "Docker"
      ],
      "skillLevelAssessments": [
        {
          "name": "Python",
          "cvLevel": "intermediate",
          "requiredLevel": "advanced",
          "evidenceSource": "description",
          "evidenceText": "Python avanzado",
          "detectionStatus": "explicit",
          "reason": null,
          "status": "documented_skill_below_required",
          "deficitSteps": 1
        },
        {
          "name": "SQL",
          "cvLevel": "advanced",
          "requiredLevel": "beginner",
          "evidenceSource": "description",
          "evidenceText": "SQL básico",
          "detectionStatus": "explicit",
          "reason": null,
          "status": "documented_skill_meets_required",
          "deficitSteps": 0
        },
        {
          "name": "Docker",
          "cvLevel": null,
          "requiredLevel": "intermediate",
          "evidenceSource": "requirements",
          "evidenceText": "Docker intermediate",
          "detectionStatus": "explicit",
          "reason": null,
          "status": "not_documented",
          "deficitSteps": null
        }
      ],
      "levelAnalysis": {
        "scale": "cv-skill-v1",
        "comparedSkillsCount": 2,
        "belowRequiredCount": 1,
        "meetsRequiredCount": 1,
        "notDocumentedCount": 1,
        "unknownRequiredLevelCount": 0,
        "conflictCount": 0
      }
    }
  ]
}
```

## Archivos y verificación de esta entrega

- src/domain/job-required-skill-levels.ts: extractor, comparación ordinal, resumen y selector puro reutilizable.
- src/domain/cv-skill-v1.ts: acceso al ordinal de la escala existente.
- src/adapters/job-skills-gap-input.ts y src/services/job-skills-gap.service.ts: campos textuales validados y respuesta aditiva por oferta.
- src/services/job-course-recommendations.service.ts: conserva el contrato cerrado anterior al reutilizar el evaluador.
- test/job-required-skill-levels.test.ts: casos de dominio, compatibilidad, validación y HTTP con repositorios que fallan si se usan.
- test/documentation.test.ts y test/fixtures/job-required-skill-levels.json: ejemplos ejecutables y límites contractuales.
- openapi.yaml, docs/job-specific-skills-gap.md y este documento: contrato y limitaciones.

Base inspeccionada: origin/develop en 3ef43f3, sincronizada mediante git fetch origin develop. Rama aislada feat/job-required-skill-levels en .worktrees/job-required-skill-levels. No se modificaron archivos de recolección, importadores, migraciones, catálogo administrativo ni archivos ajenos sin seguimiento del checkout principal.

Comandos ejecutados:

- npm run build: correcto (TypeScript de aplicación y mantenimiento).
- npm test: ejecución final correcta, 72 pruebas aprobadas y ninguna omitida. Incluye las pruebas anteriores de evaluate, recommendations y seguridad APIM.
- node --import tsx --test test/job-required-skill-levels.test.ts test/job-skills-gap.test.ts test/job-course-recommendations.test.ts test/documentation.test.ts: 19 pruebas aprobadas en la ejecución intermedia; la suite completa final incluye los casos posteriores.
- git diff --check: correcto.

El sandbox bloqueó inicialmente los sockets de loopback con EACCES; las pruebas HTTP se ejecutaron después con permiso para conexiones locales. Una primera suite completa tuvo 70/71 aprobadas por un puerto efímero que fetch rechazó con bad port en un fixture de seguridad preexistente. Dos ejecuciones completas posteriores aprobaron 72/72, con el caso documental adicional incluido.

No se ejecutó npm run db:test ni se verificó una base PostgreSQL real. No se desplegó ni verificó Azure/APIM real. Los certificados APIM se ejercitaron con fixtures locales. No se modificaron dependencias, secretos ni workflows.
