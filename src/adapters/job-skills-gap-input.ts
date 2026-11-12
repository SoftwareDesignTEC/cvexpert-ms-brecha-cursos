import { isCvSkillLevel, type CvSkillLevel } from '../domain/cv-skill-v1.js';
import { normalizeJobSkillName, type JobSkillRequirement } from '../domain/job-skills-gap.js';
import { InvalidAnalysisInput } from '../domain/skills-gap.js';

function fields(value: unknown, ...keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
        throw new InvalidAnalysisInput();
    }
    return value as Record<string, unknown>;
}

function items(value: unknown, max: number, min = 0): readonly unknown[] {
    if (!Array.isArray(value) || value.length < min || value.length > max) throw new InvalidAnalysisInput();
    return value;
}

function text(value: unknown): string {
    if (typeof value !== 'string' || [...value].length > 200) throw new InvalidAnalysisInput();
    return value;
}

function id(value: unknown): string {
    const result = text(value);
    if (!result.trim() || /\p{Cc}/u.test(result)) throw new InvalidAnalysisInput();
    return result;
}

function skillName(value: unknown): JobSkillRequirement {
    const skill = normalizeJobSkillName(text(value));
    if (/\p{Cc}/u.test(skill.name)) throw new InvalidAnalysisInput();
    return skill;
}

function offerText(value: unknown, max: number): string {
    if (typeof value !== 'string' || [...value].length > max
        || /[\p{Cs}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value)) {
        throw new InvalidAnalysisInput();
    }
    return value;
}

export function adaptJobSkillsGapInput(body: unknown, allowText = true) {
    const { cv, jobs } = fields(body, 'cv', 'jobs');
    const cvFields = fields(cv, 'id', 'skills');
    const cvId = id(cvFields.id);
    const documentedSkills = new Map<string, CvSkillLevel>();
    for (const item of items(cvFields.skills, 500)) {
        const { name, level } = fields(item, 'name', 'level');
        const { key } = skillName(name);
        if (!key || !isCvSkillLevel(level)) throw new InvalidAnalysisInput();
        const previous = documentedSkills.get(key);
        if (previous !== undefined && previous !== level) throw new InvalidAnalysisInput();
        documentedSkills.set(key, level);
    }

    const jobIds = new Set<string>();
    const offers = items(jobs, 20, 1).map(job => {
        const optional = allowText && job && typeof job === 'object'
            ? ['description', 'requirements'].filter(key => Object.hasOwn(job, key)) : [];
        const jobFields = fields(job, 'id', 'skills', ...optional);
        const { id: rawId, skills } = jobFields;
        const text = optional.length === 0 ? undefined : {
            description: Object.hasOwn(jobFields, 'description') ? offerText(jobFields.description, 20000) : undefined,
            requirements: Object.hasOwn(jobFields, 'requirements')
                ? items(jobFields.requirements, 100).map(value => offerText(value, 2000)) : undefined,
        };
        const jobId = id(rawId);
        if (jobIds.has(jobId)) throw new InvalidAnalysisInput();
        jobIds.add(jobId);
        const requirements = new Map<string, JobSkillRequirement>();
        for (const value of items(skills, 200)) {
            const skill = skillName(value);
            if (skill.key && !requirements.has(skill.key)) requirements.set(skill.key, skill);
        }
        return { jobId, requirements: [...requirements.values()], text };
    });
    return { cvId, documentedSkills, offers };
}
