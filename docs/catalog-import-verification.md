# Evidencia de verificación del importador de catálogo

Fecha: 2026-11-05 (Costa Rica). Rama `feat/catalog-import`, basada en
`origin/develop` (`fcdcca7`). Worktree separado de los cambios locales previos.
Node local `v24.21.0`, Docker `29.7.2`, PostgreSQL imagen `postgres:17-bookworm`.

| Comando | Resultado |
| --- | --- |
| `npm ci` | Exit 0, 101 paquetes instalados, 0 vulnerabilidades. npm avisó de scripts de instalación no aprobados para scarf/esbuild; no impidieron build/tests. |
| `npm run build` | Exit 0, compilación de src y comprobación sin emisión de scripts administrativos. |
| `npm test` | Exit 0, 80 pruebas aprobadas, 0 fallos/omitidas. |
| `npm run db:test` | Exit 0, 60 pruebas aprobadas, 0 fallos/omitidas, PostgreSQL 17 real desechable. |
| `npm audit --audit-level=high` | Exit 0, 0 vulnerabilidades. |
| `node --test .github/scripts/package.test.mjs` | Exit 0, 2 pruebas aprobadas del verificador existente. |
| Empaquetador `.github/scripts/package-app.sh /tmp/catalog-check.zip` y verificación existente | ZIP generado y verificado en contenedor Node 24 Linux; detalles abajo. |
| `git diff --check` | Sin errores de whitespace. |

Se creó exclusivamente para esta tarea el contenedor
`cvexpert-catalog-import-test` con:

```sh
docker run --detach --rm --name cvexpert-catalog-import-test \
  -e POSTGRES_PASSWORD=<contraseña-desechable> -e POSTGRES_DB=cvexpert_ci \
  -p 127.0.0.1:55439:5432 postgres:17-bookworm
```

Bootstrap solo dentro de ese contenedor: rol `cvexpert_ci` LOGIN, NOSUPERUSER,
NOCREATEROLE, CREATEDB y rol `cvexpert_brecha_app` LOGIN, NOSUPERUSER,
NOCREATEROLE, NOCREATEDB, NOINHERIT, con contraseñas desechables distintas.
El entorno de tests usó `NODE_ENV=test`, `PGHOST=127.0.0.1`, `PGPORT=55439`,
`PGDATABASE=cvexpert_ci`, `PGUSER=cvexpert_ci`, `DB_SSL_MODE=disable`,
`PGSSLROOTCERT` vacío y ambas contraseñas locales. No se usó el `.env` operativo.
Las bases UUID las creó y eliminó el helper existente; no se ejecutaron imports,
migraciones ni tests contra Azure o una base compartida.

El test nuevo comprueba versión SQL 17, CLI dry-run y apply, repetición,
NULL/M:N, conflictos en cada campo/conjunto y salida CLI rechazada, referencias
existentes/ausentes, rollback de filas previas, inyección, apóstrofes literales,
dos aplicaciones concurrentes (también con aislamiento de sesión distinto),
identidad SQL real aunque se falsifique metadata del pool y lectura HTTP `/courses`.

Para verificar distribución se usó un segundo contenedor efímero
`cvexpert-catalog-package-check`, imagen `node:24-bookworm-slim` (`v24.22.1`),
con el worktree montado **solo lectura**. Se copiaron a `/tmp` el build, manifiestos,
OpenAPI y los scripts existentes de empaquetado. Se instaló zip/unzip solo en el
contenedor, se ejecutó el empaquetador existente con `RUNNER_TEMP=/tmp/build`
y se inspeccionó el índice del ZIP: sin scripts, test, local-catalog-input,
catalog-import ni import-catalog.

El primer intento de smoke test no encontró `test/fixtures/certificates/valid.pem`
en la copia temporal del harness. Se copió el fixture fuera del ZIP y se repitió
el verificador sobre el ZIP generado: exit 0, dependencias de producción y rutas
restringidas verificadas, `/health=200`, `/skills-gap=503` y comprobación de
certificados existentes aprobadas. No se modificó el empaquetador ni Actions.

Pendiente de revisión humana: merge del PR, aceptación de políticas v1 restrictivas,
fuentes/licencias y archivo de un lote real. Cualquier uso futuro en Azure necesita
otro procedimiento autorizado. No se acredita procedencia en PostgreSQL y no puede
detectarse un túnel a un servicio remoto expuesto como loopback; consultar los
límites de [catalog-import.md](catalog-import.md).
