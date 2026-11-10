import { isCvSkillLevel, type CvSkillLevel } from '../domain/cv-skill-v1.js';
import type { JobSkillRequirement } from '../domain/job-skills-gap.js';
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
    const name = text(value).trim().replace(/\s+/gu, ' ').normalize('NFC');
    if (/\p{Cc}/u.test(name)) throw new InvalidAnalysisInput();
    const key = name.toLowerCase().normalize('NFD')
        .replace(/(\p{Script=Latin})[\u0300-\u0302\u0308]+/gu, '$1').normalize('NFC');
    return { name, key };
}

export function adaptJobSkillsGapInput(body: unknown) {
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
        const { id: rawId, skills } = fields(job, 'id', 'skills');
        const jobId = id(rawId);
        if (jobIds.has(jobId)) throw new InvalidAnalysisInput();
        jobIds.add(jobId);
        const requirements = new Map<string, JobSkillRequirement>();
        for (const value of items(skills, 200)) {
            const skill = skillName(value);
            if (skill.key && !requirements.has(skill.key)) requirements.set(skill.key, skill);
        }
        return { jobId, requirements: [...requirements.values()] };
    });
    return { cvId, documentedSkills, offers };
}
