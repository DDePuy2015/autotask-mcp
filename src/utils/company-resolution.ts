export interface CompanyCandidate {
  id: number;
  companyName: string;
}

export type CompanyNameResolution =
  | { status: 'resolved'; companyID: number }
  | {
    status: 'not_found' | 'ambiguous' | 'confirmation_required';
    companyName: string;
    candidates: CompanyCandidate[];
    candidatesArePreview: true;
  };

// Preserve punctuation: O'Brien, A.C.M.E. and Acme, Inc. are distinct names.
export function normalizeCompanyName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}
