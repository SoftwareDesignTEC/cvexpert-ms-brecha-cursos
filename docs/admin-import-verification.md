# Evidencia de aplicación administrativa

Fecha: 2026-11-06. Rama `codex/admin-import-apply`, base `develop` bd9eb43 (PR #18).
Node 24.21.0, Windows, Docker `postgres:17-bookworm`, PostgreSQL 17 desechable.
Puerto final 127.0.0.1:55438 tanto interno como externo. Sin túneles ni Azure.

| Verificación | Resultado |
| --- | --- |
| npm ci --ignore-scripts | Dependencias del lock sin cambios de versiones |
| npm run build | Correcto; backend y scripts administrativos |
| npm test | 53 aprobadas, 0 fallos, 0 omisiones |
| npm run db:test | 78 aprobadas, 0 fallos, 0 omisiones |
| npm audit --audit-level=high | 0 vulnerabilidades, incluidas dev |

TLS 1.2/1.3 con certificado efímero SAN test.postgres.database.azure.com y CA local
explícita. Roles reales SELECT e INSERT separados, sin privilegios elevados ni
acceso a snapshots. Helper crea y elimina únicamente bases UUID de prueba.

Cobertura nueva: primera carga vacía y conjunta, habilidades nuevas, NULL,
asociaciones completas, repetición idempotente, UUID sin duplicados, conflictos de
curso/escala, fechas/niveles inválidos, demo, identidad real, permisos insuficientes
y excesivos, rollback tras catálogo por un fallo SQL en mercado, concurrencia del
mismo UUID y planes obsoletos, firma/clave/archivos alterados, estado cambiado,
updates revisados, TLS obligatorio y certificado incorrecto, y CLI completa
plan → revisión explícita → sign → apply → verify con recibos durables.

Los escenarios de incertidumbre ejecutan DML real: uno confirma COMMIT en PostgreSQL
y pierde artificialmente la respuesta del driver; el otro revierte antes de enviar
COMMIT y simula desconexión. Verify distingue applied/not-applied y el reintento
no duplica. No se pretende reproducir cada fallo de red/SO. Se conservan todas las
pruebas existentes de endpoints, identidades y mantenimiento local.

El sandbox bloqueó inicialmente TCP loopback; las ejecuciones finales se hicieron
con permiso de acceso local. Una instancia inicial con port mapping distinto
confirmó que la CLI no acepta un puerto SQL diferente del destino: se corrigió
el entorno de pruebas, conservando el control productivo.

Se encontró el ZIP indicado y se comprobó su manifiesto SHA-256; se mantiene en
almacenamiento local ignorado. No se versionan originales, informes, claves ni
aprobaciones operativas. Los fixtures no sustituyen esos candidatos. Sus niveles
editoriales y vigencia siguen pendientes de ratificación humana.

No se abrió ninguna conexión a Azure ni se crearon roles, grants, migraciones o
cargas remotas. No se cambió configuración HTTP/OpenAPI/APIM/certificados ni se
activó despliegue. El workflow solo añade bootstrap TLS/roles del servicio local
desechable para ejecutar las pruebas nuevas en CI.

Pendiente operativo imprescindible: revisión PR/datos, 004 aplicada por DBA bajo
autorización posterior, LOGIN lector/escritor limitados, acceso de red/CA y respaldo
aprobados, clave de aprobador confiable, plan fresco y aprobación firmada. No falta
implementar otro importador. Comandos y recuperación: [procedimiento](admin-import.md).
