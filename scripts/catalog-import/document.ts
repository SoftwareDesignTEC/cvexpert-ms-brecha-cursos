export class CatalogImportError extends Error {}
export interface CatalogCourse {
    title: string;
    platform: string;
    url: string;
    isPaid: boolean;
    durationHours: number | null;
    logoUrl: string | null;
    skills: string[];
    sourceReference: string;
}
export interface CatalogDocument {
    formatVersion: 1;
    batchId: string;
    reviewedAt: string;
    skills: string[];
    courses: CatalogCourse[];
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
        throw new CatalogImportError('Campos ausentes o desconocidos.');
    }
    return value as Record<string, unknown>;
}
function text(value: unknown): asserts value is string {
    // No se normalizan nombres, URLs ni evidencia de forma implícita.
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 4096
        || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) || /;|--|\/\*|\*\//.test(value)) {
        throw new CatalogImportError('Texto inválido: vacío, espacios exteriores, controles o delimitadores no admitidos.');
    }
}
function url(value: unknown): asserts value is string {
    text(value);
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new CatalogImportError('URL HTTP(S) inválida.'); }
    if (!/^https?:\/\//.test(value) || /\s|\\/.test(value) || !parsed.hostname
        || /^https?:\/\/[^/?#]*@/.test(value) || parsed.username || parsed.password || parsed.hash
        || /[\p{Cc}\p{Cf}\p{Cs}\s]/u.test(decodePercent(value))) {
        throw new CatalogImportError('URL HTTP(S) inválida: credenciales, fragmentos y controles prohibidos.');
    }
}
function decodePercent(value: string): string {
    try { return decodeURIComponent(value); } catch { throw new CatalogImportError('Escapes URL inválidos.'); }
}
function names(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 1000) throw new CatalogImportError('Lista de habilidades inválida (máximo 1000).');
    value.forEach(text);
    if (new Set(value).size !== value.length) throw new CatalogImportError('Habilidad o asociación duplicada.');
    return [...value];
}
export function parseCatalogDocument(value: unknown): CatalogDocument {
    const doc = object(value, ['formatVersion', 'batchId', 'reviewedAt', 'skills', 'courses']);
    if (doc.formatVersion !== 1) throw new CatalogImportError('formatVersion debe ser 1.');
    text(doc.batchId);
    if (typeof doc.reviewedAt !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(doc.reviewedAt)
        || !Number.isFinite(Date.parse(doc.reviewedAt)) || new Date(doc.reviewedAt).toISOString() !== doc.reviewedAt) {
        throw new CatalogImportError('reviewedAt debe ser una fecha UTC real con milisegundos.');
    }
    const skills = names(doc.skills);
    if (!Array.isArray(doc.courses) || doc.courses.length > 1000 || (!skills.length && !doc.courses.length)) {
        throw new CatalogImportError('Lote vacío o más de 1000 cursos.');
    }
    const seen = new Set<string>();
    const courses = doc.courses.map(value => {
        const row = object(value, ['title', 'platform', 'url', 'isPaid', 'durationHours', 'logoUrl', 'skills', 'sourceReference']);
        text(row.title); text(row.platform); text(row.sourceReference); url(row.url);
        if (row.logoUrl !== null) url(row.logoUrl);
        if (typeof row.isPaid !== 'boolean' || (row.durationHours !== null
            && (typeof row.durationHours !== 'number' || !Number.isInteger(row.durationHours)
                || row.durationHours < 0 || row.durationHours > 2147483647))) {
            throw new CatalogImportError('isPaid debe ser boolean; durationHours entero int32 no negativo o null.');
        }
        if (seen.has(row.url)) throw new CatalogImportError('Curso duplicado por URL exacta.');
        seen.add(row.url);
        return { title: row.title, platform: row.platform, url: row.url, isPaid: row.isPaid,
            durationHours: row.durationHours, logoUrl: row.logoUrl, skills: names(row.skills),
            sourceReference: row.sourceReference } as CatalogCourse;
    });
    return { formatVersion: 1, batchId: doc.batchId, reviewedAt: doc.reviewedAt, skills, courses };
}
