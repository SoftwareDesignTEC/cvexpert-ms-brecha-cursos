# Pruebas HTTP de Brecha/Cursos

Importar la colección y el entorno apropiado. El contrato 0.2.0 está implementado
para revisión; no demuestra integración productiva. No guardar tokens reales en Git.

Las peticiones de GET usan expectedGapStatus: 409 sin instantánea, 200 con instantánea
incluso si falta mercado, 503 sin contexto de servidor o base disponible. También 401
sin identidad y 403 sin certificado autorizado. Cambiar ese valor solo para verificar
el estado esperado de una prueba concreta. Un mock APIM 200 no demuestra integración:
con 200 la colección exige analysis, escala y cobertura; no acepta el esquema demo.

PUT /skills-gap/input reemplaza la instantánea completa. La petición incluida usa
skills: [] como cuerpo revisable: editarlo antes de ejecutarla. Devuelve 204; la
colección lo comprueba. No ejecutar toda la colección inadvertidamente contra datos
personales vigentes: el PUT es una escritura explícita. Después, GET comprueba esquema
y cobertura (completa, incompleta o vacía), no supone recomendaciones disponibles.
Para probar duplicados o etiquetas desconocidas, duplicar un nombre o usar otro nivel:
debe dar 400 sin reemplazar la instantánea. Con otra identidad verificada sin entrada,
GET debe dar 409. Ver casos reproducibles automatizados en test/app.test.ts y test/db.

Completar baseUrl, healthPath, coursesPath, skillsGapPath y skillsGapInputPath con las
rutas **confirmadas** del entorno. El entorno APIM deja la ruta PUT vacía porque todavía
no está confirmada; no la inventa ni modifica el gateway. La colección no envía X-User-Id,
X-User-Email ni X-ARR-ClientCert. APIM debe validar la autenticación del usuario,
sobrescribir identidad y presentar el certificado TLS a App Service. El Bearer del
entorno representa el mecanismo aceptado por APIM; el backend no valida JWT.

El bypass local de catálogo no permite este flujo. En local, Postman directo obtiene
403 para brechas aunque catálogo/health funcionen con bypass. Para el flujo completo
usar el harness automatizado con certificados públicos de fixture e identidades de
prueba: npm test; npm run db:test sobre PostgreSQL 17 local. No enviar el certificado
reenviado como sustituto de mTLS al gateway. Las pruebas locales no verifican TLS Azure.

APIM sigue usando mocks; no sustituirlos como parte de este cambio. Confirmar integración
real en un trabajo autorizado posterior. Catálogo conserva sus filtros y contrato.
Ver [flujo, compatibilidad y requisitos productivos](../docs/skills-gap-http.md).
