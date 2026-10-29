export interface CatalogCourse {
    id: string;
    title: string;
    url: string;
    platform: string;
    logoUrl: string | null;
    durationHours: number | null;
    isPaid: boolean;
    skills: string[];
}

export interface CoursesQuery {
    page: number;
    pageSize: number;
    platform?: string;
    isPaid?: boolean;
    skillName?: string;
}

export interface CoursesPage {
    items: CatalogCourse[];
    page: number;
    pageSize: number;
    totalRecords: number;
}
