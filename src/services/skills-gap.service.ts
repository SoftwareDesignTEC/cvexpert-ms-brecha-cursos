// El esquema paginado conserva sus cuatro campos; analysis hace explícita la cobertura.
import type { Analysis, Gap } from '../domain/skills-gap.js';
export interface SkillsGapPage {
    items: Gap[];
    page: number;
    pageSize: number;
    totalRecords: number;
    analysis: Pick<Analysis, 'status' | 'comparedSkills' | 'unresolved'> & { scaleKey: string; marketStatus: 'missing' | 'available' };
}
