# Flujo HTTP de análisis de brechas

Implementado en backend, pendiente de ratificación del contrato y activación operativa.
Este cambio no despliega, no modifica APIM, no sustituye sus mocks y no modifica Web/Android.
La propuesta `skills-gap-input.proposed.yaml` se conserva como antecedente no aprobado;
el comportamiento implementado está en `openapi.yaml` 0.2.0.

## Decisiones e incompatibilidades revisables

| Antes / propuesta | Implementación de este PR | Aprobación pendiente antes de activar |
| --- | --- | --- |
| Propuesta: cliente envía marketKey, scaleKey y enteros | PUT solo recibe skills con niveles textuales o null; servidor fija escala y contexto | Ratificar entrada y aceptación de autoevaluaciones |
| Demo: niveles 40/80; Web mostraba porcentajes según evidencia histórica | beginner=1, intermediate=2, advanced=3, expert=4 bajo cv-skill-v1 | Validar presentación ordinal en Web/Android; nunca presentar porcentaje |
| CourseSuggestion.durationHours entero obligatorio | Campo sigue presente, admite null; no se fabrica cero ni se ocultan cursos | Android históricamente usa Int no nullable; coordinar compatibilidad antes de activar |
| GET solo demo/503 | GET calcula con instantánea autenticada y mercado local; 401/409 y cobertura explícita | Ratificar errores y metadatos nuevos |
| GET ignoraba parámetros desconocidos | Rechaza todo parámetro distinto de page/pageSize con 400 | Ratificar rechazo explícito de controles de identidad/escala/contexto |
| Sin almacenamiento privado | Una instantánea vigente por identidad seudonimizada, sin historial | Definir retención, borrado al cerrar cuenta y consentimiento/autoevaluación |

Ninguna decisión del borrador se considera aprobada por existir en ese archivo.
El objetivo solicitado autoriza desarrollar este flujo para revisión; no certifica el
contrato con consumidores ni la seguridad desplegada. No hay sincronización automática
con CVs ni afirmación de que las habilidades aportadas sean un CV verificado.

## Seguridad e identidad

El guard existente sigue validando DER/Base64, vigencia y huellas autorizadas APIM.
Solo tras validarlo marca la petición como verificada. Las dos rutas requieren esa
marca y un único X-User-Id no vacío (máximo 512 unidades UTF-16, sin espacios, comas
ni controles). Falta/ambigüedad devuelve 401. X-User-Email no se usa ni persiste.
El bypass local existente del catálogo no sirve para este flujo, incluso con headers.
PUT rechaza userId y todas las propiedades adicionales; GET rechaza controles de
identidad en query. Ningún dato del cuerpo elige la identidad persistida.

El encabezado X-ARR-ClientCert por sí solo fuera de la infraestructura confiable no
prueba posesión de clave privada: antes de activar se debe demostrar que App Service
exige mTLS, APIM valida al usuario y sobrescribe identidad, y el acceso directo y la
suplantación de encabezados reenviados están bloqueados. Las pruebas locales usan
certificados públicos de fixture; no prueban una negociación TLS real de Azure.

Se guarda SHA-256 de `skills-gap:subject:v1` + byte NUL + identidad APIM exacta.
Es seudonimización determinista para aislar filas, no anonimización ni autorización
por hash. El hash y las habilidades siguen siendo datos del usuario; la base necesita
controles de acceso. No se almacenan correo, nombre, CV, tokens, ID original ni historial.
No hay normalización de identidad: APIM debe emitir un identificador estable y global.

## PUT /skills-gap/input

```json
{"skills":[{"skillName":"SQL","level":"beginner"},{"skillName":"TypeScript","level":null}]}
```

Devuelve 204 tras UPSERT de la instantánea completa en una sola sentencia. La misma
entrada produce el mismo estado; escrituras concurrentes se serializan por PK y vence
la última escritura efectiva en PostgreSQL, sin merge parcial. No hay control de versión
optimista. `skills: []` conserva una instantánea vacía; no asigna nivel cero ni borra
una cuenta. Nombres exactos, sin recorte ni normalización/sinónimos, máximo 200 unidades
UTF-16 por nombre y 500 habilidades. No crea filas en el catálogo de skills.
Se rechazan duplicados idénticos y contradictorios, niveles numéricos, texto desconocido,
propiedades adicionales y NUL con 400. Solo null representa nivel desconocido; una
etiqueta nueva exige evolucionar el adaptador y su versión. JSON tiene límite 100 KiB;
malformado devuelve 400 y exceso de bytes 413. Una escritura fallida devuelve 503 y
conserva el estado previo. Los errores no publican SQL ni mensajes del driver.

## GET /skills-gap?page=1&pageSize=20

La escala se resuelve en código (`cv-skill-v1`, posiciones 1–4). El mantenedor configura
`SKILLS_GAP_MARKET_KEY` como clave exacta de un contexto revisado, sin default inventado.
El cliente no selecciona escala ni contexto. Sin configuración válida: 503; sin fila
de instantánea del usuario: 409 SKILLS_INPUT_REQUIRED. La falta de identidad se resuelve
antes de estas comprobaciones. La lectura de usuario es atómica; mercado/cursos se leen
con el SELECT consistente existente. Son lecturas separadas, sin prometer una transacción
común ni snapshot estable entre páginas o cambios concurrentes.

Se reutilizan `createSkillsGapAnalysisService` y `analyzeSkillsGap`, sin otro motor.
Se conserva `items`, `page`, `pageSize`, `totalRecords`: defaults 1/20, page entero seguro
positivo, pageSize 1–100; página fuera de rango devuelve 200 con items vacío y total.
El total cuenta brechas calculables antes de paginar. Orden por déficit ordinal descendente
y nombre exacto; los cursos se asignan globalmente una vez antes de paginar. IDs públicos
son cadenas decimales del ID SQL; deben tratarse como opacos. Se añaden deficitSteps y
metadatos analysis; cursos incluyen isPaid y skills del catálogo.

```json
{
  "items": [], "page": 1, "pageSize": 20, "totalRecords": 0,
  "analysis": {
    "status": "incomplete", "comparedSkills": 0,
    "scaleKey": "cv-skill-v1", "marketStatus": "missing",
    "unresolved": [{"skillName":"SQL","reason":"MISSING_MARKET_REQUIREMENT","userLevel":1,"marketLevel":null}]
  }
}
```

Este ejemplo expresa ausencia de mercado, no satisfacción de requisitos.
`marketStatus=available` solo indica existencia de filas; no garantiza comparabilidad.
`status=empty` significa ambos conjuntos vacíos; `incomplete`, alguna habilidad sin comparar;
`complete`, todos los nombres recibidos comparables. Se conserva el estado del motor,
con marketStatus para desambiguar la falta total de mercado incluso con entrada vacía.
`unresolved` cubre todo el análisis y no se pagina. Sus razones son MISSING_USER_SKILL,
MISSING_MARKET_REQUIREMENT, UNKNOWN_LEVEL, UNKNOWN_SCALE, SCALE_MISMATCH. Ausente no es cero.
No se compara un requisito con otra escala ni se le asigna escala implícita. Requisitos
demo o datos inválidos fallan cerrados con 503, sin recomendaciones ficticias.

Brechas sin cursos conservan `courses: []`. Cursos por asociación exacta no demuestran
que enseñen el nivel exigido ni su calidad o eficacia. Duración null sigue siendo
 desconocida; cero es una duración registrada distinta. Respuestas sin caché;
X-Data-Mode: reference indica lectura persistente, no completitud ni vigencia de mercado.

## Migración y permisos

`003_create_user_skill_snapshots.sql` es aditiva, vacía y transaccional mediante el runner
existente, sin modificar 001/002, cargar datos, conceder permisos o ejecutarse al arrancar.
PK subject_hash evita duplicados y permite UPSERT atómico sin secuencias. JSONB guarda
solo las habilidades ordinales validadas y su clave; adapter_key restringe esta versión.
La base impone tipo/tamaño de arreglo; validación de nombres, niveles y duplicados está
en el adaptador HTTP. El rol mantenedor sigue separado del HTTP. Tras migrar una base
local de desarrollo como mantenedor, conceder únicamente:

```sql
GRANT USAGE ON SCHEMA public TO cvexpert_brecha_app;
GRANT SELECT ON public.skills, public.courses, public.course_skills,
  public.market_requirements TO cvexpert_brecha_app;
GRANT SELECT, INSERT, UPDATE ON public.user_skill_snapshots TO cvexpert_brecha_app;
```

No necesita DELETE, secuencias, DML de catálogo/mercado, DDL, permisos administrativos ni
acceso al historial de migraciones. Aislamiento por usuario en consultas parametrizadas
del backend; no hay RLS por usuario PostgreSQL ni permiso para acceder directamente a la
base desde clientes. El operador debe definir el borrado por cuenta/retención antes de
producción, usando mantenimiento autorizado; no se añade una política ficticia ni un job.
Rollback operativo: detener exposición del flujo; no borrar automáticamente las filas
ni revertir migraciones históricas. Cualquier eliminación requiere revisión de datos.

## Validación y activación pendiente

`npm run build`, `npm test`, `npm run db:test` con PostgreSQL 17 local desechable.
La suite DB existente crea bases cvexpert_test_UUID, aplica migraciones y prueba también
permisos SELECT sobre catálogo/mercado, SELECT/INSERT/UPDATE solo en instantáneas,
concurrencia, idempotencia, aislamiento HTTP, falta de mercado, paginación y fallos reales
por revocación de permisos. Unitarias/HTTP cubren adapter, duplicados, identidad ausente,
certificados, bypass denegado, null, escalas incompatibles, consultas inválidas y errores
sin secretos. Los fixtures son exclusivamente de pruebas; no son cursos operativos.

Para activar en producción falta explícitamente:

1. Ratificar contrato 0.2.0, niveles ordinales, autoevaluaciones, nulabilidad y estados;
   validar los consumidores Web/Android y coordinar su compatibilidad fuera de este PR.
2. Acordar contexto, fuentes, nombres canónicos, escala cv-skill-v1, revisión, vigencia y
   actualización de requisitos reales. No hay requisitos productivos disponibles hoy.
3. Cargar y revisar cursos reales y asociaciones mediante mantenimiento autorizado;
   no existe catálogo productivo suficiente hoy y no se genera en este PR.
4. Aprobar retención, privacidad y borrado de instantáneas/cuentas, límites y volumen
   esperado. La aplicación conserva solo el último estado, sin borrado automático.
5. Aplicar 003 por el procedimiento administrativo aprobado, configurar conexión TLS
   y permisos mínimos. Este PR solo ejecuta migraciones en bases locales desechables.
6. Configurar el contexto del servidor y validar la frontera real APIM/mTLS, identidad
   sobrescrita, bloqueo de acceso directo y pruebas de aislamiento a través del gateway.
7. En un cambio autorizado separado, coordinar rutas y sustitución de mocks APIM y
   despliegue del backend. Este PR hacia develop no activa ni modifica Azure/APIM.
