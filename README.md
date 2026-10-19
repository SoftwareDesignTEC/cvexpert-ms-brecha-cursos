# cvexpert-ms-brecha-cursos
Microservicio de brecha de habilidades y recomendación de cursos de CVExpert

## Ejecución local

Requiere Node.js 24 y npm. Instalar dependencias con `npm ci`, copiar
`.env.example` a `.env` y ejecutar `npm run dev`. Para ejecutar el compilado:
`npm run build` y `npm start`. Se usa `PORT=3000` de forma predeterminada.

`npm test` ejecuta las pruebas de integración con el runner de Node y `tsx`;
cada servidor de prueba usa un puerto temporal en loopback y se cierra al finalizar.
`npm run build` comprueba tipos y genera los archivos de producción en `dist`.
Los tests TypeScript se ejecutan con `tsx` y no se incluyen en `dist`.

## Primera versión de skills-gap: solo demostración

- `GET /health` devuelve `{ "status": "ok", "service": "brecha-cursos" }`.
- `GET /skills-gap?page=1&pageSize=20` devuelve `items`, `page`, `pageSize`
  y `totalRecords`. Hay tres registros ficticios en orden fijo.
- `page` y `pageSize` son opcionales e independientes: valores predeterminados
  1 y 20. Deben ser enteros positivos seguros; `pageSize` tiene máximo 100.
  Se rechazan valores vacíos, decimales, signos, espacios, notación exponencial,
  parámetros repetidos, arreglos y objetos con HTTP 400. Los parámetros ajenos
  a la paginación se ignoran.
- Una página posterior al último registro devuelve HTTP 200 e `items: []`,
  conservando el total de registros, independiente del tamaño de página.

La ruta solo está habilitada con `NODE_ENV=development` o `NODE_ENV=test`.
En producción, sin `NODE_ENV` o con cualquier otro valor devuelve HTTP 503,
sin registros. `/health` continúa disponible. Configurar correctamente
`NODE_ENV=production` al desplegar; no usar el `.env` local en producción.

Las habilidades y títulos llevan `[DEMO]`, los enlaces apuntan a `example.org`
y la respuesta incluye `X-Data-Mode: demo` y `Cache-Control: no-store`.
Los números de nivel son ilustrativos: la escala sigue pendiente de acuerdo.
No hay análisis de usuarios, demanda real ni recomendaciones auténticas.
React y Android deben mostrar el carácter demostrativo de estos registros;
las etiquetas del cuerpo permiten reconocerlo incluso sin leer encabezados.

## Organización

- `src/app.ts`: construye Express y conserva `/health`, sin abrir puertos.
- `src/server.ts`: carga `.env` y abre el servidor HTTP.
- `src/routes/skills-gap.routes.ts`: registra la ruta.
- `src/controllers/skills-gap.controller.ts`: controla disponibilidad,
  valida query strings y traduce el resultado a HTTP.
- `src/services/skills-gap.service.ts`: tipos del contrato y paginación
  de datos ficticios, sin dependencia de Express.
- `test/app.test.ts`: pruebas HTTP de salud, contrato, paginación,
  parámetros inválidos y bloqueo de demostración.

`openapi.yaml` conserva los esquemas preliminares y documenta el modo demo.
La autenticación descrita mediante APIM es una intención del contrato:
esta versión no valida identidades ni utiliza `X-User-Id`.
No se han implementado PostgreSQL, Azure ni Service Bus.
