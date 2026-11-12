# Descubrimiento de formación: propuestas locales separadas del catálogo

Implementado en la rama `codex/course-discovery`, desde `develop` `3ef43f3`. No se ha consultado una API formativa autenticada ni comprobado una identidad Entra. Se ejecutó el modo fixture, con datos sintéticos identificados como `[TEST]`. No se publican cursos, no se abre PostgreSQL y no cambia ningún endpoint ni contrato de Android. La programación y el acceso real están desactivados por defecto.

## Fuentes evaluadas — 11 de noviembre de 2026

| Fuente | Autenticación, coste y límites comprobados documentalmente | Decisión |
| --- | --- | --- |
| Microsoft Learn Platform API v1 | Entra app-only o delegado; onboarding requerido. Publica metadatos y enlaces formativos; su documentación indica acceso sin cargo. App registration o managed identity, scope app-only `https://learn.microsoft.com/.default` | Seleccionada: fuente oficial y metadatos estructurados. No se presupone identidad, acceso ni autorización de conservación |
| Brave Search API | Clave `X-Subscription-Token`. La página de precios consultada muestra Search a USD 5 por 1000 solicitudes, USD 5 de créditos mensuales y capacidad de 50 solicitudes/s; no se verificó un plan contratado | Útil para descubrir enlaces en dominios permitidos, pero no para certificar temario/precio. No implementada: los términos generales restringen almacenar/cachear resultados salvo lo transitorio; haría falta acuerdo específico para este staging persistente |
| Open edX Course Discovery | Servicio abierto documentado, con OAuth2 y permisos de catálogo por instancia. No equivale a acceso abierto al catálogo completo de edx.org ni otorga derechos sobre sus contenidos | Extensión posible con una institución que autorice acceso. Coste, cuotas y condiciones de la instancia no verificados; no se integra |
| Udemy Business | Una referencia histórica accesible, de 2018, describe catálogo por portal y credenciales de cliente; no acredita el contrato vigente | El soporte actual redirigió a una página que no cargó contenido verificable. No se pudo verificar el contrato comercial vigente, precio ni cuotas; no se selecciona ni implementa |

Fuentes oficiales: [Learn: disponibilidad y uso de metadatos](https://learn.microsoft.com/en-us/training/support/integrations-learn-platform-api-catalog), [Learn: autenticación y cuotas](https://learn.microsoft.com/en-us/training/support/integrations-learn-platform-api-get-started), [Brave: precios](https://api-dashboard.search.brave.com/app/plans), [Brave: términos, sección 3](https://api-dashboard.search.brave.com/documentation/resources/terms-of-service), [Open edX: OAuth2 y catálogos](https://github.com/openedx/course-discovery/blob/master/docs/advanced.rst), [Udemy: referencia de API](https://s3.amazonaws.com/udemy-images/support/Udemy_for_Business_API_Reference_v2.0.pdf) y [soporte actual no accesible en esta revisión](https://business-support.udemy.com/hc/en-us/sections/4419908023959-Account-Settings).

Las cifras son una lectura de documentación, no una oferta contractual para CVExpert. [Los términos Microsoft](https://learn.microsoft.com/en-us/legal/microsoft-apis/terms-of-use) limitan copia/almacenamiento al escenario autorizado y prohíben determinados usos y redistribución. La persona responsable debe aprobar conservación, atribución, retención y publicación antes de realizar consultas reales. Un indicador local no sustituye esa aprobación. No se descargan contenidos de cursos, imágenes ni HTML.

## Patrón y componentes

Se revisaron en Ofertas, rama `main` (no existe `develop` consultable), [ExternalJobSource](https://github.com/SoftwareDesignTEC/cvexpert-ms-ofertas-postulaciones/blob/main/src/main/java/com/cvexpert/ofertas/domain/port/out/ExternalJobSource.java), [JSearchJobSource](https://github.com/SoftwareDesignTEC/cvexpert-ms-ofertas-postulaciones/blob/main/src/main/java/com/cvexpert/ofertas/adapter/out/jobsource/JSearchJobSource.java), [JobImportService](https://github.com/SoftwareDesignTEC/cvexpert-ms-ofertas-postulaciones/blob/main/src/main/java/com/cvexpert/ofertas/application/JobImportService.java) y [JobImportConfig](https://github.com/SoftwareDesignTEC/cvexpert-ms-ofertas-postulaciones/blob/main/src/main/java/com/cvexpert/ofertas/config/JobImportConfig.java). Se adapta la separación entre puerto, transporte/conversión, coordinación y configuración. No se copia Java ni su upsert, retirada de demos, procesamiento de usuarios o eventos. No se modifica Ofertas.

| Archivo | Responsabilidad |
| --- | --- |
| `scripts/course-discovery/model.ts` | Puerto `CourseDiscoveryProvider`, candidato, configuración validada, normalización y deduplicación pura |
| `scripts/course-discovery/learn-provider.ts` | Adaptador Learn con `fetch`, token y reloj sustituibles en pruebas; petición acotada y conversión de metadatos |
| `scripts/course-discovery/service.ts` | Consultas configuradas, caché, cuotas, backoff, consolidación y tick programable |
| `scripts/course-discovery/store.ts` | Propuestas/estado local, lock exclusivo, escritura atómica y lectura JSON limitada |
| `scripts/discover-courses.ts` | CLI exclusivamente dry-run, autorización explícita del modo real y fixture predeterminado |

Todo queda en mantenimiento, fuera de `src` y del ZIP de producción existente. No se importa desde `app.ts` o `server.ts`, no se inicia al arrancar y no se instala cron/workflow. El puerto y el coordinador aceptan un tipo de consulta por proveedor, con `skill` como único campo común; otro proveedor no necesita adoptar productos/temas de Learn. Cada adaptador añadirá su parser de configuración y composición CLI y reservará permiso mediante `beforeRequest` antes de cada intento HTTP; sus datos deberán convertirse al candidato y superar sus propias reglas de URL/procedencia.

## Contrato del adaptador Learn y límites de lo comprobado

Se utiliza únicamente `GET https://learn.microsoft.com/api/v1/modules`, `api-version=2023-11-01-preview`, con `products`, `subjects`, `locale` y `maxpagesize`. La [referencia oficial](https://learn.microsoft.com/en-us/training/support/integrations-learn-platform-api-catalog-endpoints-developer-reference) documenta esos filtros y campos del módulo. El [quickstart](https://learn.microsoft.com/en-us/training/support/integrations-learn-platform-api-catalog-quickstart) muestra las rutas v1 y Bearer Entra. No se usa el catálogo anónimo antiguo ni un buscador privado. La versión documentada sigue siendo preview: hay que revisar soporte/cambios antes de habilitarla.

No se inventa un parámetro `q` para esta API. Cada habilidad canónica se vincula en configuración a productos/temas identificados por el proveedor; hay que verificar sus IDs y su pertinencia. Se comprueba que el módulo devuelto respalde los filtros mediante sus tags. Esto es una señal de clasificación, no una certificación de que enseña la habilidad. Un título que la menciona no basta: toda asociación queda pendiente de revisión del resumen/temario oficial. No hay sinónimos ni catálogo especulativo de tecnologías incorporado.

Los fixtures fijan el sobre paginado como `{ "value": [...], "nextLink": null }`. La documentación accesible describe los registros y `nextLink`, pero no permitió comprobar una respuesta autenticada real ni confirmar ese sobre contra una identidad del proyecto. Antes de activar el modo real debe realizarse una prueba de contrato autorizada y saneada, ajustando el adaptador si difiere; una forma no reconocida produce `INVALID_RESPONSE`, nunca éxito vacío. No se presenta el fixture como captura del proveedor.

Se siguen únicamente nextLinks del mismo origen y ruta v1 permitidos, sin redirecciones, con detección de ciclos y número máximo de páginas. El cursor no se inventa ni se conserva en evidencia; esta registra el endpoint/filtros iniciales y el hash de cada respuesta. `truncated: true` indica que había más páginas: no implica cobertura completa del catálogo. Esta primera fase vuelve al inicio en cada actualización; una sincronización exhaustiva requerirá checkpoints revisados.

El token se inyecta mediante una función sustituible. La CLI acepta `LEARN_ACCESS_TOKEN` en su entorno, obtenido previamente por una identidad autorizada; no ejecuta Azure CLI, no adquiere ni renueva tokens automáticamente y no valida Google. No acepta tokens como argumento ni carga `.env`. Una futura identidad administrada podrá implementar esa función, conservando scope, timeout y permisos mínimos, después de aprobación de infraestructura.

## Modelo y revisión

El candidato contiene título, plataforma, URL original, clave URL canónica segura, fuente, ID externo nullable, habilidades propuestas y fecha de consulta. También idioma nullable, niveles publicados, duración en minutos nullable, `isPaid` nullable y evidencia: endpoint sin token, hash SHA-256, resumen y tags disponibles, título/URL devueltos y metadatos observados. La fecha del fixture es fija para reproducibilidad y no representa una consulta real.

El adaptador actual deja siempre `isPaid: null`: el contrato de módulo usado no prueba precio. No deduce gratuidad por plataforma, ausencia de precio o apariencia del enlace. No redondea minutos a horas ni convierte desconocidos en cero. `needs_review` exige revisar habilidad enseñada, modalidad de pago, fuente y permiso editorial. `conflict` retiene discrepancias entre observaciones o una URL coincidente con un snapshot local del catálogo. No existe un estado aprobado que pueda conceder el proveedor.

La deduplicación usa ID por fuente o URL segura, fusiona asociaciones y conserva observaciones contradictorias. Solo se normalizan host/default port con WHATWG URL; se preservan URL original y evidencia. No se quitan barras finales, locale ni parámetros para evitar conflictos. Esta fase rechaza query, fragmentos, userinfo, codificación ambigua, puertos alternativos y enlaces fuera de módulos oficiales. No sigue URLs de candidatos. Un enlace rechazado requiere revisión, no una corrección automática.

Los nombres canónicos se preservan. Se reutiliza el normalizador del evaluador solo para comparar claves: espacios, mayúsculas y acentos previstos; `Python`, `Python 3`, `Java`, `JavaScript`, `C` y `C++` siguen siendo distintos cuando corresponde. Dos nombres configurados con la misma clave se rechazan como ambiguos. Las reglas administrativas de nombres y el snapshot opcional se validan mediante `parseCatalogDocument` existente. No se flexibiliza el formato v1.

## Ejecución offline

Requiere Node.js 24 y dependencias fijadas con `npm ci`. Desde la raíz del repositorio:

```sh
npm run build
npm test
npm run courses:discover -- --dry-run --fixture
npm run courses:discover -- --dry-run --fixture --skill " python "
```

El fixture es ficticio, incluida la URL bajo Learn y los tags `test-product-python`; no se afirmó que esa página exista. Se guarda fuera de Git en `local-catalog-input/discovery/latest-fixture.json`, con candidatos y evidencia embebida, `dataSource: deterministic_test_fixture`, `publicationApproved: false` y `databaseAccess: false`. No es un lote de importación JSON v1. No importar fixtures ni convertirlos en cursos reales. Una segunda ejecución utiliza la caché y devuelve los mismos candidatos, sin llamadas HTTP.

Opciones: `--config <JSON>`, `--skill <nombre configurado>`, `--catalog <snapshot JSON v1 revisado>`, `--scheduled`, `--fixture`, `--live` y `--dry-run`. Opciones desconocidas/repetidas y `--apply` se rechazan. Sin `--live` siempre se usa el fixture. El snapshot solo se lee para señalar coincidencias de URL; no prueba el contenido actual de PostgreSQL ni se modifica.

Una configuración real se guarda localmente bajo la carpeta ignorada, con los nombres canónicos y tags verificados. Ejemplo de estructura **no ejecutable como configuración aprobada**:

```json
{
  "enabled": false,
  "locale": "en-us",
  "queries": [{"skill": "NOMBRE_CANÓNICO_REVISADO", "products": ["id-verificado-del-proveedor"], "subjects": []}]
}
```

Tras autorización de identidad y almacenamiento, el responsable podrá revisar `enabled: true`, suministrar el token al entorno del proceso sin registrarlo y declarar `COURSE_DISCOVERY_STORAGE_APPROVED=true` como confirmación operativa. Solo entonces se admitiría `npm run courses:discover -- --dry-run --live --config local-catalog-input/discovery-config.json`. No se ha ejecutado ese comando. El flag no firma ni acredita una autorización, no habilita importaciones y no autoriza automáticamente publicar metadatos. Producción y contexto App Service se rechazan: esta CLI sigue siendo local.

## Actualización programable, caché y fallos

`--scheduled` ejecuta un tick: si está desactivado devuelve `disabled`; antes del siguiente intervalo, `not_due`. No duerme durante horas ni instala un proceso residente. El responsable podría invocarlo con un scheduler de mantenimiento autorizado más adelante. El intervalo predeterminado es 24 horas y la caché dura seis horas. Microsoft recomienda [actualización diaria de los datos utilizados](https://learn.microsoft.com/en-us/training/support/integrations-learn-platform-api-catalog-best-practices); una futura publicación deberá cumplirlo y tratar bajas/cambios sin borrados por fallos temporales.

| Control | Predeterminado | Rango |
| --- | --- | --- |
| `enabled` | false | booleano explícito |
| `intervalHours` | 24 | 1–168, para propuestas; revisar frecuencia antes de publicación |
| `cacheHours` | 6 | 1–24 |
| `timeoutMs` | 10000 | 10–30000; incluye token, transporte y lectura, después del permiso de cuota |
| `maxRequestsPerRun` | 10 | 1–30 |
| `maxRequestsPerDay` | 30 | 1–100, día UTC por cada intento reservado |
| `minRequestIntervalMs` | 2000 | 2000–60000 |
| `maxPages` | 2 | 1–5 |
| `pageSize` | 20 | 1–100 |
| Consultas configuradas | explícitas | 1–20; hasta diez tags por filtro |

La documentación de Learn fija por defecto 100 llamadas/minuto en una ventana de cinco minutos, por `oid`; estos presupuestos locales son más conservadores y no sustituyen la cuota compartida por otros consumidores de esa identidad. Cada página consume permiso, incluido un intento fallido. El contador se persiste antes de red y no se reinicia al cambiar filtros. Un lock evita procesos simultáneos en el mismo directorio; varias máquinas exigirán coordinación distribuida antes de automatizar.

Estado y propuestas de fixture/real están separados (`fixture-state.json`, `live-state.json`, `latest-fixture.json`, `latest-live.json`). JSON de entrada hasta 1 MiB, sin claves repetidas; respuesta hasta 1 MiB; estado/informe hasta 16 MiB y hasta veinte entradas de caché. Archivo inválido o lock abandonado requiere intervención: no se borra para resetear cuotas. Los archivos locales de caché son mantenimiento confiable, no entradas HTTP; proteger acceso y definir retención antes del modo real.

No hay reintento inmediato. `429` conserva `Retry-After` y bloquea ticks posteriores; `5xx` aplica al menos cinco minutos de espera. Fallos de autenticación/cuota detienen las consultas restantes. JSON/HTTP/red/timeout tienen códigos seguros; no se registran respuestas ni credenciales. Se preserva la última caché válida al fallar, pero no se presenta como dato fresco. `partial_failure` y `provider_backoff` producen salida CLI 1; un catálogo externo vacío con respuesta válida es un resultado distinto. Los registros descartados y el truncamiento se informan por consulta. Un fallo de disco impide la llamada externa y nunca provoca escrituras SQL.

## Paso posterior a sincronización autorizada

1. Responsables de infraestructura/legal: revisar términos y uso previsto, onboarding Entra, acceso, retención/atribución y obtención/renovación segura del token. Validar contrato real, taxonomía y versión preview mediante prueba autorizada sin CVs ni usuarios.
2. Revisión editorial: confirmar temario por habilidad y precio verificable, evidencia/fecha de vigencia, idiomas y duración. Las asociaciones propuestas no son competencias certificadas ni decisiones de contratación.
3. Mantener staging y publicación separados. Para producción serán necesarios registros durables de fuente/ID, observaciones, versión, aprobación, correspondencia con course_id y estado de sincronización, con unicidad por fuente/ID y auditoría. El esquema actual no conserva toda esa procedencia; diseñar y aprobar una nueva migración aditiva cuando se acuerde el proceso, sin modificar migraciones existentes. No se necesita ninguna migración para este dry-run local.
4. Cuando `isPaid` esté resuelto y aprobado, construir un lote v1 separado y pasar el parser existente. Una duración de 45 minutos no se redondea a una hora: el importador actual exige horas enteras o null; conservar minutos/evidencia en staging y acordar representación futura o usar null sin inventar precisión.
5. Planificar contra el catálogo real con permisos administrativos autorizados y resolver conflictos por URL/título/plataforma/precio/asociaciones. La CLI de catálogo actual solo admite loopback; el procedimiento administrativo conjunto requiere también insumos de mercado. No usarlo automáticamente ni inventar mercado para cargar estos cursos: aprobar una vía administrativa de catálogo apropiada. Ningún descubrimiento debe sobrescribir manualmente cursos aprobados ni alterar URLs para saltarse conflictos.
6. Antes de un scheduler real, añadir coordinación global de cuotas/locks, checkpoints para recorridos completos, retención, observabilidad saneada, reconciliación de cambios/bajas y política editorial de actualización. Un fallo externo no elimina cursos existentes ni detiene los endpoints HTTP.

Lo implementado automatiza la búsqueda y preparación de candidatos. La alimentación del catálogo publicado sigue requiriendo autenticación efectiva, validación de pertinencia/precio, autorización editorial y un procedimiento de publicación aprobado. Los lectores `/courses` y `/skills-gap/recommendations` seguirán consultando únicamente sus tablas actuales; `/skills-gap/evaluate` permanecerá puro e independiente de proveedores.

## Validación y evidencia de esta entrega

Las pruebas cubren HTTP correcto e incompleto, JSON/HTML inválidos y tamaño excesivo, 429/5xx/401, timeout de token/transporte/body, paginación segura, deduplicación/conflictos, diferencias entre tecnologías, caché, cuotas UTC, persistencia fallida, programación apagada, falta de credenciales, parser CLI y preservación del catálogo anterior. Son fixtures y dobles; no verifican disponibilidad, onboarding ni resultados reales del proveedor.

El primer intento de prueba del almacén falló en el sandbox Windows al reemplazar atómicamente un archivo temporal (`EPERM`). La misma prueba pasó fuera de esa restricción sin cambiar el mecanismo atómico. Con Node 24 se ejecutaron `npm run build` y `npm test`: 83 pruebas aprobadas, incluidas 19 nuevas, sin fallos ni omisiones. El dry-run fixture produjo un candidato ficticio con evidencia; una segunda ejecución reutilizó caché y el tick predeterminado devolvió `disabled`. No se ejecutó `db:test`: el motor Docker local no estaba disponible y el cambio no añade acceso PostgreSQL. No se usaron credenciales reales ni bases compartidas; las regresiones HTTP y de catálogo del suite `npm test` sí se ejecutaron.
