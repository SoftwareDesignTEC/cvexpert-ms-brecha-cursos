import { analyzeSkillsGap, type LevelScale } from '../../src/domain/skills-gap.js';

export class MarketImportError extends Error {}
export interface ImportRecord {
    marketKey: string;
    skillName: string;
    scaleKey: string;
    requiredLevel: number | null;
    sourceReference: string;
    observedAt: string;
    dataKind: 'reference' | 'demo';
}
export interface ImportDocument { formatVersion: 1; marketKey: string; records: ImportRecord[] }

function object(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== keys.length
        || keys.some(key => !Object.hasOwn(value, key))) throw new MarketImportError('Campos JSON ausentes o desconocidos.');
    return value as Record<string, unknown>;
}
function text(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\0')) {
        throw new MarketImportError('Los textos deben ser explícitos, no vacíos, sin espacios exteriores ni NUL.');
    }
}

export function parseScale(value: unknown): LevelScale {
    const obj = object(value, ['key', 'levels']);
    text(obj.key);
    if (!Array.isArray(obj.levels)) throw new MarketImportError('La escala debe enumerar sus niveles ordenados.');
    const scale = { key: obj.key, levels: [...obj.levels] as number[] };
    // Reutiliza el acuerdo y la validación int32/ordinal del motor, sin inventar un rango.
    try { analyzeSkillsGap({ scale, userSkills: [], requirements: [], courses: [] }); }
    catch { throw new MarketImportError('Escala inválida: requiere al menos dos niveles int32 distintos.'); }
    return scale;
}

export function parseImportDocument(value: unknown, scale: LevelScale): ImportDocument {
    const approvedScale = parseScale(scale);
    const obj = object(value, ['formatVersion', 'marketKey', 'records']);
    if (obj.formatVersion !== 1) throw new MarketImportError('formatVersion debe ser 1.');
    text(obj.marketKey);
    if (!Array.isArray(obj.records) || obj.records.length === 0 || obj.records.length > 1000) {
        throw new MarketImportError('El lote debe contener entre 1 y 1000 registros.');
    }
    const seen = new Set<string>();
    const records = obj.records.map(value => {
        const row = object(value, ['marketKey', 'skillName', 'scaleKey', 'requiredLevel', 'sourceReference', 'observedAt', 'dataKind']);
        for (const key of ['marketKey', 'skillName', 'scaleKey', 'sourceReference']) text(row[key]);
        if (row.marketKey !== obj.marketKey || row.scaleKey !== approvedScale.key) {
            throw new MarketImportError('Contexto o escala inconsistente en el lote.');
        }
        if (row.requiredLevel !== null && !approvedScale.levels.includes(row.requiredLevel as number)) {
            throw new MarketImportError('Nivel requerido no perteneciente a la escala revisada.');
        }
        // UTC canónico con milisegundos: rechaza fechas normalizadas, sin zona o imposibles.
        if (typeof row.observedAt !== 'string' || row.observedAt.startsWith('0000') || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.observedAt)
            || !Number.isFinite(Date.parse(row.observedAt)) || new Date(row.observedAt).toISOString() !== row.observedAt) {
            throw new MarketImportError('observedAt debe ser una fecha real UTC con milisegundos (ISO 8601).');
        }
        if (row.dataKind !== 'reference' && row.dataKind !== 'demo') throw new MarketImportError('Clasificación de datos inválida.');
        if (row.dataKind === 'reference' && (row.skillName as string).includes('[DEMO]')) {
            throw new MarketImportError('Una habilidad DEMO no puede importarse como reference.');
        }
        if (seen.has(row.skillName as string)) throw new MarketImportError('Habilidad duplicada en el lote; no se elige un registro implícitamente.');
        seen.add(row.skillName as string);
        return { ...row } as unknown as ImportRecord;
    });
    if (records.some(row => row.dataKind !== records[0]!.dataKind)) throw new MarketImportError('El contexto no admite clasificaciones mezcladas.');
    records.sort((a, b) => a.skillName < b.skillName ? -1 : a.skillName > b.skillName ? 1 : 0);
    return { formatVersion: 1, marketKey: obj.marketKey, records };
}
