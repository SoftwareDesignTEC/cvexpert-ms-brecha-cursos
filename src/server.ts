import 'dotenv/config';
import { createApp } from './app.js';

const app = createApp();

//Determinar el puerto del servidor
const port = Number(process.env.PORT ?? 3000);

//Iniciar el servidor HTTP
const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Servidor escuchando en puerto ${port}`);
});

// Deja terminar las peticiones antes de cerrar el pool, si llegó a crearse.
function shutdown() {
    server.close(() => {
        void app.closeResources().catch(() => {
            console.error('No se pudieron cerrar los recursos del servidor.');
            process.exitCode = 1;
        });
    });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
