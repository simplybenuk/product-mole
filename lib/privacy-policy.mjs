// These are syntactic rules, never a claim to understand every sensitive statement.
const rules = [
  ['EMAIL', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
  ['PHONE', /(?:\+\d[\d ().-]{8,}\d)/g],
  ['PERSON_NAME', /\b(?:person name|customer name|patient name)\s*[:=]\s*[^\r\n,;]+/gi],
  ['ADDRESS', /\b(?:postal address|street address)\s*[:=]\s*[^\r\n;]+/gi],
  ['CUSTOMER_ID', /\b(?:customer[_ -]?id|account[_ -]?id|case[_ -]?id)\s*[:=#]\s*[^\s,;]+/gi],
  ['API_KEY', /\b(?:api[_ -]?key|access[_ -]?token|password|secret|authorization)\s*[:=]\s*[^\r\n,;]+/gi],
  ['API_KEY', /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16})\b/g],
  ['PRIVATE_KEY', /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g],
  ['CONNECTION_STRING', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@[^\s]+/gi],
  ['HEALTH_DATA', /\b(?:diagnosis|medical history|health condition|medication)\s*[:=]\s*[^\r\n;]+/gi],
  ['FINANCIAL_DATA', /\b(?:bank account|credit card|tax id|payment details|transaction id|salary)\s*[:=]\s*[^\r\n;]+/gi],
  ['CONFIDENTIAL_BUSINESS', /\b(?:contract terms|unreleased plan|internal identifier|confidential)\s*[:=]\s*[^\r\n;]+/gi]
];

export function scanSensitiveText(text) {
  let cleaned = String(text);
  const categories = {};
  for (const [category, pattern] of rules) {
    cleaned = cleaned.replace(pattern, () => {
      categories[category] = (categories[category] || 0) + 1;
      return `[${category}]`;
    });
  }
  // Unlabelled sensitive context and possible unknown secret formats need a person.
  const uncertain = /\b(?:secret|token|password|private key|patient|diagnos\w*|medical|bank|credit card|confidential|nda|ssn|social security|customer name|home address)\b/i.test(cleaned);
  return { cleaned, categories, outcome: uncertain ? 'quarantined' : Object.keys(categories).length ? 'redacted' : 'no_rule_match' };
}

export const PRIVACY_CATEGORIES = [...new Set(rules.map(([category]) => category))];
const VISIBILITY = new Set(['internal', 'public', 'private', 'restricted', 'confidential']);
export function validateVisibility(value = 'internal') {
  if (typeof value !== 'string' || !VISIBILITY.has(value)) throw new Error('Unsupported visibility. Use internal, public, private, restricted or confidential.');
  return value;
}
// Reject rather than silently changing identity, paths or retry payloads.
// This scanner is syntactic; it cannot certify arbitrary text as non-sensitive.
export function assertSafeMetadata(value, key = '') {
  if (value === null || value === undefined) return;
  if (key === 'visibility') { validateVisibility(value); return; }
  if (typeof value === 'string') {
    if (scanSensitiveText(value).outcome !== 'no_rule_match') throw new Error('Operational metadata requires privacy review; no sensitive values may be recorded.');
  } else if (Array.isArray(value)) {
    for (const item of value) assertSafeMetadata(item);
  } else if (typeof value === 'object' && !(value instanceof Date)) {
    for (const [field, item] of Object.entries(value)) {
      assertSafeMetadata(item, field);
    }
  }
}

// Scan values before JSON/YAML escaping or copying them into multiple fields.
export function scanCaptureFields(fields) {
  const categories = {};
  let uncertain = false;
  const visit = (value, key = '') => {
    if (key === 'visibility') return validateVisibility(value);
    if (typeof value === 'string') {
      const scan = scanSensitiveText(value);
      uncertain ||= scan.outcome === 'quarantined';
      for (const [category, count] of Object.entries(scan.categories)) categories[category] = (categories[category] || 0) + count;
      return scan.cleaned;
    }
    if (Array.isArray(value)) return value.map(item => visit(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, visit(item, name)]));
    return value;
  };
  const cleaned = visit(fields);
  return { cleaned, categories, outcome: uncertain ? 'quarantined' : Object.keys(categories).length ? 'redacted' : 'no_rule_match' };
}
