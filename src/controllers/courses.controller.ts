import type { RequestHandler } from 'express';
import type { CoursesQuery } from '../models/courses.js';
import type { CoursesService } from '../services/courses.service.js';

export class InvalidCoursesQuery extends Error {}

export function parseCoursesQuery(parameters: URLSearchParams): CoursesQuery {
    const known = new Set(['page', 'pageSize', 'platform', 'isPaid', 'skillName']);
    const values = new Map<string, string>();
    for (const [key, value] of parameters) {
        // Inspeccionar claves originales también rechaza objetos que qs omitiría
        // por seguridad (por ejemplo platform[__proto__][x]).
        if (known.has(key.split('[')[0]!) && key.includes('[')) throw new InvalidCoursesQuery();
        if (!known.has(key)) continue;
        if (values.has(key) || value.trim() === '' || value.includes('\0')) throw new InvalidCoursesQuery();
        values.set(key, value);
    }
    function positiveInteger(key: string, fallback: number, maximum: number): number {
        const text = values.get(key);
        if (text === undefined) return fallback;
        const value = Number(text);
        if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
            throw new InvalidCoursesQuery();
        }
        return value;
    }
    const isPaid = values.get('isPaid');
    if (isPaid !== undefined && isPaid !== 'true' && isPaid !== 'false') throw new InvalidCoursesQuery();
    return {
        page: positiveInteger('page', 1, Number.MAX_SAFE_INTEGER),
        pageSize: positiveInteger('pageSize', 20, 100),
        ...(values.has('platform') ? { platform: values.get('platform')! } : {}),
        ...(isPaid !== undefined ? { isPaid: isPaid === 'true' } : {}),
        ...(values.has('skillName') ? { skillName: values.get('skillName')! } : {}),
    };
}

export function createCoursesController(service: CoursesService): RequestHandler {
    return async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        let query: CoursesQuery;
        try {
            const queryStart = req.originalUrl.indexOf('?');
            query = parseCoursesQuery(new URLSearchParams(queryStart === -1 ? '' : req.originalUrl.slice(queryStart + 1)));
        } catch (error) {
            if (!(error instanceof InvalidCoursesQuery)) throw error;
            res.status(400).json({ error: 'INVALID_QUERY', message: 'Parámetros de consulta inválidos.' });
            return;
        }
        try {
            res.status(200).json(await service.getPage(query));
        } catch {
            // Ni errores de pg/configuración ni consultas o credenciales van al cliente.
            res.status(503).json({ error: 'CATALOG_UNAVAILABLE', message: 'El catálogo no está disponible temporalmente.' });
        }
    };
}
