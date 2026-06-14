// Match profile derived from Pragati Sharma's resume (2026).
// Used by the "It's a Match!" tab to score each job by relevance.
// Keywords are matched against job title + location (case-insensitive,
// substring). Edit the lists below to retune the matcher.

export const PROFILE = {
  // Closest-fit themes from 11 yrs of PM work at Google (Dataplex / data
  // catalog / business glossaries), Microsoft (Purview / M365 substrate /
  // ML platform) and Gaana (search). Each hit = +12, capped at +50 total.
  highValue: [
    // Data platform / governance
    'data catalog', 'metadata', 'governance', 'data governance',
    'data quality', 'data platform', 'data security', 'data engineering',
    'lakehouse', 'lineage', 'master data', 'mdm',
    // AI / ML platforms + agentic
    'ai agent', 'ai agents', 'agentic', 'genai', 'generative ai',
    'llm', 'foundation model', 'ml platform', 'ml ops', 'mlops',
    'ai platform', 'ai/ml',
    // Search / discovery
    'search', 'discovery', 'recommendation',
    // Specific products she\'s shipped or worked next to
    'bigquery', 'dataplex', 'purview', 'snowflake', 'databricks',
    'lakebase', 'unity catalog', 'fabric',
  ],
  // Adjacent domains. Each hit = +4, capped at +15 total.
  mediumValue: [
    'data', 'ai', 'ml', 'analytics', 'infrastructure', 'developer',
    'api', 'sdk', 'security', 'identity', 'privacy', 'compliance',
    'product strategy', 'b2b', 'saas', 'enterprise', 'platform', 'cloud',
  ],
  // Title-level seniority (~11 yrs experience → Senior / Group / Staff / Lead PM).
  // First match = +25.
  seniority: [
    'senior product manager', 'sr. product manager', 'sr product manager',
    'lead product manager', 'staff product manager',
    'principal product manager', 'group product manager',
    'director of product', 'director, product', 'head of product',
    'product lead',
  ],
  // Region preference — based in Hyderabad.
  regionBoost: {
    India: 30,
    Singapore: 15,
    EMEA: 15,
    Dubai: 10,
    USA: 8,
  },
};

export const MATCH_THRESHOLD = 45;

// Short tokens (ai, ml, api, sdk, data, b2b, saas) need word boundaries
// so they don\'t false-positive inside words like "SupplyChain" or "Daily".
function hasKeyword(haystack, kw) {
  if (kw.length <= 4) {
    const re = new RegExp(`(^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    return re.test(haystack);
  }
  return haystack.includes(kw);
}

export function computeMatch(job, profile = PROFILE) {
  const title = (job.title || '').toLowerCase();
  const location = (job.location || '').toLowerCase();
  const haystack = `${title} ${location}`;

  let score = 0;
  const matched = [];

  for (const kw of profile.seniority) {
    if (title.includes(kw)) {
      score += 25;
      matched.push(kw);
      break;
    }
  }

  let highHits = 0;
  for (const kw of profile.highValue) {
    if (hasKeyword(haystack, kw)) {
      highHits++;
      matched.push(kw);
    }
  }
  score += Math.min(highHits * 12, 50);

  let medHits = 0;
  for (const kw of profile.mediumValue) {
    if (hasKeyword(haystack, kw)) {
      medHits++;
      if (!matched.includes(kw)) matched.push(kw);
    }
  }
  score += Math.min(medHits * 4, 15);

  score += profile.regionBoost[job.region] || 0;

  return {
    score,
    matched: [...new Set(matched)].slice(0, 6),
  };
}
