# OpenLearn — piloto Fase 3B

Revisión de investigación: **2026-11-15**, zona America/Costa_Rica. Base:
`origin/develop`, `fada6a1f039c1d90464ba2f7a16a9a00b4425bd8`, verificada tras fetch.
Rama `codex/course-sync-openlearn-enrichment`, worktree independiente
`.worktrees/course-sync-openlearn-enrichment`. El [PR #29](https://github.com/SoftwareDesignTEC/cvexpert-ms-brecha-cursos/pull/29)
está fusionado. Se inspeccionaron su diff, el adaptador y el probe, además de
`CatalogDocument` v1 y el procedimiento administrativo actual.

El [piloto JSON revisable](openlearn-pilot.json) contiene **3 identidades reales**
tomadas exclusivamente de [la comprobación previa](openlearn.md). Dos tienen
página descriptiva contrastada; la tercera conserva datos históricos y bloqueos.
**Ninguna está aprobada. No hay lote publicable en esta entrega.**

## Cursos y comprobaciones

| ID fuente | Curso / URL directa conservada | Área RDF | Acceso y disponibilidad observados | Horas de estudio | Nivel del proveedor |
| --- | --- | --- | --- | --- | --- |
| 1256612 | [Climate justice for the next generation](https://www.open.edu/openlearn/education-development/climate-justice-the-next-generation/content-section-0) | Education & Development | Página descriptiva accesible, señal individual de curso gratuito y acceso inicial sin registro | 7 | Level 2: Intermediate |
| 1586133 | [Beginners’ Chinese: a taster course](https://www.open.edu/openlearn/languages/beginners-chinese-taster-course/content-section-0) | Languages | Página descriptiva accesible, señal individual de curso gratuito y acceso inicial sin registro | 4 | Level 1: Introductory |
| 29681 | [The Beveridge vision](https://www.open.edu/openlearn/health-sports-psychology/health/nursing/the-beveridge-vision/content-section-0) | Healthcare Careers, Nursing | La herramienta de investigación no pudo acceder. No equivale a retirada ni a 404 | Desconocidas | Desconocido |

Plataforma: **OpenLearn — The Open University**. Idioma docente: **desconocido en
los tres**. No se deduce del idioma del título, del texto descriptivo ni de que el
segundo enseñe mandarín. Costes opcionales: desconocidos; no se afirma que todos
los servicios o certificaciones sean gratuitos. `isPaid=false` en los dos primeros
se refiere exclusivamente al acceso al curso con evidencia individual. En Beveridge
se conserva `isPaid=null`.

Las comprobaciones llevan fecha y referencia por campo en `checks`. Los IDs se
remiten a la documentación histórica fijada al commit base, no a una nueva
consulta RDF. Las categorías también proceden de esa muestra. No se repitió el
probe, no se guardó una respuesta RDF como fixture ni se recorrió el catálogo.
`available` significa página descriptiva accesible y señal de inicio de curso,
sin probar registro, finalización, actividades autenticadas o disponibilidad futura.
La herramienta puede devolver contenido indexado: estas observaciones no son una
certificación de respuesta HTTP directa al origen en tiempo real.

Las referencias de las páginas son sus URLs directas. Se revisaron las secciones
de descripción, resultados de aprendizaje, acceso, información del curso y copyright.
No se abrieron lecciones, imágenes, paquetes o descargas. Los intentos con las
páginas sin sufijo no sustituyen las identidades ni corrigen URLs automáticamente.
El enlace de condiciones de uso desde la página devolvió un error de herramienta
502; no se presenta como términos contrastados. Sigue pendiente su revisión antes
de publicar. No hubo credenciales, cookies de usuario, bypass ni extracción masiva.

## Habilidades propuestas y correspondencias

`skillProposals` contiene paráfrasis editoriales breves de los resultados de
aprendizaje y una referencia a la página que los publica. No son nombres
canónicos nuevos, sinónimos ni asociaciones aprobadas. Las categorías están
separadas en `subjects` y jamás se convierten en habilidades.

| Curso | Evidencia de resultados | Decisión pendiente |
| --- | --- | --- |
| Climate justice | Sección Course learning outcomes de su página | Revisar las dos propuestas del JSON, su alcance y el nombre exacto del vocabulario |
| Beginners’ Chinese | Sección Course learning outcomes de su página | Revisar las tres propuestas del JSON, su alcance introductorio y el nombre exacto |
| The Beveridge vision | No se pudo contrastar la página ni sus resultados | Sin propuesta de habilidades sustentable en esta revisión |

**Los tres cursos carecen de correspondencia verificable con el vocabulario
vigente de CVExpert.** No había un entorno de pruebas autorizado e identificado
para consultar ese vocabulario. No se conectó a PostgreSQL ni se usaron credenciales.
El archivo local candidato de catálogo contiene Python, SQL, JavaScript, Git,
Linux y Django, pero no acredita el contenido actual de `public.skills` ni ofrece
una correspondencia sustentada para estos cursos. Los seeds `[DEMO]` tampoco
son vocabulario de producción. Por ello `vocabulary.names=[]`, referencia y fecha
desconocidas y `canonicalName=null` en todas las propuestas.

Una persona puede aportar una instantánea de nombres exactos obtenida mediante
SELECT en un entorno de pruebas autorizado, con fecha y referencia custodiada,
sin secretos. El generador exige coincidencia literal, sensible a mayúsculas y
Unicode; no recorta nombres, inventa sinónimos ni declara habilidades nuevas.
La procedencia/autenticidad de esa instantánea requiere revisión humana. No se
implementó conexión a la base ni un exportador en esta fase.

## Fuentes, atribución y licencia

- [Dataset oficial OpenLearn](https://data.open.ac.uk/datasets), consultado
  2026-11-15: metadatos de unidades educativas, grafo `openlearn2`,
  [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). No garantiza catálogo
  exhaustivo ni vigente. Atribución: **The Open University, OpenLearn metadata**.
- Páginas individuales enlazadas arriba, consultadas 2026-11-15: hechos de acceso,
  horas, nivel y resultados. Se conservan solo metadatos y paráfrasis mínimas,
  señalando selección y transformación por CVExpert sin respaldo implícito.
- [FAQ oficial, copyright e intellectual property](https://www.open.edu/openlearn/about-openlearn/frequently-asked-questions-on-openlearn),
  consultada 2026-11-15: distingue materiales propios y de terceros, y condiciones
  de reutilización. La política general menciona BY-NC-SA salvo aviso distinto;
  las dos páginas muestran aviso BY-NC. Versión y términos concretos pendientes.
  Esta diferencia no se resuelve suponiendo una licencia uniforme.

La licencia RDF no se extiende a material educativo, imágenes o terceros. No se
copiaron contenidos educativos completos ni recursos. Las propuestas editoriales
y sus evidencias quedan para revisión de derechos antes de cualquier publicación;
no se afirma que el aviso de acceso gratuito autorice reutilización comercial del
contenido. El lote conserva atribución, licencia de metadatos, fuentes, fechas y
hash del contenido revisado en `sourceReference`. Conservar además piloto e informe
completos: v1 no persiste esa procedencia en columnas PostgreSQL ni publica avisos
de atribución por sí mismo. La presentación visible de atribución requiere trabajo
y revisión posteriores.

## Generador offline y revisión humana

Desde este worktree, usando las dependencias existentes (sin cambios a package.json):

```powershell
node --import tsx scripts/review-openlearn.ts report --file docs/providers/openlearn-pilot.json
node --import tsx scripts/review-openlearn.ts catalog --file docs/providers/openlearn-pilot.json
```

`report` produce JSON determinista por stdout con el contenido completo, hash,
bloqueos y posible catálogo. `catalog` solo emite el subconjunto elegible como
`CatalogDocument` v1. Con el piloto actual falla con salida 1 y sin lote por stdout.
No firma, aplica, publica, escribe archivos, consulta URLs o bases, carga `.env`,
cambia permisos ni acepta flags de red o publicación. Lectura UTF-8 estricta,
archivo regular, máximo 1 MiB, máximo 10 candidatos, claves desconocidas/duplicadas
y tipos coercibles rechazados. No depende del adaptador, de staging o de repositorios.

Para cada candidato, la persona revisora debe:

1. Contrastar título, URL, vigencia, coste de acceso, horas y avisos aplicables.
   Registrar referencias, fecha y observaciones en `checks`. Conservar las fuentes
   contradictorias y resolverlas fuera del lote antes de generar una revisión nueva.
2. Aprobar o rechazar cada propuesta. Para aprobar una asociación, aportar evidencia
   de aprendizaje y `canonicalName` exacto incluido en `vocabulary.names`, con
   referencia y fecha de la instantánea. Una propuesta pendiente bloquea el curso.
   Si no se encuentra ninguna correspondencia, rechazar las propuestas pendientes
   y justificar explícitamente la decisión de publicar sin habilidades.
3. Ejecutar `report` con el contenido final y copiar su `contentSha256` a `review`.
   Completar `reviewer`, `approvedAt` UTC canónica y decisiones booleanas explícitas
   `title`, `url`, `cost`, `skills`, `rights`, `availability`. Todas deben ser true
   después de la revisión. `noSkillsReason` debe ser texto si se publica sin habilidades,
   o null cuando las hay. La fecha de aprobación no puede preceder a la evidencia.
4. Repetir `report`. Cambiar datos, evidencias, propuestas o vocabulario invalida el
   hash anterior. El hash no es firma ni prueba de identidad: un operador que edita
   el archivo puede simular una aprobación. La firma administrativa posterior sigue
   siendo necesaria. El generador siempre declara `authorizedToPublish=false`.

Forma de `review` (plantilla incompleta, deliberadamente no aprobada):

```json
{
  "reviewer": "NOMBRE_REAL_DEL_REVISOR",
  "approvedAt": "FECHA_UTC_REAL_CON_MILISEGUNDOS",
  "contentSha256": "HASH_DEL_INFORME_FINAL",
  "title": false,
  "url": false,
  "cost": false,
  "skills": false,
  "rights": false,
  "availability": false,
  "noSkillsReason": null
}
```

No se emite `isPaid` sin booleano respaldado por comprobación. Duración desconocida
queda null. Horas enteras se preservan, incluido cero si existiera evidencia;
fracciones y desbordamiento int32 se bloquean, sin redondear ni confundir minutos
con horas. Nivel e idioma se conservan en la revisión, pues v1 no los representa.
Un curso sin habilidades es válido en v1 con revisión explícita y justificación.
No se crea ninguna habilidad: `skills` del lote queda vacío y las asociaciones
deben existir en el vocabulario contrastado. El plan administrativo comprobará
otra vez su existencia y los conflictos con el destino real.

URLs duplicadas e IDs repetidos bloquean todas las copias. Evidencia ausente o
contradictoria bloquea el candidato incluso si tiene aprobación. El parser existente
`parseCatalogDocument` valida cada curso y el resultado final. No se emite un
documento vacío ni se trasladan los candidatos bloqueados al lote parcial.
Conservar siempre el informe junto al lote para hacer visibles las exclusiones.

## Puente al procedimiento administrativo

Este archivo es preparación editorial, no autorización de escritura. Un catálogo
generado sigue siendo entrada candidata para [plan/sign/apply](../admin-import.md):
plan usa lector separado y transacción READ ONLY, combina catálogo, mercado,
escala y evidencia, y calcula hashes de los originales y del plan. No se fabrica
un mercado/escala vacío para completar esos argumentos. El aprobador revisa plan,
destino, fuentes, vigencia, niveles y autorización de escritura, con ventana de
aprobación. Sign usa su clave Ed25519 custodiada; apply revalida firma, hashes,
destino y conflictos antes de escribir. Nada de ello fue ejecutado aquí.

El lote parcial debe ser revisado completo antes de entrar en ese procedimiento.
No sustituir decisiones administrativas con los booleanos editoriales de este
piloto ni modificar hashes para eludir un conflicto. No se alteraron scripts
administrativos, repositorios PostgreSQL, migraciones o código de staging.

## Límites del adaptador y ampliación

El SELECT actual solo comprueba `OpenCourseware`, título, URL HTTPS directa,
`internalID` opcional y `primaryTerm` opcional. Puede devolver varias filas por
identidad debido a categorías y excluye URLs históricas HTTP. No se identificaron
ni validaron en ese contrato idioma docente, horas, nivel, coste individual,
objetivos o estado vigente. Esto no demuestra que esas propiedades no existan
en ninguna parte del grafo: su presencia y semántica no se han investigado aquí.
Un literal con idioma no prueba idioma docente y `OpenCourseware` no prueba vigencia.

Ampliar exige resolver vigencia/cobertura, cuotas/frecuencia, cambios de identidad
y URL, enriquecimiento permitido, criterios editoriales y atribución visible.
Esta fase no incorpora scraping, feeds, publicación, Azure, jobs o extracción
masiva. Staging durable y persistencia siguen en el trabajo paralelo.

## Verificación

- `npm run build`: aprobado, incluye scripts de mantenimiento.
- `node --import tsx --test test/openlearn-enrichment.test.ts`: **15/15 aprobadas**,
  solo fixtures sintéticos TEST. Cubren completos/desconocidos, ambigüedad, ausencia
  de habilidades, costes opcionales, niveles/horas, duplicados, contradicciones,
  determinismo, cambios tras revisión y rechazo sin aprobación. La CLI se ejecuta
  bajo permisos Node sin red, escrituras, workers, procesos hijos o credenciales.
- `npm test`: **162/163 aprobadas** fuera de la restricción de loopback del sandbox.
  El único fallo es el documental preexistente `test/documentation.test.ts:78`,
  búsqueda literal de JSON LF en Markdown CRLF; ya registrado en Fase 2B. No se
  modificó ese archivo ni el documento ajeno. La ejecución inicial en sandbox
  también tuvo denegaciones EACCES en pruebas HTTP de loopback.
- `report` real: 3 identidades, 0 elegibles. Los dos primeros: `SKILLS_PENDING` y
  `EXPLICIT_REVIEW_REQUIRED`. Beveridge: `AVAILABILITY_UNVERIFIED`,
  `ACCESS_COST_UNKNOWN`, `EXPLICIT_REVIEW_REQUIRED`.
- No se ejecutaron tests de BD ni comandos plan/sign/apply: esta tarea no identifica
  un destino de pruebas autorizado y no realiza escrituras de datos.

No se hizo push, merge o despliegue. La aprobación de título, URL, coste,
habilidades y derechos, así como un vocabulario contrastado y la comprobación de
Beveridge, requieren intervención humana.
