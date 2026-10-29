import type { RequestHandler } from 'express';
import { getDemoSkillsGapPage } from '../services/skills-gap.service.js';

function parsePositiveInteger(value: unknown, defaultValue: number): number | undefined {
    if (value === undefined) return defaultValue;
    // Rechaza arreglos, objetos, decimales, signos y notación exponencial.
    if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

export function createSkillsGapController(demoEnabled: boolean): RequestHandler {
    return (req, res) => {
        if (!demoEnabled) {
            res.status(503).json({
                error: 'SKILLS_GAP_UNAVAILABLE',
                message: 'Solo hay datos de demostración, disponibles en development o test.',
            });
            return;
        }

        const page = parsePositiveInteger(req.query.page, 1);
        const pageSize = parsePositiveInteger(req.query.pageSize, 20);
        if (page === undefined || pageSize === undefined || pageSize > 100) {
            res.status(400).json({
                error: 'INVALID_PAGINATION',
                message: 'page debe ser un entero positivo seguro y pageSize un entero entre 1 y 100.',
            });
            return;
        }

        res.setHeader('X-Data-Mode', 'demo');
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json(getDemoSkillsGapPage(page, pageSize));
    };
}
