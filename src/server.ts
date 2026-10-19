import 'dotenv/config';
import { createApp } from './app.js';

const app = createApp();

//Determinar el puerto del servidor
const port = Number(process.env.PORT ?? 3000);

//Iniciar el servidor HTTP
app.listen(port, '0.0.0.0', () => {
    console.log(`Servidor escuchando en puerto ${port}`);
});
