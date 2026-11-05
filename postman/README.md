# Pruebas HTTP de Brecha/Cursos

Importar `brecha-cursos.postman_collection.json` y uno de los entornos de ejemplo
en Postman. Todos los valores son de ejemplo; guardar el token real únicamente
en el entorno privado del cliente. La colección no envía identidad de usuario
ni certificados reenviados.

En local: completar `.env`, habilitar `APIM_ALLOW_INSECURE_LOCAL=true` con
`NODE_ENV=development` y ejecutar `npm run dev`. El catálogo necesita PostgreSQL
configurado y migrado. El entorno local espera 200 con datos demo en la brecha.
Las pruebas comprueban salud, esquema y paginación del catálogo y la brecha,
la marca `X-Data-Mode: demo` y el error 400 de paginación inválida.

En APIM: el gateway documentado es
`https://gabriel-api-management.azure-api.net/api/v1`. Completar `healthPath`,
`coursesPath` y `skillsGapPath` con las rutas públicas **confirmadas**, incluyendo
la `/` inicial. No asumir equivalencia con las rutas internas `/health`,
`/courses` y `/skills-gap`. Si el gateway no expone salud, ejecutar esa petición
por separado contra el backend usando el entorno apropiado.

La operación de brecha de APIM sigue conectada a un mock. El entorno APIM espera
503 con `SKILLS_GAP_UNAVAILABLE`, la respuesta del backend productivo autenticado.
Un mock 200 hará fallar esta prueba y no demuestra integración. No cambiar
`expectedGapStatus` a 200 para dar por conectado el backend: ese valor solo
corresponde a la demo local. Un 403 o `APIM_SECURITY_UNAVAILABLE` tampoco cuenta
como éxito funcional. `/courses` debe devolver 200 con su esquema real; un 503
por PostgreSQL indisponible hace fallar la prueba.

`token` representa el Bearer aceptado por la política de identidad de APIM;
confirmar dicha política y cualquier requisito de suscripción con el equipo.
No se presupone que el backend valide JWT. APIM debe presentar su certificado
en la conexión TLS hacia App Service. No enviar `X-ARR-ClientCert` manualmente
como sustituto de mTLS.

Ejecución opcional con Newman instalado:

```sh
newman run postman/brecha-cursos.postman_collection.json -e postman/local.postman_environment.json
```

Los filtros opcionales del catálogo pueden añadirse con `platform`, `isPaid` y
`skillName`, sin modificar sus reglas de validación. `baseUrl` no lleva `/` final.
