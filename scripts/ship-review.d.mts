export interface ReviewFinding { code?: string; severity: 'blocker' | 'major' | 'minor'; file?: string; line?: number | null; text: string; fix?: string }
export function reviewBody(body: string | null | undefined, result: { verdict: string; findings: ReviewFinding[]; reason?: string }): string;
