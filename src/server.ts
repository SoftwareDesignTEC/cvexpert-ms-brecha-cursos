import 'dotenv/config';
import express from 'express';

// Crea la app Express
const app = express();

//Crea un middleware para interpretar JSON
app.use(express.json());

//Registra la ruta GET /health
app.get('/health', (_req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'brecha-cursos'
    });
});

//Determinar el puerto del servidor
const port = Number(process.env.PORT ?? 3000);

//Iniciar el servidor HTTP
app.listen(port, '0.0.0.0', () => {
    console.log('Servidor escuchando en puerto ${port}');
});