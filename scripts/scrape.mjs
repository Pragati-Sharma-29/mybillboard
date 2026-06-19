#!/usr/bin/env node
// Daily PM job scraper. Hits each company's public careers endpoint,
// filters to Product Manager roles in EMEA / India / Singapore / Dubai / USA,
// drops anything older than 60 days, and writes public/jobs.json.
//
// Sources are best-effort: any failure is logged and skipped, the rest still ship.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public');
const OUT_PATH = resolve(OUT_DIR, 'jobs.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const MAX_AGE_DAYS = 60;
const REQUEST_TIMEOUT_MS = 20_000;

// ---------- region classification ----------
const INDIA = [
  'india', 'bangalore', 'bengaluru', 'hyderabad', 'mumbai', 'delhi',
  'gurgaon', 'gurugram', 'noida', 'pune', 'chennai', 'kolkata', 'ahmedabad',
];
const SINGAPORE = ['singapore'];
const DUBAI = ['dubai', 'united arab emirates', 'abu dhabi', ', uae', '(uae)'];
const USA = [
  'united states', ', usa', ', us', 'u.s.a', 'u.s.',
  'new york', 'san francisco', 'seattle', 'sunnyvale', 'mountain view',
  'los angeles', 'austin', 'boston', 'chicago', 'denver', 'atlanta',
  'houston', 'dallas', 'san jose', 'santa clara', 'redmond', 'bellevue',
  'irvine', 'san diego', 'portland', 'phoenix', 'miami', 'washington, d',
  'arlington', 'reston', 'herndon', 'salt lake', 'minneapolis', 'detroit',
  'philadelphia', 'pittsburgh', 'nashville', 'tampa', 'orlando',
  'jersey city', 'newark', 'culver city', 'palo alto', 'menlo park',
  'cupertino', 'remote - us', 'remote, us', 'remote (us)',
];
const EMEA = [
  'europe', 'emea', 'united kingdom', ', uk', 'england', 'london',
  'manchester', 'edinburgh', 'glasgow', 'bristol', 'cambridge', 'oxford',
  'reading', 'dublin', 'cork', 'ireland', 'paris', 'france', 'germany',
  'berlin', 'munich', 'frankfurt', 'hamburg', 'amsterdam', 'netherlands',
  'rotterdam', 'madrid', 'spain', 'barcelona', 'italy', 'milan', 'rome',
  'sweden', 'stockholm', 'copenhagen', 'denmark', 'oslo', 'norway',
  'helsinki', 'finland', 'switzerland', 'zurich', 'geneva', 'austria',
  'vienna', 'belgium', 'brussels', 'poland', 'warsaw', 'krakow', 'prague',
  'czech', 'portugal', 'lisbon', 'israel', 'tel aviv', 'egypt', 'cairo',
  'south africa', 'johannesburg', 'cape town', 'kenya', 'nairobi',
  'nigeria', 'lagos', 'morocco', 'casablanca', 'luxembourg', 'romania',
  'bucharest', 'hungary', 'budapest', 'greece', 'athens', 'turkey',
  'istanbul', 'saudi', 'riyadh', 'jeddah', 'doha', 'qatar', 'bahrain',
  'manama', 'kuwait',
];

function classifyRegion(location) {
  if (!location) return null;
  const l = location.toLowerCase();
  if (INDIA.some((k) => l.includes(k))) return 'India';
  if (SINGAPORE.some((k) => l.includes(k))) return 'Singapore';
  if (DUBAI.some((k) => l.includes(k))) return 'Dubai';
  if (USA.some((k) => l.includes(k))) return 'USA';
  if (EMEA.some((k) => l.includes(k))) return 'EMEA';
  return null;
}

function isPMTitle(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  if (
    /program manager|project manager|product marketing|engineering manager|partner manager|portfolio manager|product designer|product analyst|product engineer|product specialist|product owner|product support|product operations manager|technical product manager,? assoc(iate)?|associate product marketing/.test(
      t,
    )
  )
    return false;
  return /\bproduct manager\b|\bhead of product\b|\bdirector,? product\b|\bdirector of product\b|\bvp,? product\b|\bvp of product\b|\bchief product\b|\bproduct lead\b|\bsr\.? product manager\b|\bgroup product manager\b|\bstaff product manager\b|\bprincipal product manager\b/.test(
    t,
  );
}

function isFresh(iso) {
  if (!iso) return true; // unknown date → keep (these APIs only list open roles)
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return true;
  const ageDays = (Date.now() - d.getTime()) / 86_400_000;
  return ageDays <= MAX_AGE_DAYS;
}

// ---------- HTTP helpers ----------
async function withTimeout(promise, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await promise(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

async function jget(url, extraHeaders = {}) {
  return withTimeout(async (signal) => {
    const res = await fetch(url, {
      signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json,text/plain,*/*',
        ...extraHeaders,
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  }, REQUEST_TIMEOUT_MS);
}

async function jpost(url, body, extraHeaders = {}) {
  return withTimeout(async (signal) => {
    const res = await fetch(url, {
      signal,
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  }, REQUEST_TIMEOUT_MS);
}

// ---------- Grab (grab.careers — Phenom / Next.js portal) ----------
// Their listings live at www.grab.careers/en/jobs/?search=...&country=...
// The page hydrates from a __NEXT_DATA__ JSON island; we also fall back
// to JSON-LD JobPosting blocks and to a couple of plausible JSON APIs.
async function fetchText(url, headers = {}) {
  return withTimeout(async (signal) => {
    const r = await fetch(url, {
      signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/json',
        ...headers,
      },
    });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.text();
  }, REQUEST_TIMEOUT_MS);
}

function walkForJobs(node, push) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkForJobs(item, push);
    return;
  }
  const t = node.title || node.jobTitle || node.name;
  const loc =
    node.location ||
    node.jobLocation ||
    node.primaryLocation ||
    (Array.isArray(node.locations) ? node.locations.join(', ') : null);
  const id = node.id || node.jobId || node.reqId || node.requisitionId;
  const url = node.url || node.applyUrl || node.jobUrl || node.link;
  const looksLikeJob =
    t &&
    typeof t === 'string' &&
    (id || url) &&
    /product\s+manager|head of product|director.*product|product lead/i.test(t);
  if (looksLikeJob) push({ title: t, location: loc, id, url, node });
  for (const v of Object.values(node)) walkForJobs(v, push);
}

async function grab() {
  const out = new Map(); // dedupe by url
  // Several search variants — Singapore + India + EMEA + Dubai + US.
  const pageUrls = [
    'https://www.grab.careers/en/jobs/?search=Product+Manager&country=Singapore&pagesize=100',
    'https://www.grab.careers/en/jobs/?search=Product+Manager&pagesize=100',
    'https://www.grab.careers/en/jobs/?search=Senior+Product+Manager&pagesize=100',
  ];

  for (const url of pageUrls) {
    let html;
    try {
      html = await fetchText(url);
    } catch {
      continue;
    }

    // 1. __NEXT_DATA__ JSON island (Next.js / Phenom)
    const next = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (next) {
      try {
        const root = JSON.parse(next[1]);
        walkForJobs(root, (j) => {
          const id = j.id || j.url;
          const jobUrl =
            j.url && /^https?:/.test(j.url)
              ? j.url
              : j.id
                ? `https://www.grab.careers/en/jobs/${j.id}/`
                : null;
          if (!jobUrl) return;
          out.set(jobUrl, {
            id: `grab-${id}`,
            company: 'Grab',
            title: j.title,
            location:
              typeof j.location === 'string'
                ? j.location
                : j.location?.city ||
                  j.location?.name ||
                  j.node?.city ||
                  j.node?.country ||
                  '',
            url: jobUrl,
            posted_at: j.node?.postedDate || j.node?.updatedAt || j.node?.createdAt || null,
          });
        });
      } catch {
        // fall through
      }
    }

    // 2. JSON-LD JobPosting fallback
    const ldMatches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g)];
    for (const m of ldMatches) {
      try {
        const obj = JSON.parse(m[1]);
        const arr = Array.isArray(obj) ? obj : [obj];
        for (const entry of arr) {
          if (entry['@type'] !== 'JobPosting' && entry['@type'] !== 'JobPosting'.toLowerCase()) continue;
          const loc =
            entry.jobLocation?.address?.addressLocality ||
            entry.jobLocation?.address?.addressCountry ||
            (Array.isArray(entry.jobLocation)
              ? entry.jobLocation
                  .map((l) => l.address?.addressLocality)
                  .filter(Boolean)
                  .join(', ')
              : '');
          const u = entry.url || entry.identifier?.value;
          if (!u || !entry.title) continue;
          out.set(u, {
            id: `grab-${entry.identifier?.value || u}`,
            company: 'Grab',
            title: entry.title,
            location: loc,
            url: u,
            posted_at: entry.datePosted || null,
          });
        }
      } catch {
        // ignore
      }
    }
  }

  return [...out.values()];
}

// ---------- Databricks (Greenhouse + databricks.com merge) ----------
// Greenhouse is the upstream that databricks.com queries, but the user
// flagged seeing roles on databricks.com — scrape both and dedupe so we
// catch anything published outside the Greenhouse feed.
async function databricksWebsite() {
  const out = new Map();
  const pageUrls = [
    'https://www.databricks.com/company/careers/open-positions?department=Product',
    'https://www.databricks.com/company/careers/open-positions?department=Product&location=EMEA',
    'https://www.databricks.com/company/careers/open-positions?department=Product&location=APAC',
  ];
  for (const url of pageUrls) {
    let html;
    try {
      html = await fetchText(url);
    } catch {
      continue;
    }
    const next = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!next) continue;
    let root;
    try {
      root = JSON.parse(next[1]);
    } catch {
      continue;
    }
    walkForJobs(root, (j) => {
      const id = j.id || j.url;
      const jobUrl =
        j.url && /^https?:/.test(j.url)
          ? j.url
          : j.node?.absolute_url || (j.id ? `https://www.databricks.com/company/careers/${j.id}` : null);
      if (!jobUrl) return;
      out.set(jobUrl, {
        id: `db-web-${id}`,
        company: 'Databricks',
        title: j.title,
        location:
          typeof j.location === 'string'
            ? j.location
            : j.location?.name || j.location?.city || j.node?.location?.name || '',
        url: jobUrl,
        posted_at: j.node?.updated_at || j.node?.first_published || null,
      });
    });
  }
  return [...out.values()];
}

async function databricks() {
  const results = await Promise.allSettled([
    greenhouse('databricks', 'Databricks'),
    databricksWebsite(),
  ]);
  const seen = new Map();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const j of r.value) {
      const key = j.url || j.id;
      if (!seen.has(key)) seen.set(key, j);
    }
  }
  return [...seen.values()];
}

// ---------- Snowflake (careers.snowflake.com — Phenom portal) ----------
async function snowflake() {
  const out = new Map();
  const pageUrls = [
    'https://careers.snowflake.com/us/en/search-results?keywords=Product+Manager',
    'https://careers.snowflake.com/us/en/search-results?keywords=Senior+Product+Manager',
    'https://careers.snowflake.com/us/en/search-results?keywords=Head+of+Product',
  ];

  for (const url of pageUrls) {
    let html;
    try {
      html = await fetchText(url);
    } catch {
      continue;
    }

    // __NEXT_DATA__ / inline state JSON
    const next = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (next) {
      try {
        const root = JSON.parse(next[1]);
        walkForJobs(root, (j) => {
          const id = j.id || j.url;
          const jobUrl =
            j.url && /^https?:/.test(j.url)
              ? j.url
              : j.id
                ? `https://careers.snowflake.com/us/en/job/${j.id}`
                : null;
          if (!jobUrl) return;
          out.set(jobUrl, {
            id: `snowflake-${id}`,
            company: 'Snowflake',
            title: j.title,
            location:
              typeof j.location === 'string'
                ? j.location
                : j.location?.city || j.location?.name || j.node?.city || '',
            url: jobUrl,
            posted_at: j.node?.postedDate || j.node?.updatedAt || null,
          });
        });
      } catch {
        // fall through
      }
    }

    // JSON-LD JobPosting
    const ldMatches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g)];
    for (const m of ldMatches) {
      try {
        const obj = JSON.parse(m[1]);
        const arr = Array.isArray(obj) ? obj : [obj];
        for (const entry of arr) {
          if (entry['@type'] !== 'JobPosting') continue;
          const loc =
            entry.jobLocation?.address?.addressLocality ||
            entry.jobLocation?.address?.addressCountry ||
            (Array.isArray(entry.jobLocation)
              ? entry.jobLocation
                  .map((l) => l.address?.addressLocality)
                  .filter(Boolean)
                  .join(', ')
              : '');
          const u = entry.url || entry.identifier?.value;
          if (!u || !entry.title) continue;
          out.set(u, {
            id: `snowflake-${entry.identifier?.value || u}`,
            company: 'Snowflake',
            title: entry.title,
            location: loc,
            url: u,
            posted_at: entry.datePosted || null,
          });
        }
      } catch {
        // ignore
      }
    }
  }

  // Phenom widgets API as a third attempt — best-effort, may 404.
  try {
    const data = await jget(
      'https://careers.snowflake.com/widgets/jobs/?keyword=Product&pageSize=100',
    );
    const list = data?.jobs || data?.refNum || data?.content || [];
    for (const j of Array.isArray(list) ? list : []) {
      const t = j.title || j.jobTitle;
      const u = j.url || j.applyUrl || (j.id && `https://careers.snowflake.com/us/en/job/${j.id}`);
      if (!t || !u) continue;
      out.set(u, {
        id: `snowflake-w-${j.id || u}`,
        company: 'Snowflake',
        title: t,
        location: j.location || j.city || '',
        url: u,
        posted_at: j.postedDate || j.updatedAt || null,
      });
    }
  } catch {
    // ignore
  }

  return [...out.values()];
}

// ---------- Lever (Mistral) ----------
async function lever(companyToken, companyName) {
  const data = await jget(
    `https://api.lever.co/v0/postings/${encodeURIComponent(companyToken)}?mode=json`,
  );
  return (Array.isArray(data) ? data : []).map((j) => {
    const cats = j.categories || {};
    const allLocs = [cats.location, ...(cats.allLocations || [])]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
    return {
      id: `lever-${companyToken}-${j.id}`,
      company: companyName,
      title: j.text,
      location: allLocs.join('; '),
      url: j.hostedUrl || j.applyUrl,
      posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    };
  });
}

// ---------- Ashby (OpenAI, and other AI labs) ----------
async function ashby(boardName, companyName) {
  const data = await jget(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(boardName)}?includeCompensation=false`,
  );
  return (data.jobs || []).map((j) => {
    const locs = [j.location, ...(j.secondaryLocations || []).map((l) =>
      typeof l === 'string' ? l : l.location || l.locationName || '',
    )]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
    return {
      id: `ashby-${boardName}-${j.id}`,
      company: companyName,
      title: j.title,
      location: j.isRemote ? `${locs.join('; ')} (Remote)` : locs.join('; '),
      url: j.jobUrl || j.applicationUrl || '',
      posted_at: j.publishedAt || null,
    };
  });
}

async function tryAshby(boardNames, companyName) {
  for (const name of boardNames) {
    try {
      const jobs = await ashby(name, companyName);
      if (jobs.length > 0) return jobs;
    } catch {
      // try next
    }
  }
  return [];
}

// Try a list of factory functions in order, returning the first non-empty
// result. Used for companies whose ATS isn't stable (Greenhouse → Ashby → Lever).
async function firstNonEmpty(attempts) {
  for (const attempt of attempts) {
    try {
      const jobs = await attempt();
      if (jobs.length > 0) return jobs;
    } catch {
      // try next
    }
  }
  return [];
}

// ---------- Greenhouse (Canva, Atlan, Anthropic) ----------
async function greenhouse(boardToken, company) {
  const data = await jget(
    `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs?content=false`,
  );
  return (data.jobs || []).map((j) => ({
    id: `gh-${boardToken}-${j.id}`,
    company,
    title: j.title,
    location: j.location?.name || '',
    url: j.absolute_url,
    posted_at: j.updated_at || j.first_published || null,
  }));
}

// ---------- Microsoft ----------
async function microsoft() {
  const out = [];
  for (let p = 1; p <= 5; p++) {
    let data;
    try {
      data = await jget(
        `https://gcsservices.careers.microsoft.com/search/api/v1/search?q=product%20manager&l=en_us&pgSz=20&o=Recent&p=${p}`,
      );
    } catch (e) {
      if (p === 1) throw e;
      break;
    }
    const jobs = data?.operationResult?.result?.jobs || [];
    if (jobs.length === 0) break;
    for (const j of jobs) {
      const loc =
        j.properties?.primaryLocation ||
        (Array.isArray(j.properties?.locations) ? j.properties.locations.join(', ') : '') ||
        '';
      out.push({
        id: `ms-${j.jobId}`,
        company: 'Microsoft',
        title: j.title,
        location: loc,
        url: `https://jobs.careers.microsoft.com/global/en/job/${j.jobId}`,
        posted_at: j.postingDate || null,
      });
    }
  }
  return out;
}

// ---------- Google ----------
// The public www.google.com/about/careers page returns HTML; the real
// JSON API lives on careers.google.com under /api/v3/search. It accepts
// q, page (1-indexed) and page_size, and returns { jobs: [...] }.
async function google() {
  const out = [];
  for (let p = 1; p <= 5; p++) {
    let data;
    try {
      data = await jget(
        `https://careers.google.com/api/v3/search/?q=%22product+manager%22&page=${p}&page_size=100&sort_by=date`,
      );
    } catch (e) {
      // Fall back to the legacy path on the first error.
      if (p === 1) {
        try {
          data = await jget(
            `https://www.google.com/about/careers/applications/jobs/results/?q=%22product+manager%22&page=${p}&format=json`,
          );
        } catch {
          throw e;
        }
      } else {
        break;
      }
    }
    const jobs = data?.jobs || data?.results || [];
    if (jobs.length === 0) break;
    for (const j of jobs) {
      const id = j.id || j.job_id || j.uuid;
      const locations = (j.locations || j.cities || [])
        .map((l) =>
          typeof l === 'string' ? l : l.display || `${l.city || ''} ${l.country || ''}`,
        )
        .filter(Boolean)
        .join('; ');
      out.push({
        id: `goog-${id}`,
        company: 'Google',
        title: j.title,
        location: locations || j.location || '',
        url:
          j.apply_url ||
          j.url ||
          (id ? `https://www.google.com/about/careers/applications/jobs/results/${id}` : ''),
        posted_at: j.publish_date || j.created || j.modified || null,
      });
    }
    if (jobs.length < 100) break;
  }
  return out;
}

// ---------- Amazon ----------
async function amazon() {
  const out = [];
  let offset = 0;
  for (let i = 0; i < 5; i++) {
    let data;
    try {
      data = await jget(
        `https://www.amazon.jobs/en/search.json?base_query=product+manager&result_limit=100&offset=${offset}&sort=recent`,
      );
    } catch (e) {
      if (i === 0) throw e;
      break;
    }
    const jobs = data?.jobs || [];
    if (jobs.length === 0) break;
    for (const j of jobs) {
      out.push({
        id: `amz-${j.id_icims || j.id}`,
        company: 'Amazon',
        title: j.title,
        location: j.normalized_location || j.location || '',
        url: j.job_path ? `https://www.amazon.jobs${j.job_path}` : '',
        posted_at: j.posted_date || j.updated_time || null,
      });
    }
    offset += jobs.length;
    if (jobs.length < 100) break;
  }
  return out;
}

// ---------- Workday (Salesforce) ----------
function parseWorkdayDate(s) {
  if (!s) return null;
  const lower = String(s).toLowerCase();
  const now = new Date();
  if (lower.includes('today')) return now.toISOString();
  if (lower.includes('yesterday')) return new Date(now.getTime() - 86_400_000).toISOString();
  const md = lower.match(/(\d+)\+?\s*days?\s*ago/);
  if (md) return new Date(now.getTime() - parseInt(md[1], 10) * 86_400_000).toISOString();
  const mm = lower.match(/(\d+)\+?\s*months?\s*ago/);
  if (mm)
    return new Date(now.getTime() - parseInt(mm[1], 10) * 30 * 86_400_000).toISOString();
  return null;
}

async function workday(host, site, company) {
  const out = [];
  let offset = 0;
  for (let i = 0; i < 5; i++) {
    let data;
    try {
      data = await jpost(`https://${host}/wday/cxs/${site}/jobs`, {
        limit: 50,
        offset,
        searchText: 'Product Manager',
        appliedFacets: {},
      });
    } catch (e) {
      if (i === 0) throw e;
      break;
    }
    const postings = data?.jobPostings || [];
    if (postings.length === 0) break;
    for (const j of postings) {
      out.push({
        id: `wd-${company}-${j.externalPath}`,
        company,
        title: j.title,
        location: j.locationsText || j.bulletFields?.[0] || '',
        url: `https://${host}${j.externalPath}`,
        posted_at: parseWorkdayDate(j.postedOn),
      });
    }
    offset += postings.length;
    if (postings.length < 50) break;
  }
  return out;
}

// ---------- Meta ----------
async function meta() {
  // Meta's careers API is a versioned GraphQL endpoint with rotating doc_ids;
  // there is no stable public JSON endpoint. Best-effort: try the public
  // search page's embedded data. If structure changes, skip cleanly.
  try {
    const res = await withTimeout(async (signal) => {
      const r = await fetch(
        'https://www.metacareers.com/jobs/?q=product%20manager',
        { signal, headers: { 'User-Agent': UA } },
      );
      if (!r.ok) throw new Error(`${r.status}`);
      return r.text();
    }, REQUEST_TIMEOUT_MS);
    // The page embeds a JSON island with job listings; try to extract one.
    const matches = [...res.matchAll(/"all_job_openings":\s*(\[[\s\S]*?\])/g)];
    if (matches.length === 0) return [];
    const jobs = JSON.parse(matches[0][1]);
    return jobs.map((j) => ({
      id: `meta-${j.id || j.req_id}`,
      company: 'Meta',
      title: j.title,
      location: (j.locations || []).join(', '),
      url: j.id ? `https://www.metacareers.com/jobs/${j.id}/` : '',
      posted_at: j.updated_time || null,
    }));
  } catch {
    return [];
  }
}

// ---------- Uber ----------
async function uber() {
  const res = await withTimeout(async (signal) => {
    const r = await fetch('https://www.uber.com/api/loadSearchJobsResults', {
      signal,
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-csrf-token': 'x',
      },
      body: JSON.stringify({
        params: { query: 'product manager', limit: 100, page: 0, location: [] },
      }),
    });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  }, REQUEST_TIMEOUT_MS);
  const list = res?.data?.results || [];
  return list.map((j) => ({
    id: `uber-${j.id}`,
    company: 'Uber',
    title: j.title,
    location: (j.allLocations || [])
      .map((l) => [l.city, l.countryName].filter(Boolean).join(', '))
      .join('; '),
    url: `https://www.uber.com/global/en/careers/list/${j.id}/`,
    posted_at: j.updatedDate || j.createdDate || null,
  }));
}

// ---------- pipeline ----------
async function safe(name, factory) {
  const t0 = Date.now();
  try {
    const jobs = await factory();
    console.log(`✓ ${name.padEnd(12)} ${String(jobs.length).padStart(4)} raw  (${Date.now() - t0}ms)`);
    return jobs;
  } catch (e) {
    console.log(`✗ ${name.padEnd(12)} skipped: ${e.message}`);
    return [];
  }
}

const SOURCES = [
  ['Google',     () => firstNonEmpty([
                     () => google(),
                     () => scrapeGenericPage('https://www.google.com/about/careers/applications/jobs/results/?q=%22product+manager%22&sort_by=date', 'Google'),
                   ])],
  ['Microsoft',  () => firstNonEmpty([
                     () => microsoft(),
                     () => scrapeGenericPage('https://jobs.careers.microsoft.com/global/en/search?q=Product%20Manager&l=en_us&pgSz=20&o=Recent', 'Microsoft'),
                   ])],
  ['Meta',       () => meta()],
  ['Uber',       () => uber()],
  ['Canva',      () => firstNonEmpty([
                     () => greenhouse('canva', 'Canva'),
                     () => ashby('canva', 'Canva'),
                     () => lever('canva', 'Canva'),
                   ])],
  ['Databricks', () => databricks()],
  ['Snowflake',  () => snowflake()],
  ['Atlan',      () => firstNonEmpty([
                     () => greenhouse('atlan', 'Atlan'),
                     () => ashby('atlan', 'Atlan'),
                     () => lever('atlan', 'Atlan'),
                   ])],
  ['Grab',       () => grab()],
  ['Salesforce', () => firstNonEmpty([
                     () => workday('salesforce.wd12.myworkdayjobs.com', 'salesforce/External_Career_Site', 'Salesforce'),
                     () => workday('salesforce.wd1.myworkdayjobs.com',  'salesforce/External_Career_Site', 'Salesforce'),
                     () => workday('salesforce.wd12.myworkdayjobs.com', 'salesforce/External', 'Salesforce'),
                   ])],
  ['Amazon',     () => amazon()],
  ['Anthropic',  () => greenhouse('anthropic', 'Anthropic')],
  ['OpenAI',     () => tryAshby(['openai'], 'OpenAI')],
  ['Mistral',    () => lever('mistral', 'Mistral')],
];

// ---------- Auto-detect ATS from URL (drives sources.json) ----------
// Given a careers URL, pick the right helper and call it. Users edit
// sources.json without touching code; this function routes for them.
async function fromUrl(name, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`bad url: ${url}`);
  }
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);

  // Greenhouse: boards.greenhouse.io/<token> or boards-api.greenhouse.io/v1/boards/<token>
  if (host.endsWith('greenhouse.io')) {
    const token = segs[0] === 'v1' && segs[1] === 'boards' ? segs[2] : segs[0];
    if (!token) throw new Error(`could not extract greenhouse token from ${url}`);
    return greenhouse(token, name);
  }

  // Ashby: jobs.ashbyhq.com/<token> or api.ashbyhq.com/posting-api/job-board/<token>
  if (host.endsWith('ashbyhq.com')) {
    const token =
      segs[0] === 'posting-api' && segs[1] === 'job-board' ? segs[2] : segs[0];
    if (!token) throw new Error(`could not extract ashby token from ${url}`);
    return ashby(token, name);
  }

  // Lever: jobs.lever.co/<token> or api.lever.co/v0/postings/<token>
  if (host.endsWith('lever.co')) {
    const token = segs[0] === 'v0' && segs[1] === 'postings' ? segs[2] : segs[0];
    if (!token) throw new Error(`could not extract lever token from ${url}`);
    return lever(token, name);
  }

  // SmartRecruiters: jobs.smartrecruiters.com/<token>
  if (host.endsWith('smartrecruiters.com')) {
    const token = segs[0];
    if (!token) throw new Error(`could not extract smartrecruiters token from ${url}`);
    return smartRecruiters(token, name);
  }

  // Workday: <tenant>.<region>.myworkdayjobs.com/<locale>/<site>
  if (host.endsWith('myworkdayjobs.com')) {
    const tenant = host.split('.')[0];
    const site =
      segs.length >= 2 ? `${tenant}/${segs[segs.length - 1]}` : `${tenant}/${segs[0] || ''}`;
    return workday(host, site, name);
  }

  // Anything else (company-branded careers domain): generic HTML scrape.
  return scrapeGenericPage(url, name);
}

// SmartRecruiters helper — used by fromUrl when the source URL points at
// jobs.smartrecruiters.com.
async function smartRecruiters(token, companyName) {
  const out = [];
  let offset = 0;
  for (let i = 0; i < 10; i++) {
    let data;
    try {
      data = await jget(
        `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100&offset=${offset}`,
      );
    } catch (e) {
      if (i === 0) throw e;
      break;
    }
    const postings = data?.content || [];
    if (postings.length === 0) break;
    for (const j of postings) {
      const loc = [j.location?.city, j.location?.region, j.location?.country]
        .filter(Boolean)
        .join(', ');
      out.push({
        id: `sr-${token}-${j.id}`,
        company: companyName,
        title: j.name,
        location: j.location?.remote ? `${loc} (Remote)` : loc,
        url: `https://jobs.smartrecruiters.com/${token}/${j.id}`,
        posted_at: j.releasedDate || j.createdOn || null,
      });
    }
    offset += postings.length;
    if (postings.length < 100) break;
  }
  return out;
}

// Generic HTML page scrape — looks for __NEXT_DATA__ JSON island and
// JSON-LD JobPosting blocks. Used as a fallback when the URL hostname
// isn't a known ATS.
async function scrapeGenericPage(url, companyName) {
  const out = new Map();
  let html;
  try {
    html = await fetchText(url);
  } catch (e) {
    throw new Error(`fetch failed: ${e.message}`);
  }

  const next = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (next) {
    try {
      const root = JSON.parse(next[1]);
      walkForJobs(root, (j) => {
        const id = j.id || j.url;
        const jobUrl =
          j.url && /^https?:/.test(j.url)
            ? j.url
            : j.id
              ? new URL(`/jobs/${j.id}`, url).toString()
              : null;
        if (!jobUrl) return;
        out.set(jobUrl, {
          id: `gen-${companyName}-${id}`,
          company: companyName,
          title: j.title,
          location:
            typeof j.location === 'string'
              ? j.location
              : j.location?.city || j.location?.name || j.node?.city || '',
          url: jobUrl,
          posted_at: j.node?.postedDate || j.node?.updatedAt || null,
        });
      });
    } catch {
      // continue
    }
  }

  const ldMatches = [
    ...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g),
  ];
  for (const m of ldMatches) {
    try {
      const obj = JSON.parse(m[1]);
      const arr = Array.isArray(obj) ? obj : [obj];
      for (const entry of arr) {
        if (entry['@type'] !== 'JobPosting') continue;
        const loc =
          entry.jobLocation?.address?.addressLocality ||
          entry.jobLocation?.address?.addressCountry ||
          (Array.isArray(entry.jobLocation)
            ? entry.jobLocation
                .map((l) => l.address?.addressLocality)
                .filter(Boolean)
                .join(', ')
            : '');
        const u = entry.url || entry.identifier?.value;
        if (!u || !entry.title) continue;
        out.set(u, {
          id: `gen-${companyName}-${entry.identifier?.value || u}`,
          company: companyName,
          title: entry.title,
          location: loc,
          url: u,
          posted_at: entry.datePosted || null,
        });
      }
    } catch {
      // continue
    }
  }

  return [...out.values()];
}

async function loadManualSources() {
  const path = resolve(__dirname, '..', 'sources.json');
  try {
    const raw = await readFile(path, 'utf8');
    const json = JSON.parse(raw);
    const list = Array.isArray(json) ? json : json.sources || [];
    return list.filter((s) => s && s.name && s.url);
  } catch {
    return [];
  }
}

async function main() {
  const manual = await loadManualSources();
  const allSources = [
    ...SOURCES,
    ...manual.map((s) => [s.name, () => fromUrl(s.name, s.url)]),
  ];
  if (manual.length > 0) {
    console.log(`Loaded ${manual.length} manual source(s) from sources.json`);
  }
  const raw = (await Promise.all(allSources.map(([n, fn]) => safe(n, fn)))).flat();

  const seen = new Set();
  const jobs = [];
  let droppedAge = 0, droppedRegion = 0, droppedTitle = 0;
  for (const j of raw) {
    if (!j.title || !j.url) continue;
    if (!isPMTitle(j.title)) { droppedTitle++; continue; }
    if (!isFresh(j.posted_at)) { droppedAge++; continue; }
    const region = classifyRegion(j.location);
    if (!region) { droppedRegion++; continue; }
    if (seen.has(j.url)) continue;
    seen.add(j.url);
    jobs.push({ ...j, region });
  }

  jobs.sort((a, b) => new Date(b.posted_at || 0) - new Date(a.posted_at || 0));

  const counts = {};
  for (const j of jobs) counts[j.region] = (counts[j.region] || 0) + 1;

  console.log('---');
  console.log(`Kept ${jobs.length} PM roles`);
  console.log(`Dropped: ${droppedTitle} non-PM titles, ${droppedRegion} out-of-region, ${droppedAge} stale`);
  console.log('By region:', counts);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    OUT_PATH,
    JSON.stringify(
      { generated_at: new Date().toISOString(), counts, jobs },
      null,
      2,
    ),
  );
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
