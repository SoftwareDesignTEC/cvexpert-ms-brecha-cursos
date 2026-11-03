# Certificado APIM y propuesta de despliegue

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
La salud permanece disponible aunque falte configuración de seguridad.

Para desarrollo/pruebas locales se requiere explícitamente
`APIM_ALLOW_INSECURE_LOCAL=true` junto con `NODE_ENV=development` o `test`.
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

Configuración propuesta para `cvexpert-ms-brecha-cursos`, grupo `rg-cvexpert`:

- HTTPS obligatorio, `NODE_ENV=production`, `clientCertEnabled=true` y
  `clientCertMode=Required`.
- `clientCertExclusionPaths=/health`, sin exclusiones amplias. Azure aplica
  coincidencia por prefijo y sin distinguir mayúsculas; el código solo publica
  la operación de salud. Verificar que ninguna operación de negocio quede
  bajo ese prefijo en cambios futuros.
- `APIM_CERT_THUMBPRINTS=FDF119D5BE797DD62E6CC87002C183CC6E70274B`, previa
  comprobación del certificado vigente de Gabriel Cabrera. No copiar su clave
  privada ni contraseña al repositorio.
- APIM `gabriel-api-management` debe usar `authentication-certificate` en la
  conexión al backend, referenciando preferentemente `certificate-id` para
  facilitar rotación. La política también debe validar la identidad y
  sobrescribir `X-User-Id` y `X-User-Email` a partir de esa identidad.

La exclusión de salud provoca renegociación TLS según Microsoft: TLS 1.3 y
HTTP/2 no soportan ese mecanismo y existen límites para cargas mayores a 100 KB.
Antes de aprobar esta configuración, comprobar TLS 1.2/HTTP 1.1 entre APIM y
App Service y el health check real. No presentar la exclusión como validada.

La UI Swagger sirve todos sus recursos localmente y desactiva el validador
remoto. Para abrirla mediante APIM se deben mapear también `/docs/*` y
`/openapi.json`, manteniendo un prefijo coherente. La autenticación del navegador
ante APIM debe estar resuelta; no introducir certificados reenviados en la UI.
La interfaz describe el backend, no declara rutas públicas confirmadas.

## Conflicto con el preflight y decisión propuesta

El guard actual exige `publicNetworkAccess=Disabled` y sigue intacto. Esto evita
aprobar silenciosamente una exposición pública. Con Consumption, APIM usa
backends públicos y no dispone de la conectividad VNet saliente necesaria para
este backend privado. Un private endpoint de entrada de APIM tampoco resuelve
la salida hacia App Service. La [matriz oficial de redes de APIM](https://learn.microsoft.com/en-us/azure/api-management/virtual-network-concepts)
detalla los niveles con inyección o integración VNet; no incluye Consumption.

La alternativa viable con Consumption es mantener el endpoint público de
App Service, exigir mTLS y fijar el certificado APIM en la aplicación. Microsoft
documenta [certificados de cliente hacia el backend en todos los niveles](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-mutual-certificates)
y la [política `authentication-certificate`, también en Consumption](https://learn.microsoft.com/en-us/azure/api-management/authentication-certificate-policy).
No basar una allowlist en una IP observada de Consumption: sus direcciones no
son exclusivas ni estáticas, según [la documentación de direcciones APIM](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-ip-addresses).

Se propone al equipo aprobar explícitamente uno de estos modelos:

1. **Consumption con mTLS:** acceso exclusivo lógico a operaciones de negocio
   para quien posea el certificado fijado; la red sigue siendo pública y salud
   constituye una excepción pública deliberada. Como el certificado es
   compartido, otros poseedores de su clave también podrían acceder: para
   exclusividad estricta de esta instancia APIM, emitir un certificado dedicado
   y limitar quién puede usarlo o modificar políticas APIM. Si se acepta este
   modelo académico, registrar la aprobación y después cambiar el preflight en
   otro PR con un modo explícito, sin fallback automático público.
2. **Aislamiento de red:** conservar el guard y planificar un nivel APIM con
   salida VNet, conectividad privada de App Service, DNS y acceso SCM para el
   despliegue. Requiere aprobación de coste y diseño; no lo implementa este PR.

No hay aprobación de equipo registrada para sustituir el guard. Este PR no
modifica Azure, no habilita CD y no certifica integración productiva.

## Evidencia necesaria antes de desplegar

| Verificable automáticamente en un futuro preflight aprobado | Requiere prueba real y evidencia del equipo |
| --- | --- |
| App Service/grupo, HTTPS, TLS, Node 24, producción, bypass deshabilitado | Conexión TLS desde APIM y certificado realmente presentado |
| `clientCertEnabled`, modo Required y exclusiones limitadas a salud | Acceso directo sin certificado y con certificado ajeno denegado |
| Lista de huellas válida y coincidente con el certificado configurado | Encabezado público copiado sin clave y encabezados de identidad falsos denegados |
| Configuración de certificado/políticas APIM y mapeos de operaciones | Identidad validada y sobrescrita por APIM, sin confiar en entrada del cliente |
| Controles existentes de identidades separadas, SCM y empaquetado | Salud excluida y negociación compatible; Swagger completo accesible solo por la frontera aprobada |
| Rotación documentada y fechas del certificado | Rotación efectiva y retirada de la huella anterior sin abrir acceso |

Después de aprobar el diseño: probar `/courses` con PostgreSQL real y la ruta
pública confirmada; sustituir el mock de brecha solo como integración separada.
El backend productivo seguirá respondiendo 503 `SKILLS_GAP_UNAVAILABLE` hasta
implementar la operación real. Ver [la colección Postman](../postman/README.md).
