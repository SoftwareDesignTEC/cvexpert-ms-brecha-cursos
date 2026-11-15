# CVExpert Course Sync — Fase 1

Núcleo local, determinista y exclusivamente dry-run. No hay scraping, adaptadores
reales nuevos, PostgreSQL, migraciones, Azure, scheduler ni publicación. No se importa
desde Express ni cambia contratos REST. La futura ejecución diaria en Container
Apps Jobs es una intención de arquitectura, no infraestructura creada.

## Auditoría previa y reutilización

Se partió de `develop` en una rama nueva `codex/course-sync-phase1`. Había archivos
sin seguimiento de otras tareas: `.worktrees/`, `postgres-catalog-final.patch`,
`postgres-catalog-review.patch` y `src/server.js`; se conservaron sin cambios.

Se inspeccionaron `scripts/course-discovery/{model,service,store,learn-provider}.ts`,
`scripts/discover-courses.ts`, `scripts/catalog-import/{document,importer}.ts`,
`scripts/import-catalog.ts`, `scripts/admin-import.ts`, `scripts/admin-apply.ts`,
las migraciones 001 y 004, los repositorios de cursos y recomendaciones, las tres
guías de descubrimiento/importación y las pruebas y pipelines existentes.

| Componente existente | Decisión |
| --- | --- |
| `CourseCandidate` | Reutilizar campos y evidencia mediante `Pick`; `fromDiscovery` transforma candidatos sin conceder aprobación |
| `CourseDiscoveryProvider<Q>` / `CourseTopic` | Reutilizar el puerto genérico de búsqueda; no imponer productos/temas de Learn a otros proveedores |
| `text` y `skillKey` | Reutilizar validación textual y comparación de habilidades, sin inferir sinónimos |
| `safeCourseUrl` | Mantener intacto: su política es específica de módulos Learn; el nuevo validador de URLs no la flexibiliza |
| `consolidateCandidates` | No usar para conciliación: agrupa por URL incluso entre identidades diferentes; aquí esos casos necesitan revisión |
| Coordinador de descubrimiento / caché / cuotas | Se conservan; una búsqueda completada o cacheada no acredita cobertura total del catálogo |
| `readJson` / almacén de descubrimiento | No hacen falta para fixtures TypeScript embebidos; no crear otro almacén de disco |
| Importador de catálogo y procedimientos administrativos | No invocar: incluso algunos dry-runs conectan a PostgreSQL. El formato v1 exige `isPaid` booleano y no representa toda la procedencia |
| Repositorios HTTP | Solo lectores del esquema actual; sin fuente/ID externo, convocatorias ni estado lógico. No se modifican |
| `node:test`, `tsx`, compilador de mantenimiento | Reutilizados, sin dependencias nuevas |

La migración 001 mantiene URL única, precio obligatorio y duración en horas enteras.
La 004 audita importaciones aprobadas, no observaciones diarias ni identidad externa.
No se han modificado 001–004. El pipeline existente ejecuta build, pruebas unitarias,
integraciones PostgreSQL desechables y empaquetado con allowlist; el nuevo test entra
en `test/*.test.ts` y scripts se comprueba sin emisión. No se cambió GitHub Actions.

## Flujo y responsabilidades

Flujo diario futuro: proveedor autorizado → descubrimiento → transformación →
validación/normalización → identidad y duplicados → conciliación contra snapshot →
plan revisable → aprobación editorial → publicación mediante persistencia autorizada.
Solo hasta el plan y su proyección en memoria está implementado en esta fase.

| Módulo | Responsabilidad |
| --- | --- |
| `scripts/course-sync/model.ts` | Modelo, estados y puente desde el candidato existente |
| `scripts/course-sync/validation.ts` | Fechas reales UTC, URLs, datos obligatorios, habilidades y convocatorias; identidad y comparación semántica |
| `scripts/course-sync/reconcile.ts` | Función pura `reconcile(snapshot, run)`; acciones y `next` sin mutar entradas |
| `scripts/course-sync/worker.ts` | Puerto de lectura `CatalogSnapshotReader`; coordinación con el proveedor de descubrimiento existente para consultas parciales |
| `scripts/sync-courses.ts` | CLI con fixture fijo TEST; salida JSON a stdout, sin archivos de salida ni modo apply/live |
| `test/fixtures/course-sync.test.ts` | Datos sintéticos, fechas fijas y dominio reservado example.org; no capturas ni evidencia real |

`CatalogSnapshotReader` solo tiene `load`. No existe puerto de escritura en esta fase.
`next` representa únicamente un estado de staging simulado en memoria, **no** el
catálogo publicado ni un documento de importación. Nunca debe persistirse directamente
sobre el catálogo publicado: cualquier cambio de publicación requiere la política
de aprobación correspondiente y un procedimiento de aplicación autorizado.
Los consumidores deben revisar acciones y snapshot conjuntamente.
El núcleo no tiene efectos externos; un proveedor inyectado es una frontera de
confianza. La CLI no acepta ni instancia proveedores reales. Antes de cualquier
integración real, deben reutilizarse/aprobarse presupuestos, timeouts y autorización
de transporte existentes; el callback vacío de la coordinación fixture no controla
cuotas de producción.

## Modelo y estados

`SyncCandidate` conserva `sourceId`, `externalId: string | null`, URL canónica,
título, plataforma, habilidades, idioma nullable, duración en minutos nullable y
`isPaid: boolean | null`. `null` significa desconocido: no se convierte a false,
cero, cadena vacía ni se redondea a horas. No se infiere precio o idioma por fuente.

Modalidad: `virtual`, `presential`, `hybrid` o `unknown`. Geografía nullable con país,
región y localidad nullable. Disponibilidad: `available`, `unavailable`, `withdrawn`
o `unknown`. Indisponibilidad temporal no equivale a retirada explícita.

Cada observación tiene `lastSeenAt`, evidencia del vocabulario existente (endpoint,
URL devuelta, hash de respuesta, título, fecha y metadatos) y validación
`needs_review` o `conflict`. No hay validación aprobada que pueda suministrar un
adaptador. Evidencia debe corresponder a la fecha de observación; ni el hash ni
una URL válida acreditan autenticidad, licencia o pertinencia educativa.

`offerings` contiene convocatorias con identificador externo propio, disponibilidad,
modalidad y geografía propias, y fechas de inicio/fin nullable. Ausencia de fechas
no produce fechas ficticias.
`StoredCourse` añade ID interno, propiedad `manual | sync`, contador de ausencias y
publicación `draft | published | inactive`. IDs de propuestas tienen prefijo
`proposal:` y derivan de la identidad; nunca sustituyen IDs existentes ni pretenden
ser secuencias PostgreSQL. Nuevos registros se proyectan como borradores.

No hay filtro por sector: idiomas, administración, turismo, agricultura, salud,
educación, manufactura y emprendimiento están cubiertos por fixtures/pruebas. Las
habilidades son propuestas revisables, no competencias certificadas del estudiante.

## Identidad, normalización y conciliación

La identidad es la tupla `(sourceId, "id", externalId)` cuando existe un ID estable;
si no existe, `(sourceId, "url", canonicalUrl)`. Nunca se usa similitud de títulos.
Un cambio de URL conserva la identidad con ID estable. Un cambio de ID, la aparición
de un ID donde antes no había, o una URL coincidente con otra identidad exige
revisión y eventual vinculación humana; no hay fusión automática entre proveedores.

URLs: HTTPS, sin credenciales, fragmentos, puertos alternativos, controles,
escapes inválidos o segmentos relativos. WHATWG normaliza host y puerto por defecto;
se conservan query, locale y barra final. No se sigue ningún enlace. Cada adaptador
real deberá añadir allowlist de host/rutas y comprobar que las URLs no contienen
tokens ni secretos. Esta validación sintáctica no autoriza tráfico ni evita SSRF
por sí sola. Las habilidades se ordenan y deduplican; nombres distintos con la
misma clave normalizada se rechazan como ambiguos.

| Situación | Acción / efecto en staging simulado |
| --- | --- |
| Identidad nueva válida | `insert`, borrador pendiente de revisión |
| Identidad existente, metadatos iguales | `unchanged`, refrescar observación y poner ausencias en cero |
| Título/duración/otros metadatos diferentes | `update`, conservar ID y publicación; solicitar revisión |
| Duplicado con metadatos iguales | `duplicate`, una única propuesta con evidencia consolidada |
| Metadatos contradictorios, colisión de URL/identidad o validación conflictiva | `ambiguous`, no elegir ganador ni actualizar el curso |
| Datos inválidos/incompletos | `invalid`, no insertar y bloquear cómputo de ausencias de esa ejecución |
| Curso ausente en recorrido completo válido | `missing`, incrementar contador hasta tres |
| Tercera ausencia válida | `deactivation_candidate`, revisión; no cambiar publicación |
| Fuente declara retirada | `withdrawn`, revisión sin esperar tres ausencias; no borrar ni despublicar |
| Curso manual observado o URL manual coincidente | `manual_protected`, no modificar |

`decision` distingue revisión humana de observación sin cambio de publicación.
Cambios de evidencia/última observación no se consideran cambios editoriales de
metadatos. Todas las acciones de publicación son propuestas: el motor no concede
aprobaciones ni cambia `published` a `inactive`.

Repetir el mismo `runId` por fuente devuelve `skipped` y el mismo estado. También
se rechazan lógicamente ejecuciones con fecha igual o anterior al checkpoint de
esa fuente. Cada intento nuevo debe tener ID único y fecha creciente, incluyendo
un reintento tras error. Observaciones deben ser posteriores al checkpoint y no
futuras respecto al fin de ejecución; la caché antigua no reinicia ausencias como
si fuera una consulta fresca. Checkpoints y proyección se conservan solo en memoria.
Repetir fixtures sobre la misma entrada da el mismo plan; aplicar su proyección
como siguiente snapshot no crea duplicados. Fase 2 debe persistir estado/checkpoint
atómicamente y añadir control de concurrencia/versionado y auditoría de ejecución.

## Ausencias y retiradas masivas

Se exige simultáneamente `scope=full_catalog`, `status=complete`, `valid=true`,
`missingPages=false`, `quotaLimited=false`, lista de errores vacía y cero registros
inválidos o ambiguos. Una búsqueda temática nunca cumple cobertura total, aunque
su última página no tenga nextLink. Una colisión previa del catálogo también
bloquea ausencias. El adaptador futuro deberá demostrar cobertura estable de todo
el proveedor, incluyendo paginación, filtros y ventanas temporales.

Fallos HTTP, cuotas, páginas omitidas y respuesta parcial no incrementan ni ponen
a cero los contadores de cursos no observados. Las tres ausencias son consecutivas
entre recorridos completos válidos: un fallo intermedio no cuenta como ausencia
ni interrumpe esa secuencia. Una observación fresca válida pone el contador a cero,
incluso si otras páginas fallaron. La fecha de última observación no cambia por
ausencia. Para contar ausencias solo se evalúan registros `sync` del proveedor
correspondiente cuya publicación no sea `inactive`. Un curso ya inactivo que sigue
ausente conserva su contador y no genera nuevas propuestas de desactivación.

Política inicial conservadora, pendiente de aprobación operativa: si en una
ejecución se omitirían o retirarían explícitamente **al menos tres cursos y más
del 50 % de los registros no inactivos gestionados por esa fuente**, activar
`massWithdrawalBlocked`. No incrementar ausencias; las retiradas explícitas quedan
como `ambiguous` con `MASS_WITHDRAWAL_BLOCKED`. No hay flag para saltarse el bloqueo.
No se trata de una predicción estadística ni un umbral aprobado para producción.
Una persona debe investigar la cobertura, estacionalidad y condiciones del proveedor.

La desactivación futura será lógica y auditada, nunca DELETE físico. En Fase 1
ni siquiera se aplica esa desactivación lógica: se propone para revisión.

## INA y cursos permanentes

El curso representa una oferta formativa duradera; cada convocatoria INA representa
una oportunidad concreta, con fechas y ubicación cuando estén disponibles. Un
identificador de convocatoria no debe convertirse en el ID estable del curso.
Cuando no exista una relación inequívoca curso/convocatoria, el adaptador deberá
marcar ambigüedad y remitir a revisión, sin deducirla del título.

Retirar o finalizar una convocatoria no retira el curso padre. Convocatorias omitidas
se conservan; no se infiere retirada a partir de omisiones ni de fechas vencidas.
Solo se actualiza una convocatoria explícitamente observada. La conciliación de
ausencias de convocatorias por ventana temporal queda pendiente de diseño en Fase 2.
Para cursos permanentes, `offerings=[]` expresa que no se observaron convocatorias;
no inventa una convocatoria genérica. Estos criterios no afirman cómo funciona una
API real del INA: no se ha consultado ni implementado ninguna.

## Diseño aditivo preliminar para Fase 2

Propuesta para revisión, sin archivos SQL ni ejecución de migraciones:

1. Tabla de proveedores y alcance de cobertura, estado de autorización, política
   de identidad, dominios aprobados y versión de adaptador; no guardar secretos.
2. Tabla de cursos de staging con identidad fuente/ID externo, URL canónica,
   precio/duración nullable, modalidad, geografía y disponibilidad. Índice único
   parcial `(source_id, external_id)` cuando ID no sea null; índice único parcial
   `(source_id, canonical_url)` para identidad sin ID. Registrar colisiones de URL
   aparte y resolverlas antes de publicar.
3. Convocatorias con FK al curso de staging y unicidad `(staging_course_id,
   external_offering_id)`, fechas nullable y disponibilidad propia. El ID de una
   convocatoria nunca sustituye la PK del curso.
4. Ejecuciones/observaciones con ID único por fuente, cobertura, errores saneados,
   versión, hashes y fechas; checkpoint, contador, decisiones y revisión masiva
   atómicos. Evidencia con retención y control de acceso aprobados.
5. Vínculo explícito y revisado con `public.courses.id`, propiedad manual/sync,
   historial de aprobaciones y cambios. No atribuir automáticamente al worker los
   cursos existentes. Revisión humana del backfill, sin modificar 001–004.
6. Estado lógico de publicación e índices/filtros en futuras migraciones aditivas.
   El contrato actual no filtra activos; cambiar el esquema sin adaptar lectores
   no ocultaría cursos. Aprobar conjuntamente política, lectores y compatibilidad.
   Mantener minutos/precio desconocido en staging; no forzar el v1 actual a admitirlos
   ni convertir `isPaid=null` en false para satisfacer NOT NULL.

Acordar nombres definitivos, constraints, locks, versión optimista, rollback,
permisos mínimos y semántica de aprobación antes de implementar estas migraciones.
La publicación deberá aplicar únicamente un plan aprobado contra la versión exacta
del snapshot; una proyección de Fase 1 no es una autorización administrativa.

## Permisos y decisiones pendientes

Obtener una página pública **no equivale a tener autorización para hacer scraping
o almacenar automáticamente sus datos**. Saylor University, HP LIFE, FAO e INA son
posibles fuentes futuras, no integraciones verificadas ni permisos concedidos.
Antes de cada adaptador, responsables humanos deben aprobar acceso, términos,
licencia de metadatos, atribución, frecuencia, almacenamiento/retención y publicación,
y comprobar la existencia y contrato del mecanismo de acceso autorizado.

Quedan pendientes la verificación editorial de habilidades, precio, idioma y
duración; política de actualización automática de cursos aprobados; umbral de baja
masiva; correspondencia entre cursos y convocatorias; migraciones/compatibilidad;
credenciales e identidad administrada; red, cuotas globales, coordinación de jobs,
observabilidad, retención y recuperación. No se tomaron esas decisiones ni se
crearon recursos. El alcance termina en Fase 1.

## Ejecución y validación

Node 24 y dependencias existentes. Comandos ejecutados:

```sh
git status --short
git branch --show-current
git branch --list
git switch -c codex/course-sync-phase1
npm pkg set 'scripts.courses:sync=tsx scripts/sync-courses.ts'
npm run build
node --import tsx --test test/course-sync.test.ts
npm test
npm run courses:sync -- --dry-run --fixture
```

Además se usaron lecturas `Get-Content`, búsquedas `rg --files`, `git diff/status`
y una comprobación de saltos de línea contra `git show HEAD`. No se instalaron
dependencias, no se ejecutó `db:test`, no se conectó PostgreSQL ni se migró nada.

Las pruebas nuevas cubren inserción, duplicados/conflictos, idempotencia, cambios,
IDs preservados, tres ausencias, errores/cobertura parcial/cuota/páginas, retiradas
masivas, convocatorias, propiedad manual, URLs/datos inválidos, sectores diversos,
aislamiento por fuente y CLI cerrada. La prueba de efectos externos ejecuta la demo
en un proceso Node con `--permission --allow-fs-read=*`: sin permiso de red, escritura,
procesos hijos o workers, y con entorno mínimo sin credenciales. Se usa el transformador
TypeScript nativo solo en ese proceso para no requerir esbuild. La CLI habitual usa
tsx como los otros scripts. No se prueban proveedores reales ni disponibilidad real.

El primer `npm test` dentro del sandbox falló en pruebas HTTP existentes con EACCES
en loopback. La repetición autorizada fuera de ese bloqueo obtuvo 105/107 pruebas
aprobadas (incluidas las 16 nuevas en ese momento): un fallo documental por CRLF
en `docs/job-required-skill-levels.md`, y un `fetch` HTTP existente con `bad port`.
La comparación documental falla en el checkout, pasa normalizando CRLF a LF y pasa
contra el contenido de HEAD; el documento no fue modificado. No se cambian pruebas
ni lógica ajenas para esconder estos resultados. Las verificaciones finales y los
casos adicionales se registran debajo.

Validación final (15 de noviembre de 2026, Node 24.21.0):

| Comando | Resultado |
| --- | --- |
| `npm run build` | Aprobado: servidor y scripts de mantenimiento |
| `node --import tsx --test test/course-sync.test.ts` | 19/19 aprobadas, sin omisiones |
| `npm test` | 109/110 aprobadas; único fallo: comparación documental CRLF ya descrita, `test/documentation.test.ts:78` |
| `npm run courses:sync -- --dry-run --fixture` | Plan TEST determinista con propuesta de inserción, sin publicación ni acceso a base |
| `git diff --check` | Sin errores |

La última suite completa se capturó con `npm test 2>&1 | Select-Object -Last 37`;
las pruebas HTTP pasaron, incluido el caso que antes recibió `bad port`.
El build y las 19 pruebas específicas también se repitieron tras el ajuste final
de modalidad/geografía de convocatorias y protección contra observaciones cacheadas.
No se declara la suite completa verde: queda el fallo documental del checkout.

Archivos añadidos: los cuatro módulos de `scripts/course-sync/`,
`scripts/sync-courses.ts`, `test/course-sync.test.ts`,
`test/fixtures/course-sync.test.ts` y esta guía. Único archivo existente modificado:
`package.json`, para registrar `courses:sync`. Sin commit, push, merge o despliegue.

Siguiente fase requiere nueva instrucción: autorizar fuentes, validar contratos y
cobertura reales, acordar esquema aditivo y propiedad de registros, persistir planes
y checkpoints con auditoría/concurrencia, implementar revisión/publicación lógica,
y solo después aprobar identidad, infraestructura y programación diaria.

### Revisión del PR #27: cursos inactivos

El bucle de ausencias omite los cursos con `publication=inactive`, conservando su
contador y evitando propuestas redundantes de desactivación. Las regresiones cubren
contadores 0–3, ausencias completas repetidas y un catálogo mixto donde el curso
publicado sigue proponiendo revisión únicamente al alcanzar la tercera ausencia.

Validación de esta corrección: `npm run build` aprobado;
`node --import tsx --test test/course-sync.test.ts`, 21/21 aprobadas;
`npm test`, 111/112 aprobadas. Persiste únicamente el fallo documental preexistente
por CRLF en `test/documentation.test.ts:78`, fuera del alcance de esta corrección.
No se implementó persistencia ni se avanzó de fase.
