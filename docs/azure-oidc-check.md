# Diagnóstico manual de OIDC (A5.5)

El workflow `azure-oidc-check.yml` es independiente del CI/CD productivo. Solo admite
`workflow_dispatch`. No depende del opt-in de CD, no altera `ENABLE_AZURE_DEPLOY`
y no prepara ni publica código. El workflow productivo permanece intacto.

## Flujo y resultados

1. `branch-guard`, sin permiso para tokens OIDC, rechaza cualquier ref distinta de
   `refs/heads/main` antes de iniciar el job de autenticación.
2. `diagnostic` también exige evento manual y `main`, necesita el guard exitoso,
   usa `environment: azure-production`, y solicita únicamente `contents: read`
   e `id-token: write`. El subject inmutable registrado en Microsoft Entra es
   `repo:SoftwareDesignTEC@328866100/cvexpert-ms-brecha-cursos@1425858627:environment:azure-production`.
   Corresponde a la federación actualmente configurada; no se modifica esa credencial
   ni se configura otro subject desde el workflow. El environment debe seguir
   restringido a `main`, con sus restricciones y aprobaciones existentes.
3. Ambos jobs usan el runner hospedado `ubuntu-24.04`. Se ignora
   `AZURE_DEPLOY_RUNNER`: no se necesita acceso SCM para estas lecturas ARM y no
   se confía en etiquetas arbitrarias de runners. No hace falta cambiar variables.
4. Se comprueba presencia y formato UUID de `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`
   y `AZURE_SUBSCRIPTION_ID` antes de `azure/login`. Además, `AZURE_CLIENT_ID` debe
   coincidir con `c7ca60cb-216c-4a31-993b-618ad3bb0923` (comparación UUID sin distinguir
   mayúsculas). Este control valida la identidad configurada; la autenticación real
   de esa identidad sigue siendo responsabilidad de `azure/login` mediante OIDC.
   No se imprimen los valores comparados ni se consulta o modifica Entra.
   `AZURE_BACKEND_NETWORK_MODEL` se recibe de `${{ vars.AZURE_BACKEND_NETWORK_MODEL }}`,
   igual que en producción, y debe ser exactamente `public-mtls`: ausente, vacío,
   otro valor, espacios o distinta capitalización detienen el job antes del login.
   Se reutilizan los mismos SHA
   de checkout, setup-node y azure/login que CI/CD, Node 24, credenciales de checkout
   no persistidas y un directorio Azure CLI temporal exclusivo de la ejecución.
5. Login OIDC, seguido de `az account show` y `az webapp show`: se comparan en
   memoria suscripción, tenant e ID completo del App Service. Nunca se imprimen.
6. Se ejecuta el preflight existente con el network model real previamente validado.
   El wrapper vuelve a validar la configuración antes de invocarlo y transmite el
   entorno sin reemplazar el network model ni usar valores por defecto.
   El wrapper captura stdout/stderr. Las lecturas fallidas se clasifican como
   permisos/acceso; otras discrepancias como fallo de preflight. Los valores de
   configuración y tokens no pasan a logs, outputs ni artefactos.
7. El resumen distingue configuración de variables, autenticación OIDC,
   permisos/acceso, fallo de preflight y diagnóstico completado. Un error detiene
   los pasos posteriores y falla el job; el resumen usa `always()` y no convierte
   fallos en éxito. Cancelaciones o preparación incompleta no significan éxito.

Un fallo de login se clasifica en la fase OIDC; esa fase también puede fallar por
disponibilidad del servicio o acceso inicial a la suscripción. Un error de lectura
puede indicar permisos, recurso inexistente o indisponibilidad: no prueba por sí
solo una causa RBAC. No se consulta Graph ni se requiere enumerar roles RBAC.

El preflight verifica configuración; no prueba conectividad APIM, validez efectiva
de la cadena del certificado, salud de la aplicación ni capacidad de despliegue.
Una discrepancia no se corrige automáticamente.

## Inventario de operaciones Azure

Además del login y limpieza local de sesión por azure/login, solo se invocan:

| Comando | Propósito |
| --- | --- |
| `az account show` | Comparar tenant y suscripción |
| `az webapp show` | Verificar recurso, identidad y red |
| `az webapp config show` | Consultar runtime, startup y TLS |
| `az webapp config appsettings list` | Leer ajustes seleccionados, sin imprimirlos |
| `az rest --method get` | Leer políticas SCM/FTP de autenticación básica |
| `az account get-access-token` | Extraer `oid` en memoria dentro del preflight |

La consulta de appsettings es una lectura aunque ARM la implemente mediante POST
de tipo `list`. No modifica ajustes. No hay comandos de despliegue, setters,
cambios de RBAC, credenciales, certificados, APIM o infraestructura. No se usa
publish profile, no se descarga un paquete ni se suben artefactos. El token ARM
permanece capturado en memoria; nunca se registra el JWT ni certificados completos.

## Dependencias e integración propuesta

Estado verificado el 4 de noviembre de 2026 tras `git fetch origin`:

- Base de trabajo: `develop` / `origin/develop` en `ce2bf2c`, que incluye el
  preflight `public-mtls` de `98f00f0` por el merge #11.
- `origin/main` en `ab03900`; es la rama predeterminada (`origin/HEAD`).
- `git rev-list --left-right --count origin/main...origin/develop`: `1 10`.
  El commit exclusivo de main es el merge `ab03900` (#8). No asumir fast-forward.
- Main todavía tiene el preflight anterior, que exige backend privado. Llevar solo
  el YAML diagnóstico a main produciría un fallo con el backend público actual.

Después de revisar y autorizar commits/pushes/PRs:

1. Integrar los cuatro archivos A5.5 en `develop`, ejecutar controles y revisar diff.
2. Preparar la integración de `develop` hacia `main`, revisar la divergencia y
   resolver conflictos conservando el preflight `public-mtls` y sus pruebas.
   Revisar también los demás cambios funcionales incluidos en esa promoción.
3. Verificar en la revisión que CD sigue desactivado (`ENABLE_AZURE_DEPLOY=false`)
   y no alterar variables ni el environment. La integración habitual puede disparar
   CI/CD existente; su job de deploy debe seguir bloqueado por el opt-in.
4. Integrar en `main` el workflow, su helper y la versión compatible del preflight.
   No ejecutar el diagnóstico contra `develop` para intentar eludir las restricciones.

GitHub exige que un workflow manual esté en la rama predeterminada antes de
despacharlo: [documentación oficial](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow?tool=webui).
Por tanto, no se puede ejecutar este diagnóstico mientras exista solo en develop.

## Ejecución exacta una vez integrado en main

En GitHub: abrir `SoftwareDesignTEC/cvexpert-ms-brecha-cursos` → **Actions** →
**Azure OIDC diagnostic (no deployment)** → **Run workflow** → seleccionar
**main** → **Run workflow**. Atender las aprobaciones existentes del environment
si GitHub las solicita. Revisar los pasos y el resumen de la ejecución.

Alternativa con GitHub CLI autenticado y permisos de escritura en el repositorio:

```sh
gh workflow run azure-oidc-check.yml --repo SoftwareDesignTEC/cvexpert-ms-brecha-cursos --ref main
gh run list --repo SoftwareDesignTEC/cvexpert-ms-brecha-cursos --workflow azure-oidc-check.yml --branch main --event workflow_dispatch --limit 5
gh run watch RUN_ID --repo SoftwareDesignTEC/cvexpert-ms-brecha-cursos --exit-status
gh run view RUN_ID --repo SoftwareDesignTEC/cvexpert-ms-brecha-cursos
```

Sustituir `RUN_ID` por el ID de la ejecución recién creada. No hay inputs. Las
variables existentes deben satisfacer los controles descritos; el workflow no
cambia su configuración. Seleccionar otra rama provoca el rechazo sin OIDC.

## Validaciones locales

```sh
node --test .github/scripts/*.test.mjs
RUNNER_TEMP="$(mktemp -d)" bash .github/scripts/actionlint.sh
git diff --check
```

Las pruebas del helper simulan Azure y verifican resultados sin credenciales ni
tráfico Azure. Las pruebas existentes cubren los controles del preflight. Actionlint
valida todos los workflows con la versión y checksum fijados por el repositorio.
La autenticación real queda pendiente de la ejecución manual en main.

Resultados locales de la revisión correctiva A5.5: 52 pruebas aprobadas, cero fallos;
actionlint 1.7.12 aprobado para ambos workflows, con checksum verificado por el
script existente (ejecutado en Ubuntu/WSL); `git diff --check` sin errores.
No se ejecutó login ni ninguna consulta Azure durante estas validaciones.
