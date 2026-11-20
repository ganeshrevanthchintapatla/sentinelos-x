// Data-scope vocabulary with no runtime imports, so the browser tests can check
// that the UI labels cover exactly the values the reducers accept.

export const SCOPE_STATUSES = [
  'under_review', // scoping not finished; impact unknown
  'accessed', // confidentiality: viewed / read without authorization
  'exfiltrated', // confidentiality: copied out of the environment
  'encrypted', // availability: locked by ransomware
  'altered', // integrity: modified or tampered with
  'destroyed', // availability: deleted / wiped
  'secured', // access cut off, data contained
  'restored', // recovered to a known-good state
  'not_affected', // investigated and ruled out
] as const;
export type ScopeStatus = (typeof SCOPE_STATUSES)[number];

export const SCOPE_CATEGORIES = ['pii', 'credentials', 'financial', 'health', 'intellectual_property', 'operational', 'logs', 'other'] as const;
export const SCOPE_CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;
export const SCOPE_CONFIDENCE = ['suspected', 'confirmed'] as const;
