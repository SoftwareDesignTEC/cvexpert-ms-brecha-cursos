// Tipos locales que reflejan openapi.yaml; no definen contratos entre servicios.
export interface CourseSuggestion {
    id: string;
    title: string;
    url: string;
    platform: string;
    logoUrl: string | null;
    durationHours: number;
}

export interface SkillGapItem {
    skillName: string;
    userLevel: number;
    marketLevel: number;
    courses: CourseSuggestion[];
}

export interface SkillsGapPage {
    items: SkillGapItem[];
    page: number;
    pageSize: number;
    totalRecords: number;
}

// Valores ficticios: no representan personas, demanda laboral ni cursos reales.
// Las escalas de niveles todavía deben acordarse con el equipo.
const demoItems: SkillGapItem[] = ['SQL', 'TypeScript', 'Pruebas automatizadas'].map(
    (skill, index) => ({
        skillName: `[DEMO] ${skill}`,
        userLevel: 40,
        marketLevel: 80,
        courses: [{
            id: `demo-course-${index + 1}`,
            title: `[DEMO] Curso ficticio de ${skill}`,
            url: `https://example.org/demo/courses/${index + 1}`,
            platform: 'Plataforma ficticia de demostración',
            logoUrl: null,
            durationHours: 8,
        }],
    }),
);

// El controlador entrega únicamente enteros positivos ya validados.
export function getDemoSkillsGapPage(page: number, pageSize: number): SkillsGapPage {
    const totalRecords = demoItems.length;
    // Verifica el límite antes de multiplicar para evitar offsets inseguros.
    const items = page > Math.ceil(totalRecords / pageSize)
        ? []
        : demoItems.slice((page - 1) * pageSize, page * pageSize);
    return { items, page, pageSize, totalRecords };
}
