# OpenLearn — Fase 2B y consulta pública controlada

Fecha de revisión: **15 de noviembre de 2026**. Rama
`codex/course-sync-openlearn-phase2b`, worktree limpio desde `origin/develop`
`a428da7`, merge del PR #28. Se preservaron los archivos preparados y demás
worktrees del usuario. No se modificaron Saylor, Express, migraciones o CI.

Hay tres estados distintos: **fixtures probados**, **consulta real de metadatos
comprobada** y **sincronización periódica no aprobada**. No hay publicación ni
persistencia. `plan.next` sigue siendo staging simulado y nunca debe persistirse
directamente en el catálogo publicado sin política y procedimiento de aprobación.

## Fuentes, permiso de consulta y atribución

| Fuente oficial consultada | Hallazgo |
| --- | --- |
| [Portal de datos](https://data.open.ac.uk/) | Ofrece datos institucionales para reutilización; el endpoint combina grafos si no se especifica uno |
| [Datasets](https://data.open.ac.uk/datasets) | Identifica OpenLearn con `http://data.open.ac.uk/context/openlearn2`, licencia CC BY 3.0 y unidades educativas que pueden corresponder a materiales de cursos |
| [Protocolo y formatos](https://data.open.ac.uk/howto) | Documenta acceso público de solo lectura, SELECT y negociación `application/sparql-results+json` |
| [Endpoint](https://data.open.ac.uk/sparql) | Respondió a las consultas limitadas descritas abajo, sin credenciales |
| [Ejemplos históricos](https://data.open.ac.uk/queries) | Usan `context/openlearn` y `OpenLearnUnit`; no se asumen equivalentes al grafo/tipo comprobados ahora |
| [Catálogo público](https://www.open.edu/openlearn/free-courses/full-catalogue) | Presenta cursos gratuitos de varias disciplinas, filtros de nivel/idioma y duración; no acredita exhaustividad del grafo RDF |
| [FAQ de feeds](https://www.open.edu/openlearn/get-started/frequently-asked-questions/can-i-take-feed-openlearn-content) | Distingue feeds de cursos de artículos e interactivos. No se implementó un feed alternativo ni un scraper |
| [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | Requiere atribución aplicable, enlace a la licencia y observancia de sus condiciones; no debe sugerirse respaldo del licenciante |

La disponibilidad pública por sí sola no autoriza cualquier extracción. Esta
consulta de metadatos se apoyó en el acceso de solo lectura y licencia expresamente
documentados, con autorización del usuario y límites muy pequeños. No se encontró
una cuota numérica o frecuencia diaria garantizada en las páginas revisadas. Eso
queda pendiente; no se presenta una consulta exitosa como aprobación para un job.

Los informes incluyen atribución a **The Open University**, nombre del dataset,
fuente, licencia y declaración de transformación/selección sin respaldo implícito.
Al publicar en una fase futura, deben conservarse avisos aplicables, título y
procedencia junto al registro, y revisar la atribución visible y derechos adicionales.

La licencia del dataset no se extrapola a lecciones, imágenes o materiales de
terceros. Las páginas de cursos consultadas muestran avisos propios y excepciones
para terceros. No se descargaron lecciones, documentos, imágenes ni paquetes
educativos; solo se revisaron páginas descriptivas y metadatos.

## Comprobación real y esquema

Se hicieron **cuatro solicitudes SPARQL**, cada una con SELECT, `LIMIT 10`, HTTPS,
timeout de 15 segundos y máximo de 256 KiB. No hubo paginación, reintentos,
recorrido exhaustivo ni consultas a `context/course` o al grafo histórico.

| Hora UTC | Propósito y resultado |
| --- | --- |
| 21:45:28 | Muestra de 10 triples de metadatos en `openlearn2`: HTTP 200, JSON, 2709 bytes. Incluía About OpenLearn, Donate y FAQs; un título no prueba que sea un curso |
| 21:45:57 | Hasta 10 nombres de propiedades: HTTP 200, 984 bytes; confirmó `internalID`, `primaryTerm` y `http://dbpedia.org/property/url`, entre otras |
| 21:46:51 | Hasta 10 filas con título/URL/ID/tipo: HTTP 200, 5382 bytes; confirmó tipo `OpenCourseware` y enlaces HTTPS y HTTP históricos |
| 21:54:54 | **Comando final `courses:openlearn:probe -- --live`**: HTTP 200, JSON SPARQL, 5864 bytes; 10 filas válidas, 9 identidades y un duplicado por categorías múltiples |

Hash SHA-256 de la respuesta final:
`94c793cdfed14c3bf46640e45d8b29d29f7e13fbb259c99147da9f2a8306ca65`.
La respuesta no se convirtió en fixture ni se guardó como lote de importación.
Su hash puede variar al repetir la consulta, incluido el tiempo interno del servidor.

El grafo `openlearn2` estaba activo en estas consultas. No se demuestra que sea
una réplica completa o actualizada del catálogo. La consulta final está definida
literalmente en `scripts/course-discovery/openlearn-provider.ts` y usa exclusivamente:

```sparql
SELECT ?resource ?type ?title ?url ?internalId ?subject
FROM <http://data.open.ac.uk/context/openlearn2>
WHERE {
  VALUES ?type { <http://data.open.ac.uk/openlearn/ontology/OpenCourseware> }
  ?resource a ?type ; <http://purl.org/dc/terms/title> ?title ; <http://dbpedia.org/property/url> ?url .
  FILTER(STRSTARTS(STR(?url), "https://www.open.edu/openlearn/") && STRENDS(STR(?url), "/content-section-0"))
  OPTIONAL { ?resource <http://data.open.ac.uk/openlearn/ontology/internalID> ?internalId }
  OPTIONAL { ?resource <http://data.open.ac.uk/openlearn/ontology/primaryTerm> ?subject }
}
ORDER BY ?resource
LIMIT 10
```

No se acepta SPARQL, límite, offset, endpoint o grafo enviados por el usuario. El
contexto `skill` del puerto existente no se interpola en la consulta ni se convierte
en una habilidad. No hay fallback al dataset de cursos universitarios formales,
que puede describir ofertas con pago.

## Muestra real y contraste público

Ejemplos de metadatos de la respuesta final, atribuidos a The Open University,
[OpenLearn metadata](https://data.open.ac.uk/datasets), [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/):

| ID interno | Título y URL recibidos | Categoría recibida |
| --- | --- | --- |
| `1256612` | [Climate justice for the next generation](https://www.open.edu/openlearn/education-development/climate-justice-the-next-generation/content-section-0) | Education & Development |
| `1586133` | [Beginners’ Chinese: a taster course](https://www.open.edu/openlearn/languages/beginners-chinese-taster-course/content-section-0) | Languages |
| `29681` | [The Beveridge vision](https://www.open.edu/openlearn/health-sports-psychology/health/nursing/the-beveridge-vision/content-section-0) | Dos filas: Healthcare Careers y Nursing |

Se abrieron manualmente las páginas descriptivas de los dos primeros ejemplos:
ambas respondieron con el mismo título y señal de curso gratuito. La primera
muestra 7 horas y nivel 2; la segunda 4 horas y nivel 1. No se siguieron enlaces
de lecciones o descargas. Esto verifica esas dos páginas, no todos los enlaces.
Un enlace HTTP histórico de otra muestra no resultó accesible mediante la herramienta
de investigación; no se toma como retirada ni se intenta corregir automáticamente.

La página inicial del catálogo mostró 952 resultados y áreas diversas. Los dos
títulos contrastados no aparecían en el fragmento de resultados inicial revisado;
su publicación se comprobó en sus páginas propias. No se recorrió la paginación
para probar pertenencia a todo el catálogo. El grafo y el catálogo son fuentes de
alcance diferente: no deben compararse sus conteos como si fueran equivalentes.

## Modelo, transformación y límites semánticos

`OpenLearnProvider` implementa `CourseDiscoveryProvider<CourseTopic>` con proveedor
`openlearn`. La forma JSON comprobada incluye `head.vars`, `results.bindings` y
`meta` con tamaño y tiempo. Cada binding se valida por nombre y tipo RDF.

- **Identidad:** se conserva `internalID` literal numérico cuando existe. Si falta,
  se conserva el IRI original del recurso como ID externo; no se inventa un ID.
  El IRI HTTP es un identificador, nunca un destino descargado. Un cambio de URL
  con el mismo ID conserva el ID interno del catálogo. La aparición posterior de
  un ID en un registro antes identificado por IRI requiere revisión, no fusión implícita.
- **Tipo y URL:** se exige `OpenCourseware` y URL directa HTTPS bajo
  `www.open.edu/openlearn/.../content-section-0`. Un título sin tipo, artículo,
  host ajeno o ruta indirecta se rechaza. No se construye la URL desde el IRI ni se
  transforma HTTP a HTTPS. Esta política excluye enlaces heredados y puede excluir
  otros cursos legítimos: no es una clasificación exhaustiva.
- **Áreas y habilidades:** `primaryTerm` se conserva en `evidence.subjects`, separado
  de `associatedSkills=[]`. Una categoría temática no acredita competencias.
- **Idioma/duración/nivel:** el contrato consultado y verificado no trae estos
  campos. No se afirma que jamás existan otras propiedades RDF: no se verificó su
  semántica. Quedan `language=null`, `durationMinutes=null`, `levels=[]`. El idioma
  de un literal de título no es evidencia del idioma docente. Las horas/niveles
  vistos manualmente en dos páginas no se convierten en extracción HTML ni se
  extrapolan a otras filas.
- **Precio/modalidad/disponibilidad:** `isPaid=null`, modalidad y disponibilidad
  desconocidas. Aunque dos páginas se verificaron como cursos gratuitos, no hay
  confirmación individual automatizada de la vigencia/gratuidad de todas las filas;
  el adaptador no asigna false a partir de un título o de la licencia del dataset.
- **Evidencia:** endpoint fijo sin secretos, hash, título, URL recibida, categorías
  y fecha de inicio de la consulta. No se incorpora texto educativo completo.

Todas las observaciones quedan `needs_review`, con revisión de vigencia, coste y
habilidades pendiente. `OpenCourseware` es una señal de tipo, no una garantía de
curso publicado hoy. Las nueve inserciones reales son propuestas de staging, no
cursos verificados para publicar. El ID `29681` se consolidó como duplicado, reteniendo
la evidencia de ambas categorías mediante el motor existente.

## Comando, seguridad e integración

Desde el worktree OpenLearn, con Node 24 y dependencias existentes:

```sh
# Predeterminado offline, sintético y determinista.
npm run courses:openlearn:probe

# Una consulta pública real explícita, solo local, máximo 10 filas y una petición.
npm run courses:openlearn:probe -- --live
```

El comando real ya se ejecutó **una vez** en esta entrega; no hace falta repetirlo
para ejecutar pruebas. No está aprobado invocarlo diaria o automáticamente.
`--fixture` y `--dry-run` son compatibles; `--fixture --live`, `--query`, `--limit`,
`--endpoint`, opciones repetidas y `--apply` se rechazan. Live se bloquea en
tests/CI, producción y contexto App Service. No se cargan `.env`, cookies, tokens
ni credenciales. En fixture no existe fetch global predeterminado.

El transporte es inyectable para pruebas. El modo real usa GET al único endpoint
HTTPS fijo, `credentials=omit`, negociación estricta JSON SPARQL y `redirect=error`.
Se rechazan 3xx, redirecciones y URL efectiva diferente. Timeout máximo 15 segundos,
256 KiB y 10 bindings; sobrepasarlos rechaza el resultado, sin recortarlo silenciosamente.
También se rechazan UTF-8/JSON inválidos, esquema desconocido, HTTP 206, avisos de
truncamiento y conteos incompatibles. Un resultado corto tampoco acredita cobertura.

Hay una reserva síncrona de **un intento por instancia**, incluso ante concurrencia.
401/403 producen error seguro; 429 conserva Retry-After saneado (un minuto a un día),
5xx exige al menos cinco minutos. No hay reintento ni segunda petición; solo se
informa la espera para revisión del operador. Nuevas invocaciones son procesos
independientes: no existe cuota global durable y no se promete coordinación entre
comandos. Eso bloquea usar esta composición como sincronización periódica.

`scripts/probe-openlearn.ts` reutiliza `planDiscoveryQuery` y, por él, `fromDiscovery`
y `reconcile`, sin cambiar el núcleo. Se usa siempre `scope=query`, resultados
marcados como incompletos (`truncated=true`) y `absenceEligible=false`. La respuesta
vacía o un fallo no incrementan ausencias, no retiran cursos ni afectan otra fuente.
Se registra una fecha común de inicio para observación/ejecución. El reporte distingue
fallo, finalización y finalización con rechazos; nunca presenta un error como acceso
verificado. No hay store de disco ni interfaces de escritura. La salida solo va a stdout.

## Fixtures, pruebas y resultados

Los fixtures son sintéticos TEST y no capturas ni páginas copiadas. Usan IRIs y
enlaces inventados solo para pruebas, rotulados TEST; el adaptador real, en cambio,
solo conserva identificadores y URLs que recibió. La demo incluye cinco disciplinas,
un duplicado, un artículo y una URL inválida. Resultado: 8 filas, 6 aceptadas, 2
rechazadas, 4 inserciones propuestas, una actualización y un duplicado. Conserva
otro proveedor y la publicación anterior; no habilita bajas.

| Comando ejecutado | Resultado |
| --- | --- |
| `git fetch origin develop`; `git -c branch.autoSetupMerge=false worktree add -b codex/course-sync-openlearn-phase2b .worktrees/course-sync-openlearn-phase2b origin/develop` | PR #28 incorporado y trabajo aislado desde `a428da7` |
| `npm run build` | Aprobado |
| `node --import tsx --test test/openlearn-provider.test.ts` | 19/19 aprobadas |
| `node --import tsx --test test/openlearn-provider.test.ts test/course-sync.test.ts test/saylor-provider.test.ts` | 57/57 aprobadas, incluidas regresiones de Saylor y núcleo |
| `npm test` | 147/148 aprobadas; persiste el fallo documental preexistente por CRLF en `test/documentation.test.ts:78` |
| `npm run courses:openlearn:probe` | Fixture completado con los dos rechazos esperados |
| `npm run courses:openlearn:probe -- --live` | Una solicitud: HTTP 200, 10 filas, 9 identidades, 9 propuestas revisables; sin escrituras |
| `git diff --check` | Sin errores |
| `docker info --format '{{.ServerVersion}}'` | Motor Docker Linux no disponible; no hay PostgreSQL desechable verificado |
| `npm run db:test` | No ejecutado; no se utiliza una base real o compartida |

La suite completa se ejecutó fuera de la restricción de loopback del sandbox,
capturada con `npm test 2>&1 | Select-Object -Last 44`. La consulta real se resumió
con `ConvertFrom-Json` y `Select-Object`; no se guardó respuesta en disco.
Se realizaron además lecturas `Get-Content`, búsquedas `rg`, verificaciones
`git status/log/diff/worktree list` y tres SELECT de diagnóstico descritos arriba.

Los tests no necesitan credenciales ni red. La prueba de modo live usa transporte
simulado, y la de CLI predeterminada se ejecuta bajo permisos Node sin red, escrituras,
workers ni procesos hijos. Cubren esquema/términos RDF, identidad, múltiples áreas,
desconocidos, duplicados, cambios, errores HTTP, límites, timeout, cobertura parcial,
no asociación de habilidades, protección de fuentes y ausencia de desactivaciones.

## Archivos y próximos pasos

Nuevos: `scripts/course-discovery/openlearn-provider.ts`, `scripts/probe-openlearn.ts`,
`test/fixtures/openlearn.test.ts`, `test/openlearn-provider.test.ts` y esta guía.
Modificados: `package.json` para registrar el comando y la guía general para enlazar
esta fase. Sin dependencias nuevas ni cambios en Saylor, REST, PostgreSQL, migraciones,
Azure, APIM, Android/web, Actions o infraestructura.

La consulta real es viable como muestra pública acotada; la sincronización diaria
**no está aprobada ni lista**. Faltan frecuencia/cuotas acordadas, vigencia y alcance
del dataset, política para enlaces HTTP y recursos que no son cursos actuales,
semántica de idioma/duración/nivel, revisión editorial de habilidades y gratuidad,
atribución visible, retención, coordinación global y observabilidad. La exclusión
de URLs históricas sesga la muestra: nunca puede usarse para inferir ausencias.

Antes de publicar: aprobar staging durable, migraciones aditivas, propiedad de
registros, checkpoints/versionado/concurrencia, revisión humana y procedimiento de
aplicación. La infraestructura y programación requieren una instrucción posterior.
No se hará push, merge, despliegue ni otro proveedor automáticamente.
