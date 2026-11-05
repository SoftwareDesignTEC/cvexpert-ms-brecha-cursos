# Núcleo de Brecha: implementado; integración HTTP pendiente

## Evidencia y límites del contrato (29-10-2026)

Se revisaron las fuentes remotas en modo lectura. Ningún otro repositorio se modificó:

| Fuente | Evidencia y consecuencia |
| --- | --- |
| [Consolidación cvexpert-docs](https://github.com/SoftwareDesignTEC/cvexpert-docs/tree/54a2c23a4ed78c5458985e0a08b40a1bb8912818) (`docs/consolidacion-openapi-20261020`; main solo contiene README) | `contratos/brecha-cursos.yaml`, `usuarios.yaml`, `cvs.yaml`, `ofertas-postulaciones.yaml`, `docs/revision-integracion.md` y `docs/fuentes.md`. Son borradores/instantáneas, no prueba de operaciones desplegadas. La copia de Cursos todavía figura como no implementada y está desactualizada respecto al PR #6. |
| [CVs: SkillLevel](https://github.com/SoftwareDesignTEC/cvexpert-docs/blob/54a2c23a4ed78c5458985e0a08b40a1bb8912818/contratos/cvs.yaml) | `beginner`, `intermediate`, `advanced`, `expert`; no equivalen automáticamente a enteros o porcentajes. Existe un contrato de lectura de CV, pero no se comprobó su implementación ni un exportador de niveles para Brecha. |
| [Ofertas](https://github.com/SoftwareDesignTEC/cvexpert-docs/blob/54a2c23a4ed78c5458985e0a08b40a1bb8912818/contratos/ofertas-postulaciones.yaml) | `skills: string[]`, requisitos textuales y años de experiencia; no un nivel comparable por habilidad ni un feed de requisitos agregados de mercado. No inventamos tal operación. |
| [Usuarios e integración](https://github.com/SoftwareDesignTEC/cvexpert-docs/blob/54a2c23a4ed78c5458985e0a08b40a1bb8912818/docs/revision-integracion.md) | APIM debe validar identidad y sobrescribir encabezados. Certificados, bloqueo del acceso directo y autorización necesitan pruebas; los documentos no las demuestran. |
| [Web: servicio](https://github.com/SoftwareDesignTEC/cvexpert-web/blob/b2c34021b3532ff8c14481c02c70b92d2be903f7/apps/web/src/services/skillsGapService.ts) y [pantalla](https://github.com/SoftwareDesignTEC/cvexpert-web/blob/b2c34021b3532ff8c14481c02c70b92d2be903f7/apps/web/src/pages/SkillsGapPage.tsx) | GET sin parámetros, lee `items`; duración numérica y cursos aplanados con clave `id`. La pantalla calcula diferencia numérica y muestra `%`: esa representación no demuestra que exista una escala porcentual acordada. |
| [Android: API](https://github.com/SoftwareDesignTEC/cvexpert-mobile/blob/931fa33ec8ce5868f223ea0d8f38b05338b72ceb/app/src/main/java/com/cvpro/app/data/remote/api/SkillsGapApi.kt), [DTO](https://github.com/SoftwareDesignTEC/cvexpert-mobile/blob/931fa33ec8ce5868f223ea0d8f38b05338b72ceb/app/src/main/java/com/cvpro/app/data/remote/dto/SkillsGapDto.kt) y [repositorio](https://github.com/SoftwareDesignTEC/cvexpert-mobile/blob/931fa33ec8ce5868f223ea0d8f38b05338b72ceb/app/src/main/java/com/cvpro/app/data/repository/ApiSkillsGapRepository.kt) | GET con `page`/`pageSize`; repositorio solicita 1/100. `durationHours: Int`, `logoUrl: String?`; mapper aplana todos los cursos. |
| Código local | Catálogo persistente con asociaciones exactas, IDs enteros y duración nullable; `/skills-gap` demo y bloqueado en producción. No hay entrada autenticada de habilidades ni requisitos reales del mercado. |

Regla de integración: los microservicios no se llaman directamente. Un cliente
podría transportar la información obtenida de su CV, pero necesitamos acordar
la procedencia y si una autoevaluación es aceptable. Un payload del cliente no
prueba por sí mismo la autenticidad del CV ni de sus niveles.

## Datos necesarios y disponibles

El motor necesita nombres canónicos de habilidades, niveles conocidos del usuario,
requisitos de un contexto de mercado explícito, una escala común versionada y
asociaciones curso-habilidad. Tenemos únicamente el catálogo y su esquema local.
Faltan la fuente/actualización de mercado, la definición de cada contexto,
traducción acordada de niveles textuales, catálogo de sinónimos, vigencia de
requisitos, entrada de habilidades y frontera de identidad verificada.

`LevelScale = {key, levels}` es un acuerdo interno inyectado: `levels` enumera
valores enteros en orden de menor a mayor competencia. No hay escala por defecto,
ni equivalencia automática entre claves, ni conversión de palabras a números.
El límite int32 mantiene compatibilidad técnica con PostgreSQL y Android; no fija
el rango de negocio. Los fixtures 10/30/90 son exclusivamente de prueba.
La clave debe identificar también la versión; cambiar su significado exige otra
clave. La futura capa HTTP debe resolverla en un registro aprobado del servidor;
no permitirá al cliente redefinir una escala o el mercado.

## Persistencia y mantenimiento

`002_create_market_requirements.sql` añade una tabla propiedad de Brecha/Cursos:

- `(market_key, skill_id)` es la PK: un requisito por habilidad y contexto. La
  elección de contextos es un acuerdo pendiente, no una lista inventada de sectores.
- FK hacia `skills` con RESTRICT: no se puede borrar una habilidad que define
  un requisito vigente accidentalmente. Índice inverso por `skill_id` para la FK;
  la PK ya cubre consultas por `market_key`.
- `required_level integer NULL` y `scale_key text NULL`: se conserva lo desconocido.
  No se impone un CHECK 0–100; el dominio valida pertenencia a la escala recibida.
  La tabla permite almacenar niveles cuya interpretación todavía no se acordó;
  el motor se abstiene de compararlos. Las claves/nombres son exactos y versionados.
- `source_reference text NOT NULL` es una referencia opaca para trazabilidad,
  nunca una URL descargada automáticamente. `observed_at timestamptz` indica cuándo
  se observó el requisito, no su validez futura ni una prueba de veracidad.
- `data_kind` explícito `reference`/`demo` sin default. El motor rechaza cualquier
  requisito demo, incluso en desarrollo. Marcar una fila `reference` no verifica
  su contenido: la revisión de origen es responsabilidad del mantenedor.

Migrar con el comando existente `npm run db:migrate`, **solo sobre una base local
con credenciales de mantenimiento**. El historial/checksum, transacción y advisory
lock existentes aseguran una sola aplicación por versión. Una segunda ejecución
no cambia datos. No se editaron migraciones previas ni se agregó seed de mercado.
No se ejecuta ninguna migración, seed o importación al arrancar HTTP.

La carga de requisitos queda en el rol dueño/mantenedor mediante el
[importador JSON local](market-import.md), con dry-run por defecto y aplicación
explícita; no hay endpoint administrativo ni job remoto.
No usamos el rol HTTP para mantenimiento. Para una base local ya migrada, su
administrador concede únicamente el permiso nuevo (los otros SELECT ya existen):

```sql
GRANT SELECT ON public.market_requirements TO cvexpert_brecha_app;
```

No se concede INSERT, UPDATE, DELETE, uso de secuencias, CREATE ni acceso al historial
de migraciones. El grant no está dentro de la migración porque los roles pertenecen
al entorno, no necesariamente existen en toda base nueva. Los tests lo ejecutan
solo en sus bases desechables. Azure no fue consultado ni modificado.

## Algoritmo y servicio funcional

`src/domain/skills-gap.ts` no importa Express, `pg` ni configuración de entorno.
Valida primero las entradas. Niveles no enteros/int32, valores ajenos a una escala
conocida, escalas ambiguas y duplicados contradictorios fallan explícitamente.
Duplicados idénticos se colapsan; nunca se elige el máximo para ocultar conflictos.

Recorre la unión de nombres de usuario y mercado. Una habilidad ausente no
equivale a nivel cero. Ausencia de un extremo, nivel NULL, escala desconocida o
incompatible produce `unresolved` con niveles conservados. Solo pares comparables
incrementan `comparedSkills`. Un déficit existe si la posición ordinal del mercado
supera la del usuario. `deficitSteps` cuenta posiciones, no distancia porcentual.
Orden: déficit descendente y nombre por comparación binaria UTF-16, sin locale.

Selecciona cursos cuya asociación exacta incluya una habilidad deficitaria;
no puede afirmar que el curso enseñe el nivel requerido porque ese dato no existe.
Ordena IDs SQL numéricos ascendentes. Un curso se asigna una sola vez globalmente,
a la primera brecha compatible en el orden anterior; no se repite al aplanar la
respuesta de los clientes. Conserva todos los nombres asociados y los NULL de
duración/logo. Cursos sin habilidades o sin coincidencias no se seleccionan.
No favorece precio, plataforma o duración; no hay puntuación inteligente ni
evidencia de calidad. Este criterio es determinista, pertinente y revisable.

El motor excluye cursos marcados `[DEMO]` en título, plataforma o habilidades y
rechaza requisitos/habilidades de mercado demo. Esa convención no sustituye un
modelo formal de procedencia de cursos: antes de datos reales se debe revisar el
catálogo de mantenimiento. No se agregaron ejemplos ficticios a producción.

`status=empty` indica que no había habilidades ni requisitos; `incomplete` indica
casos sin evaluar; `complete` indica que todos los pares recibidos son comparables.
Ninguno certifica cobertura o vigencia de todo el mercado. Una brecha sin cursos
mantiene `courses: []`. Los cursos permanecen nullable en el resultado interno.

`createSkillsGapAnalysisService(repository).analyze(marketKey, scale, userSkills)`
es una entrada interna funcional. `createPostgresSkillsGapRepository()` abre el
pool solo al consultar y tiene `close()`; el dueño del servicio debe cerrarlo.
Una sentencia SELECT parametrizada obtiene requisitos y catálogo relacionado
con la misma instantánea. El servicio traduce errores de PostgreSQL/configuración
a `AnalysisUnavailable`, sin detalles sensibles. No inventa resultados vacíos ante
una caída. Entradas inválidas generan `InvalidAnalysisInput`.

## Propuesta concreta para HTTP: requiere ratificación

`openapi.yaml`, `/skills-gap`, sus modelos, `/courses` y sus rutas permanecen
intactos. **El núcleo no está conectado al GET; el endpoint todavía es demo.**
No se leen ni confían encabezados `X-User-Id`, identidades en cuerpos o querystrings.
Producción mantiene su 503 y no devuelve demostraciones. Tampoco se altera CD.

El borrador separado [`skills-gap-input.proposed.yaml`](skills-gap-input.proposed.yaml)
propone `PUT /skills-gap/input` para reemplazar una instantánea del usuario actual.
NO está implementado ni aprobado. No acepta userId. El cliente transportaría
habilidades; el backend tomaría la identidad exclusivamente de una frontera APIM
verificada. Antes de implementarlo: demostrar validación de token, eliminación de
encabezados falsificados, certificado APIM y bloqueo de acceso directo. Sin esa
frontera, el handler debe rechazar la operación y no confiar en encabezados.

Tras aprobarlo, un PR futuro deberá diseñar almacenamiento privado de instantáneas,
aislamiento por identidad, retención/borrado y actualización atómica. La opción
preferida es calcular al leer GET con esa instantánea y requisitos locales, sin
llamadas entre servicios. La paginación se aplica a brechas ya ordenadas, con
totalRecords antes de paginar y asignación de cursos antes de paginar. Habilidades
incompletas no pueden publicarse como “sin brechas”; hay que acordar el estado HTTP
y cómo exponer incompletitud sin romper el cuerpo actual. Este PR no crea tablas
de usuarios, snapshots ni recomendaciones guardadas.

Para preservar `CourseSuggestion.durationHours: integer` sin fabricar cero,
proponemos inicialmente excluir del adaptador legado los cursos con duración
desconocida, conservándolos completos dentro del núcleo y `/courses`. Esa exclusión
requiere aprobación explícita, puede dejar una brecha sin cursos y NO está
implementada aquí. Alternativa: versionar/ampliar el contrato con duración nullable
y coordinar cambios en Android/web. Los IDs pueden mapearse a String(id), sin
cambiar los modelos actuales. La escala pública debe acordarse también con los
componentes que hoy muestran porcentajes. No se habilitará GET real antes de
resolver estas decisiones y probar el adaptador contra ambos consumidores.

## Pruebas y decisiones pendientes

`npm test`: dominio, selección, límites, servicio y pruebas HTTP existentes;
no requiere PostgreSQL. `npm run db:test`: mecanismo existente de bases aleatorias
locales sobre PostgreSQL 17 desechable, sin volumen de desarrollo y sin Azure.
Se prueban idempotencia, NULL, contextos, selección, inyección SQL, errores reales,
FK/PK/CHECK y lectura con `cvexpert_brecha_app`; las escrituras/DDL se deniegan.
Los fixtures `[TEST]` no son el seed local `[DEMO]` y no cargan datos operativos.

Ratificar antes de conectar HTTP: fuente y gobernanza del mercado; contextos y
vigencia; escala y traducción de CVs; autoevaluación vs datos verificados; nombres
canónicos; operación PUT/identidad/retención; respuesta para datos insuficientes;
nulabilidad de cursos; asignación única y criterio de selección. No se implementan
IA, llamadas entre servicios, Service Bus, ni cambios de Azure/APIM/certificados.

Se consideraron tablas completas de escalas y perfiles de mercado, pero no hay
acuerdos que justifiquen esa estructura todavía. Se guarda la clave versionada y
se inyecta su definición en el núcleo. Se prefirió un único SELECT sobre múltiples
lecturas con transacciones, y motor puro sobre lógica dentro de controladores.
El snapshot completo favorece claridad y consistencia; requiere evaluar tamaños
y límites operativos antes de exponerlo a tráfico real.
