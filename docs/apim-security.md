# Certificado APIM y preparación del despliegue public-mtls

## Estado y alcance

El middleware protege negocio, Swagger (`/docs/` y recursos) y OpenAPI
(`/openapi.yaml`, `/openapi.json`). `/health` conserva su respuesta independiente.
La aplicación lee Base64 DER canónico de `X-ARR-ClientCert`, lo interpreta con
`node:crypto.X509Certificate`, rechaza datos sobrantes, verifica vigencia y
compara la huella SHA-1 con `APIM_CERT_THUMBPRINTS`. SHA-1 se usa como identificador
del certificado fijado, no como algoritmo para firmar nuevos certificados.
No se valida una PKI arbitraria ni revocación OCSP/CRL: la confianza es la lista
explícita de certificados. Ante compromiso se debe retirar la huella y rotar.

Se admiten varias huellas de 40 dígitos hexadecimales sin `:`, separadas por comas,
con espacios alrededor y sin distinguir mayúsculas. Una entrada vacía o inválida
invalida toda la configuración. Sin configuración válida se devuelve 503
`APIM_SECURITY_UNAVAILABLE`; con certificado no autorizado, 403
`APIM_CERTIFICATE_REQUIRED`. No se revelan certificados ni errores criptográficos.
Dentro de Express, salud responde aunque falte configuración de seguridad;
esto no elimina el requisito de certificado en el frontend TLS de Azure.

Para desarrollo/pruebas locales se requiere explícitamente
`APIM_ALLOW_INSECURE_LOCAL=true` junto con `NODE_ENV=development` o `test`.
El punto de entrada `src/server.ts` comparte esa decisión con el middleware y,
cuando el bypass está activo, escucha únicamente en `127.0.0.1`. No se puede
ampliar la escucha mediante una variable HOST. Las pruebas arrancan el servidor
real y comprueban su socket, las respuestas HTTP y el rechazo desde otra
interfaz IPv4 cuando está disponible.
Se ignora el bypass en producción, entornos desconocidos o cuando existe una
variable `WEBSITE_*` de App Service. No configurar Azure como entorno de demo.
Los tests de seguridad usan certificados X.509 públicos independientes; las
claves privadas se descartaron. Ningún certificado real del equipo está incluido.

## Frontera de confianza TLS

La validación del encabezado solo es segura si App Service exige certificados
cliente y establece `X-ARR-ClientCert` desde la conexión TLS. Un certificado
público se puede copiar: el middleware HTTP no prueba posesión de la clave.
No exponer el proceso Node directamente ni situarlo detrás de un proxy que
acepte ese encabezado del cliente sin autenticarlo. Microsoft documenta que
[App Service termina TLS y reenvía el certificado para validarlo en la aplicación](https://learn.microsoft.com/en-us/azure/app-service/app-service-web-configure-tls-mutual-auth).

## Modelo aprobado y validaciones automatizadas

A1 prepara un PR local hacia develop: no despliega ni configura Azure, APIM o
variables remotas. La infraestructura compartida de Gabriel se conserva.
La decisión aprobada aplica únicamente a este backend: endpoint HTTPS público
con certificado cliente obligatorio en App Service y validación X.509/huella en
Node. Accesibilidad de red no equivale a autorización de negocio.

El preflight recibe `AZURE_BACKEND_NETWORK_MODEL` desde la variable de GitHub
Actions `vars.AZURE_BACKEND_NETWORK_MODEL` del job con environment
`azure-production`. Configurar allí `public-mtls` cuando corresponda, sin
habilitar `ENABLE_AZURE_DEPLOY`. No es un App Setting del backend.

- Variable ausente o cadena vacía (Actions representa así una variable sin
  definir): exige `publicNetworkAccess=Disabled`, como antes.
- Valor exacto `public-mtls`: exige `publicNetworkAccess=Enabled` y todos los
  controles públicos siguientes. Un backend privado no pasa en este modo.
- Cualquier otro valor, incluso espacios o diferencias de mayúsculas: falla.
  Nunca se deduce el modo de la configuración de Azure.

En ambos modelos se conservan destino `cvexpert-ms-brecha-cursos` en
`rg-cvexpert` (grupo sin distinguir mayúsculas), Linux, `httpsOnly=true`, TLS de
aplicación y SCM `1.2` o `1.3`, runtime exacto `NODE|24-lts` y startup explícito
`npm start` o `node dist/server.js`. Se exige `NODE_ENV=production`,
`SCM_DO_BUILD_DURING_DEPLOYMENT=false`, `ENABLE_ORYX_BUILD=false`, autenticación
básica SCM/FTP deshabilitada, identidad administrada de ejecución con principal
UUID válido y principal OIDC diferente de todas las identidades declaradas
(system y user-assigned). Las identidades incompletas fallan.
`APIM_ALLOW_INSECURE_LOCAL` debe estar ausente o ser exactamente `false`;
valores ambiguos se rechazan aunque el middleware ya ignore el bypass en Azure.

Además, `public-mtls` exige:

- `clientCertEnabled=true` y `clientCertMode=Required`.
- `clientCertExclusionPaths` ausente, `null` o cadena vacía. Se rechazan
  `/health`, espacios y cualquier otro valor. Toda excepción requiere otra
  decisión de diseño; este PR no abre rutas.
- `APIM_CERT_THUMBPRINTS` presente y completo: entradas de 40 caracteres
  hexadecimales sin dos puntos, separadas por coma, normalizadas igual que el
  middleware. Una entrada inválida o vacía rechaza toda la lista.

Las consultas son de solo lectura y seleccionan propiedades necesarias, cinco
App Settings de seguridad/build y los booleanos de las políticas SCM/FTP.
No se imprimen App Settings, certificados, tokens ni respuestas de Azure.
Errores de CLI/JSON y datos incompletos fallan; no se continúa al despliegue.
El token Entra permanece en memoria para extraer el oid de la sesión OIDC.
El preflight valida configuración declarada, no posesión de claves, vigencia del
certificado APIM, políticas del gateway ni autenticación TLS real.

## Configuración manual pendiente en Azure y APIM

Antes de cualquier despliegue autorizado, un responsable debe comprobar el estado
actual y aplicar los controles anteriores exclusivamente en este App Service.
La observación histórica (certificados deshabilitados y startup vacío) no cumple
el preflight y no constituye evidencia actual.

Verificar que el plan App Service soporte certificados cliente. Confirmar el
certificado `cvexpert-client-cert` en APIM `gabriel-api-management`, su vigencia,
clave disponible para APIM y huella documentada
`FDF119D5BE797DD62E6CC87002C183CC6E70274B` antes de autorizarla en App Settings.
El preflight valida el formato de la lista, no su coincidencia con APIM.
No copiar claves privadas o contraseñas al repositorio.

Revisar con Gabriel las políticas existentes y su alcance efectivo:
`authentication-certificate` debe referenciar el certificado backend; APIM debe
autenticar al consumidor y sobrescribir `X-User-Id` y `X-User-Email`.
Confirmar destino HTTPS, validación del certificado servidor y mapeos del gateway
`https://gabriel-api-management.azure-api.net/api/v1`. La identidad de usuario
sigue siendo responsabilidad del gateway. Este preflight no consulta APIM.

## Salud sin exclusiones

`GET /health` conserva `200` y
`{"status":"ok","service":"brecha-cursos"}` cuando la petición alcanza Express.
Está antes del middleware: no verifica huella ni PostgreSQL. Con Required y
sin exclusiones, una petición externa sin certificado no debe alcanzar ese
handler; Azure puede rechazarla antes de obtener JSON de Node.
Un certificado ajeno podría alcanzar salud si Azure lo admite: el rechazo de
huella de la aplicación se aplica a negocio y documentación, no a `/health`.
Salud no prueba autorización de APIM ni disponibilidad de BD.

Para medir disponibilidad externa, confirmar o preparar en una tarea posterior
el mapeo APIM hacia `/health`, usando certificado backend y autenticación del
gateway. Probar la ruta efectiva; no dar por existente `/api/v1/health`.
Complementar con una petición autenticada a negocio para probar huella y BD.

Revisar por separado App Service Health Check, Always On (históricamente apagado),
sondas de arranque/warm-up, swaps de slots y pruebas de disponibilidad de Azure
Monitor/Application Insights. Las sondas internas pueden seguir rutas diferentes:
verificar comportamiento real con Required, logs, plan y réplicas antes de depender
de ellas. Un monitor HTTP externo sin certificado no podrá medir esta URL
directamente. No crear exclusiones automáticas para resolver sondas fallidas.
[Health Check de App Service](https://learn.microsoft.com/en-us/azure/app-service/monitor-instances-health-check)
describe el mecanismo, no demuestra esta instalación.

Sin exclusiones ni modo Optional Interactive User se evita la renegociación
provocada por esas opciones, su incompatibilidad con TLS 1.3/HTTP/2 y el límite
de 100 KB asociado a renegociación. Esto no garantiza límites o protocolos
end-to-end del gateway: comprobarlos tras desplegar según la
[documentación mTLS de App Service](https://learn.microsoft.com/en-us/azure/app-service/app-service-web-configure-tls-mutual-auth).

La UI Swagger sirve todos sus recursos localmente y desactiva el validador
remoto. Para abrirla mediante APIM se deben mapear también `/docs/*` y
`/openapi.json`, manteniendo un prefijo coherente. La autenticación del navegador
ante APIM debe estar resuelta; no introducir certificados reenviados en la UI.
La interfaz describe el backend, no declara rutas públicas confirmadas.

OpenAPI mantiene la versión 3.0 y sus esquemas funcionales. Esa versión no
incluye un esquema de seguridad mTLS, por lo que el transporte se documenta en
`x-backend-authentication`, sin representar `X-ARR-ClientCert` como API key ni
ofrecerlo en el formulario de autorización de Swagger. Es un encabezado interno
reenviado por App Service; el consumidor no debe introducirlo manualmente.
`x-apim-user-authentication` describe la frontera consumidor–APIM: la política
del gateway valida al usuario y sobrescribe su identidad. El backend no verifica
tokens Google ni otros JWT. La ausencia de `securitySchemes` en este contrato
interno no autoriza acceso anónimo: siguen vigentes mTLS y la validación de huella.
Ver [Security Scheme Object de OpenAPI 3.0.3](https://spec.openapis.org/oas/v3.0.3.html#security-scheme-object).

## Riesgos residuales y rotación

Consumption necesita alcanzar este backend público; no se implementa aislamiento
privado. Revisar la [matriz de redes APIM](https://learn.microsoft.com/en-us/azure/api-management/virtual-network-concepts)
si se migra al modelo privado. No usar una IP observada de Consumption como
identidad. El endpoint público mantiene exposición a tráfico hostil y consumo
de recursos; mTLS no sustituye límites, monitoreo ni protección administrativa.

Un certificado compartido identifica a cualquier poseedor de su clave, no
exclusivamente a esta instancia APIM. Otro poseedor autorizado por huella podría
llamar directamente y falsificar identidad HTTP. Para exclusividad se necesita
certificado dedicado, custodia y permisos restringidos sobre certificados y
políticas. No hay revocación OCSP/CRL ni validación JWT del usuario en Node.

Rotación planificada: verificar certificado nuevo, vigencia y custodia fuera del
repositorio; agregar su huella junto a la anterior sin entradas vacías; cambiar
la referencia efectiva en APIM, probar negocio y retirar la huella anterior.
Volver a probar que el certificado retirado falla. Acotar coexistencia y registrar
responsables/fechas. Ante compromiso retirar la huella comprometida mediante un
cambio autorizado, evaluando impacto en otros servicios que compartan certificado.
Ningún paso se ejecuta en A1.

## Evidencia real requerida y condiciones antes de activar CD

| Capa | Evidencia pendiente |
| --- | --- |
| Preflight automatizado | Ejecutarlo con OIDC contra configuración actual aprobada; solo acredita valores consultados. |
| Revisión manual Azure | Plan compatible, identidades/RBAC mínimo, red y SCM alcanzables desde runner confiable, certificado vigente, ausencia de exclusiones y estrategia de sondas. |
| Revisión manual APIM | Certificado realmente asociado al backend, política efectiva, autenticación/identidad sobrescrita y mapeos de negocio/docs/salud. |
| Despliegue real posterior autorizado | Registrar versión, fecha, ruta, protocolo y resultados sin secretos; ejecutar las pruebas siguientes. |

Después de un despliegue autorizado, guardar evidencia de:

1. APIM con certificado autorizado: negocio accesible y contrato correcto;
   probar `/courses` contra PostgreSQL real con lecturas autorizadas, docs,
   recursos Swagger y OpenAPI por el gateway.
2. URL directa sin certificado: negocio y salud no deben alcanzar Express.
   Registrar rechazo efectivo Azure/TLS sin exigir código de respuesta Node.
3. URL directa con certificado ajeno y su clave: negocio/docs rechazados por
   Azure o por el guard (403 si llega a Node). Registrar aparte que salud no
   valida huellas, sin cambiar su contrato.
4. Sin clave autorizada, falsificar `X-ARR-ClientCert` con certificado público
   copiado; repetir con certificado ajeno y header autorizado falsificado.
   Negocio nunca debe aceptarlo. Comprobar sobrescritura por Azure: una prueba
   HTTP local con header inyectado no prueba mTLS.
5. Por APIM enviar `X-User-Id`/`X-User-Email` falsos y verificar rechazo o
   sobrescritura desde identidad autenticada. Probar consumidor no autorizado.
6. Salud por APIM y sondas internas por separado, arranque/reinicio, protocolos
   negociados y rotación efectiva con retirada de la huella anterior.

Antes de activar CD: revisión y aprobación del PR hacia develop, CI completa
(incluidos PostgreSQL 17 desechable, actionlint y ZIP productivo), configuración
manual validada, revisión OIDC/runner/environment y permisos, evidencia de pruebas
reales, riesgos compartidos aceptados y procedimiento de rollback/rotación.
Mantener `ENABLE_AZURE_DEPLOY` sin habilitar hasta autorización posterior.
El workflow conserva la condición existente de push a main; A1 no cambia esa
política de publicación ni hace merge, push o PR remoto.

El backend productivo sigue respondiendo 503 `SKILLS_GAP_UNAVAILABLE` hasta
implementar la operación real como integración separada. Ver la
[colección Postman](../postman/README.md). Las pruebas locales no demuestran un
despliegue funcional ni autorizan cambios en Azure.

## Validación local de A1 — 2026-11-03

Rama `feat/azure-public-mtls-preflight`, creada desde `develop` actualizado en
`8576d4f6b4f50f234a1e1bb35a294214874fda59` (merge del PR #10).

| Verificación ejecutada | Resultado |
| --- | --- |
| `node --test .github/scripts/*.test.mjs` | 42 pruebas aprobadas, 0 fallidas, 0 omitidas; validador ejercitado en ambos modelos y guards del workflow/ZIP. Sin dependencias npm en estas pruebas, como requiere el job changes. |
| `npm run build` | Código de salida 0; TypeScript de aplicación y mantenimiento. |
| `npm test` | 76 aprobadas, 0 fallidas, 0 omitidas al permitir sockets locales. Primer intento en sandbox: 25 aprobadas y 51 fallidas por `connect EACCES` a loopback; repetición fuera del sandbox aprobada. |
| `npm run db:test` | 49 aprobadas, 0 fallidas, 0 omitidas; PostgreSQL 17 en contenedor nuevo con almacenamiento efímero, roles de CI y puerto loopback aleatorio. Sin leer `.env`; contenedor eliminado al terminar. |
| `npm audit --audit-level=high` | Código 0; 0 vulnerabilidades. |
| `actionlint 1.7.12` | Código 0 sobre `ci-cd.yml`; binario oficial Windows con SHA-256 contrastado con checksums de la versión. El script Linux fijado de CI queda intacto. |
| `package-app.sh` y `verify-package.mjs` | Código 0 en contenedor Linux Node 24 efímero, repositorio montado solo lectura; ZIP, dependencias productivas y arranque HTTP extraído verificados con/sin huella configurada. |
| `git diff --check` | Código 0. |

No se ejecutaron preflight contra Azure, despliegues, pruebas TLS/APIM reales ni
workflow remoto. Estos quedan pendientes de autorización y entorno adecuado.
Los cambios de A1 se limitan al preflight, sus pruebas, el workflow y este documento;
se conservaron los tres archivos locales sin seguimiento encontrados al iniciar.
