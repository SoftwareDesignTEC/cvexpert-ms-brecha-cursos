import 'dotenv/config';
import { createApp } from './app.js';
import { isLocalCertificateBypass } from './security/apim-certificate.js';
import { startPeriodicIngestion } from './ingestion/runtime.js';

const app = createApp();
let stopIngestion = async () => {};
try { stopIngestion = startPeriodicIngestion(); }
catch { console.error('COURSES_INGEST_CONFIGURATION_INVALID'); }

//Determinar el puerto del servidor
const port = Number(process.env.PORT ?? 3000);

// El bypass y la dirección de escucha comparten la misma decisión de seguridad.
const host = isLocalCertificateBypass(process.env.NODE_ENV, process.env) ? '127.0.0.1' : '0.0.0.0';
export const server = app.listen(port, host, () => {
    console.log(`Servidor escuchando en puerto ${port}`);
});

// Deja terminar las peticiones antes de cerrar el pool, si llegó a crearse.
function shutdown() {
    server.close(() => {
        void Promise.all([stopIngestion(),app.closeResources()]).catch(() => {
            console.error('No se pudieron cerrar los recursos del servidor.');
            process.exitCode = 1;
        });
    });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
