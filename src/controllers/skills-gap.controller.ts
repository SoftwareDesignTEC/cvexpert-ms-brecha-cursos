import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { adaptCvSkillInput, cvSkillScale } from '../domain/cv-skill-v1.js';
import { InvalidAnalysisInput, requireText } from '../domain/skills-gap.js';
import type { UserSkillsRepository } from '../repositories/skills-gap.repository.js';
import type { createSkillsGapAnalysisService } from '../services/skills-gap-analysis.service.js';

export const requireSkillsGapIdentity: RequestHandler = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // El bypass local del catálogo no autoriza identidades en este flujo.
    if (res.locals.apimCertificateVerified !== true) {
        res.status(403).json({ error: 'APIM_CERTIFICATE_REQUIRED', message: 'Certificado de cliente no autorizado.' });
        return;
    }
    const value = req.headers['x-user-id'];
    const occurrences = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'x-user-id').length;
    if (typeof value !== 'string' || !value || value.length > 512 || value !== value.trim()
        || /[\s,\x00-\x1f\x7f]/.test(value) || occurrences !== 1) {
        res.status(401).json({ error: 'USER_IDENTITY_REQUIRED', message: 'Identidad APIM ausente o inválida.' });
        return;
    }
    res.locals.subjectHash = createHash('sha256').update('skills-gap:subject:v1\0').update(value).digest('hex');
    next();
};

function positive(value: unknown, fallback: number): number | undefined {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return undefined;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 1 ? number : undefined;
}
const unavailable = (res: Parameters<RequestHandler>[1]) => res.status(503).json({
    error: 'SKILLS_GAP_UNAVAILABLE', message: 'El análisis o la persistencia no están disponibles temporalmente.',
});

export function createSkillsGapInputController(repository: UserSkillsRepository): RequestHandler {
    return async (req, res) => {
        let skills;
        try { skills = adaptCvSkillInput(req.body); }
        catch (error) {
            if (!(error instanceof InvalidAnalysisInput)) throw error;
            res.status(400).json({ error: 'INVALID_SKILLS_INPUT', message: 'Se requiere skills con nombres únicos y niveles CV válidos o null.' });
            return;
        }
        try {
            await repository.replace(res.locals.subjectHash, skills);
            res.status(204).end();
        } catch { unavailable(res); }
    };
}

export function createSkillsGapController(repository: UserSkillsRepository,
    analysis: ReturnType<typeof createSkillsGapAnalysisService>, marketKey: string | undefined): RequestHandler {
    return async (req, res) => {
        const page = positive(req.query.page, 1), pageSize = positive(req.query.pageSize, 20);
        if (page === undefined || pageSize === undefined || pageSize > 100) {
            res.status(400).json({ error: 'INVALID_PAGINATION', message: 'page debe ser positivo seguro y pageSize entre 1 y 100.' });
            return;
        }
        // No se aceptan controles de identidad, escala o contexto por consulta.
        if (Object.keys(req.query).some(key => !['page', 'pageSize'].includes(key))) {
            res.status(400).json({ error: 'INVALID_QUERY', message: 'Solo se permiten page y pageSize.' });
            return;
        }
        try {
            if (!marketKey) return void unavailable(res);
            requireText(marketKey);
            const skills = await repository.load(res.locals.subjectHash);
            if (skills === null) {
                res.status(409).json({ error: 'SKILLS_INPUT_REQUIRED', message: 'Debe guardar una instantánea de habilidades.' });
                return;
            }
            const result = await analysis.analyze(marketKey, cvSkillScale, skills);
            const items = page > Math.ceil(result.gaps.length / pageSize) ? []
                : result.gaps.slice((page - 1) * pageSize, page * pageSize);
            res.set('X-Data-Mode', 'reference');
            res.json({ items, page, pageSize, totalRecords: result.gaps.length,
                analysis: { status: result.status, comparedSkills: result.comparedSkills,
                    scaleKey: cvSkillScale.key, marketStatus: result.marketStatus, unresolved: result.unresolved } });
        } catch { unavailable(res); }
    };
}
