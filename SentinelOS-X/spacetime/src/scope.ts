// Data-compromise scope: which data an incident touched and what state that
// data is in (accessed, exfiltrated, encrypted by ransomware, altered, ...).
//
// Vocabulary follows common incident-documentation practice (NIST SP 800-61
// "information impact", VERIS confidentiality / integrity / availability
// attributes) so a scope entry maps directly onto a written incident report.
import { SenderError } from 'spacetimedb/server';
import { SCOPE_CATEGORIES, SCOPE_CLASSIFICATIONS, type ScopeStatus } from './scopeVocab';

export { SCOPE_STATUSES, SCOPE_CATEGORIES, SCOPE_CLASSIFICATIONS, SCOPE_CONFIDENCE, type ScopeStatus } from './scopeVocab';

/** Upper bound for the estimated number of affected records. */
export const MAX_RECORDS = 1_000_000_000_000n;

export function recordEstimate(n: bigint): bigint {
  if (n < 0n || n > MAX_RECORDS) throw new SenderError(`Record estimate must be between 0 and ${MAX_RECORDS}`);
  return n;
}

export interface ScopeSeed {
  assetId: string;
  dataSet: string;
  category: (typeof SCOPE_CATEGORIES)[number];
  classification: (typeof SCOPE_CLASSIFICATIONS)[number];
  recordEstimate: bigint;
  status: ScopeStatus;
  notificationRequired: boolean;
  notes: string;
}

/**
 * Starting scope the engine suggests when a simulated scenario opens. Always
 * recorded as `suspected` and attributed to the engine; responders confirm,
 * change or rule each entry out.
 */
export const SCENARIO_SCOPE: Record<string, readonly ScopeSeed[]> = {
  auth_compromise: [
    {
      assetId: 'auth-svc',
      dataSet: 'User credentials and session tokens',
      category: 'credentials',
      classification: 'restricted',
      recordEstimate: 312n,
      status: 'accessed',
      notificationRequired: true,
      notes: 'Engine suggestion from synthetic credential-stuffing evidence: accounts with successful sign-ins from the attacking addresses.',
    },
  ],
  file_ransomware: [
    {
      assetId: 'file-storage',
      dataSet: 'Shared file stores (finance and HR shares)',
      category: 'financial',
      classification: 'confidential',
      recordEstimate: 0n,
      status: 'encrypted',
      notificationRequired: false,
      notes: 'Engine suggestion from synthetic high-entropy write alerts. Exfiltration before encryption is not ruled out yet.',
    },
  ],
  database_outage: [
    {
      assetId: 'primary-db',
      dataSet: 'Customer account records',
      category: 'pii',
      classification: 'restricted',
      recordEstimate: 0n,
      status: 'under_review',
      notificationRequired: false,
      notes: 'Availability loss only so far; no evidence of unauthorized access. Confirm before closing.',
    },
  ],
};
