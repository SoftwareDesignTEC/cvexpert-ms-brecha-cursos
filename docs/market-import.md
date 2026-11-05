# Importación administrativa local de requisitos de mercado

La herramienta está implementada exclusivamente para PostgreSQL local de
desarrollo/pruebas. No es un endpoint, no acredita fuentes y no habilita el
análisis HTTP. Usa la tabla de la migración 002 sin modificar su esquema.

## Formato de entrada v1

Dos archivos UTF-8 JSON separados permiten revisar datos y escala por separado:

| Archivo | Campos obligatorios |
| --- | --- |
| Escala | `key`: clave versionada; `levels`: lista ordenada de al menos dos códigos enteros int32 distintos, de menor a mayor competencia. |
| Lote | `formatVersion: 1`, `marketKey`: contexto explícito, `records`: entre 1 y 1000 registros. |
| Cada registro | `marketKey`, `skillName`, `scaleKey`, `requiredLevel`, `sourceReference`, `observedAt`, `dataKind`. |

El contexto se repite por registro para detectar mezclas accidentales. Debe
coincidir exactamente con el del lote. `scaleKey` debe coincidir con `key` del
archivo de escala. La herramienta reutiliza la validación ordinal del motor;
no define una escala porcentual ni convierte los niveles textuales de CVs.
El archivo de escala debe ser el artefacto previamente revisado por el equipo,
no una lista inventada para que un import pase.

- `skillName`: nombre canónico exacto ya existente en `skills`, sensible a
  mayúsculas. No se crean habilidades ni se corrigen nombres/sinónimos.
- `requiredLevel`: código perteneciente a la escala, o `null` si es desconocido.
  Nunca se convierte NULL a cero. Se requiere una escala conocida para este
  mecanismo de importación, aunque el esquema permita `scale_key NULL`.
- `sourceReference`: referencia opaca no vacía a la evidencia revisada. No se
  descarga ni consulta esa referencia. No incluir tokens ni URLs con credenciales.
- `observedAt`: fecha real UTC canónica `YYYY-MM-DDTHH:mm:ss.sssZ`, años 0001–9999.
  Es la fecha de observación de la evidencia; no una fecha que se deba incrementar
  artificialmente para forzar una actualización. La política de vigencia y la
  aceptación de observaciones futuras necesitan acuerdo; el importador solo
  valida formato y orden temporal, no frescura ni autenticidad.
- `dataKind`: `reference` o `demo`, una sola clasificación por contexto.
  **reference no demuestra confiabilidad.** La revisión humana debe comprobar la
  fuente, sus permisos de uso, metodología y correspondencia con la escala.
  El núcleo rechaza requisitos demo y nunca los presenta como análisis real.

Rechaza campos desconocidos/ausentes, tipos incorrectos, textos vacíos o con
espacios exteriores/NUL, registros duplicados incluso idénticos, escalas mezcladas,
fechas imposibles y claves de objeto JSON repetidas (también con escapes equivalentes).
Cada archivo tiene límite operativo de 1 MiB; no es un límite contractual HTTP.
No se evalúan campos como código, rutas SQL o comandos.

Los únicos archivos de ejemplo versionados son
[`market-import.test.json`](../test/fixtures/market-import.test.json) y
[`market-import.test-scale.json`](../test/fixtures/market-import.test-scale.json).
Todos sus contextos, habilidades y referencias están marcados TEST, con niveles
arbitrarios exclusivos de pruebas. Su clasificación reference permite probar
el camino del motor, **no los convierte en evidencia de mercado**. Los tests
insertan esas habilidades solo en bases desechables; no son seeds ni datos para
el catálogo de desarrollo o producción.

## Preparar el entorno local

Requiere Node 24, `npm ci`, PostgreSQL 17 local y migraciones existentes aplicadas
por el mantenedor (`npm run db:migrate`). El importador no ejecuta migraciones.
No se han aplicado migraciones ni imports en la base de desarrollo durante esta
tarea: las verificaciones usan exclusivamente PostgreSQL desechable.

Usa un shell de mantenimiento separado del backend, con las variables PG del
proyecto y su contraseña local privada. Debe tener `NODE_ENV=development` o `test`
y `PGHOST=127.0.0.1`, `::1` o `localhost`. Se preservan las reglas TLS existentes:
`DB_SSL_MODE=disable` solo para ese PostgreSQL local; nunca se desactiva TLS remoto.
Se puede usar `DOTENV_CONFIG_PATH=.env.maintenance.local` con una configuración
privada ignorada por Git. No pasar contraseñas por argumentos ni versionar ese archivo.

El rol de mantenimiento necesita SELECT en `skills` y SELECT/INSERT/UPDATE en
`market_requirements`. No necesita SUPERUSER, CREATEDB, secuencias ni DELETE para
importar. El dueño local de la tabla puede mantenerla. `cvexpert_brecha_app` sigue
siendo exclusivamente lector y se rechaza expresamente incluso para dry-run,
independientemente de que alguien le haya concedido privilegios indebidamente.
Se comprueban `current_user`, `session_user` y privilegios reales en PostgreSQL;
declarar otro `PGUSER` sin autenticar esa identidad no permite eludir el control.
El importador no crea ni modifica roles ni concede permisos.

El guard rechaza producción, entornos ambiguos y hosts remotos antes de abrir el
pool; también comprueba el host del pool utilizado. Esto no puede identificar un
túnel hacia producción o una base operativa expuesta como localhost. No usar
proxies/túneles, credenciales productivas ni copias con datos reales sensibles.
La separación de redes/credenciales y la revisión del destino siguen siendo
responsabilidad del operador; NODE_ENV no autentica un entorno.

## Revisar y aplicar un conjunto aprobado

Guardar los archivos reales revisados fuera del repo o en `local-market-input/`,
directorio ignorado por Git. No se aporta un ejemplo de mercado real porque no
existe todavía un acuerdo de fuente, contexto o escala. Con esos archivos aprobados:

```sh
# Solo consulta; informa insert/update/unchanged y before/after.
npm run db:market:import -- --file local-market-input/requirements.json --scale local-market-input/approved-scale.json

# Inserciones nuevas; falla si encuentra actualizaciones sin autorización explícita.
npm run db:market:import -- --file local-market-input/requirements.json --scale local-market-input/approved-scale.json --apply

# Tras revisar el dry-run, permitir actualizaciones del lote.
npm run db:market:import -- --file local-market-input/requirements.json --scale local-market-input/approved-scale.json --apply --allow-updates
```

Salida JSON: `mode` (`dry-run` o `applied`), `marketKey`, `changes` con `action`,
`before` y `after`, y `requiresAllowUpdates`. Before/after incluyen procedencia y
fecha para revisar cambios; la salida debe manejarse como información de
mantenimiento y no publicarse automáticamente. El código de salida es 0 cuando
la operación termina correctamente y 1 ante error; no se imprimen mensajes del
driver, consultas ni objetos de conexión. Un error no produce un informe de éxito.

La semántica es **upsert parcial sin borrados**: las habilidades omitidas permanecen
intactas. Repetir el mismo lote produce `unchanged` y no reescribe fechas. Cambiar
un dato exige una observación estrictamente posterior y `--allow-updates` además
de `--apply`. No hay `--force`, conversión de escalas, borrado de contexto ni
reclasificación demo/reference. Si se requiere corregir una evidencia con la misma
fecha, el equipo debe revisar un procedimiento separado; no inventar otra fecha.

Se valida también el contexto ya almacenado completo, incluso filas omitidas:
escala y clasificación compatibles y niveles pertenecientes a la escala suministrada.
Una `scale_key NULL` puede completarse mediante una actualización revisada con fecha
posterior, sin fabricar un nivel. Fechas almacenadas con microsegundos, infinitas
o fuera de los años soportados exigen revisión separada, evitando pérdida silenciosa
de precisión. No se usa el importador para remediar contradicciones históricas.

## Transacciones, concurrencia y empaquetado

Dry-run usa REPEATABLE READ y READ ONLY: skills y requisitos comparten instantánea;
no prueba escrituras o triggers para después revertirlos. Es una previsión, no una
reserva del estado. `--apply` vuelve a leer y validar todo dentro de su transacción;
otro mantenedor podría haber cambiado el contexto desde el dry-run.

Al aplicar se reutiliza `inTransaction` y el advisory lock de migraciones/seed.
Un bloqueo SHARE ROW EXCLUSIVE en `market_requirements` serializa importaciones
y bloquea DML concurrente aunque no coopere con el advisory lock, conservando las
lecturas HTTP. No se amplían los permisos del lector. Un fallo de FK, CHECK, permisos
o escritura revierte el lote completo, incluidas filas previas. Las consultas
parametrizan contextos, nombres, fuentes, niveles y fechas; no concatenan entradas.
Los timeouts y el pool son los existentes, y la CLI cierra el pool en finally.

Se eligió una CLI TypeScript con `tsx`, JSON y SQL parametrizado frente a un endpoint
administrativo o una plataforma ETL: reutiliza dependencias y convenciones y permite
revisar los cambios localmente. No se añade historial nuevo ni registro de escalas:
la migración 002 solo conserva su clave. **No puede detectar una redefinición histórica
del significado/orden de una misma clave si sus códigos aún coinciden.** El equipo
debe custodiar el archivo aprobado y usar otra clave/contexto para una escala nueva;
un registro persistente de definiciones requeriría un diseño y migración posteriores.

`scripts/` queda fuera de `dist` con la configuración existente; `npm run build`
comprueba además sus tipos mediante `tsconfig.maintenance.json` sin emitir archivos.
El ZIP actual solo copia dist/manifiestos/dependencias de producción y excluye por
construcción el importador, fixtures y entradas locales. No se modificó el workflow
ni el empaquetador/CD. La CLI no está importada por Express ni se ejecuta al arrancar.

## Verificación y acuerdos pendientes

`npm test` cubre validación y lectura JSON. `npm run db:test` usa PostgreSQL 17
desechable y el mecanismo existente de bases UUID; prueba CLI real, dry-run,
inserción/repetición, actualización controlada, rollback, restricciones, inyección,
concurrencia, permisos y consumo por el motor real. No necesita ni contacta Azure.

Antes de cargar requisitos reales, aprobar fuente y licencia, responsable de revisión,
contextos, nombres canónicos, definición/versionado de escala y conversión desde CVs,
clasificación, vigencia, correcciones y respaldo/auditoría operativa. No se da por
confiable un lote por contener `reference` o por pasar la validación estructural.

Antes de activar HTTP siguen pendientes la entrada autenticada del usuario, la
frontera APIM/certificados y bloqueo del acceso directo, retención/aislamiento de
snapshots, datos incompletos y duración nullable frente al contrato legado. No se
implementa PUT /skills-gap/input. `/skills-gap`, `/courses` y sus contratos activos
permanecen intactos; producción sigue sin usar recomendaciones DEMO. No se modifican
identidad, Azure, Key Vault, APIM, Service Bus ni el despliegue.
