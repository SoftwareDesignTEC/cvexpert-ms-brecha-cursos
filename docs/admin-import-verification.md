# Evidencia de verificación administrativa

Fecha: 2026-11-06. Base revisada: `develop`, commit
`814b11c` (worktree aislado, rama `codex/admin-import-dry-run`).

## Resultados locales

| Verificación | Resultado |
| --- | --- |
| npm ci --ignore-scripts --no-audit --no-fund | Dependencias de package-lock instaladas; sin cambios de versiones |
| npm run build | Correcto: src emitido y scripts comprobados con tsconfig.maintenance.json |
| npm test | 51 pruebas aprobadas, cero fallos/omisiones |
| npm run db:test | 65 pruebas aprobadas, cero fallos/omisiones, PostgreSQL 17 desechable |
| npm audit --audit-level=high | 0 vulnerabilidades |
| git diff --check | Correcto |

Node 24.21.0 en Windows. PostgreSQL 17 de `postgres:17-bookworm` en un contenedor
dedicado publicado solo en `127.0.0.1:55440`. El harness creó y eliminó bases UUID,
sin cargar seeds. TLS habilitado solo en ese servidor de prueba, con certificado
efímero autofirmado y SAN ficticio `test.postgres.database.azure.com`, confiado
únicamente por el pool del test. No hubo DNS ni conexión al FQDN ficticio; el socket
fue loopback numérico. Rol SELECT de prueba separado, sin acceso a snapshots.

La primera ejecución dentro del sandbox tuvo EACCES en HTTP loopback; la repetición
con acceso local autorizado pasó. Como Docker aún iniciaba, se probó además una
instancia desechable PostgreSQL 18.4: pasó el nuevo escenario administrativo TLS,
pero la suite histórica rechazó la versión 18 y sus diferencias de códigos RESTRICT.
No se alteraron esas pruebas: la validación final completa se hizo con PostgreSQL 17.

## Cobertura relevante

- Rechazo de destino ambiguo, host no Azure, rol HTTP, identidad/configuración
  discordantes, TLS inseguro y ejecución desde App Service/Actions.
- CLI offline sin credenciales ni conexión; opciones cerradas, sin apply/force;
  lector JSON compartido, claves duplicadas y validadores originales.
- Sesión SQL real con TLS autorizado; rechazo por nombre de certificado incorrecto,
  conexión sin TLS, base/identidad distintas, DML efectivo y checksum histórico alterado.
- Casos negativos de current_user/session_user, TLS SQL, puerto, aislamiento,
  privilegios administrativos/heredados, esquema, lectura, DML, snapshots y RLS
  mediante dobles de sesión, además de las comprobaciones reales indicadas arriba.
- Planes de inserción, existentes, conflictos de catálogo y de evidencia/fecha de
  mercado; updates posteriores marcados para revisión; procedencia y hashes.
- Repetición idempotente, counts y secuencias intactos tras consulta; PostgreSQL
  READ ONLY rechaza DML; rollback/liberación ante preflight fallido.
- Regresión completa de importadores locales: guards, permisos, idempotencia,
  rollback parcial, concurrencia, NULL, relaciones M:N y consumo HTTP existentes.

## Límites y revisión operativa pendiente

No se conectó a Azure, no se inspeccionaron recursos reales y no se ejecutaron
importaciones remotas. Las identidades, CA, permisos y migraciones de Azure quedan
sin verificar hasta una sesión administrativa posterior expresamente autorizada.
No se modificaron migraciones, seeds, src, contratos HTTP, APIM, App Service,
workflows ni configuración de despliegue. El PR no habilita aplicación remota.

Las pruebas TLS completas requieren preparación local adicional y están marcadas
como omitidas cuando falta ADMIN_IMPORT_TEST_CA; el workflow existente no se cambia.
La auditoría del catálogo sigue externa y el dry-run no reserva el estado ni prueba
triggers de escritura. El [procedimiento operativo](admin-import.md) documenta estos
riesgos, revisión, aplicación transaccional futura y recuperación.
