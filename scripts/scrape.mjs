#!/usr/bin/env node
// Daily PM job scraper. Hits each company's public careers endpoint,
// filters to Product Manager roles in EMEA / India / Singapore / Dubai / USA,
// drops anything older than 60 days, and writes public/jobs.json.
//
// Sources are best-effort: any failure is logged and skipped, the rest still ship.

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public');
const OUT_PATH = resolve(OUT_DIR, 'jobs.json');

const UA =
  'Mozilla/5.0 (compatible; PMJobBoard/1.0; +https://github.com/Pragati-Sharma-29/mybillboard)';
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

// ---------- Greenhouse (Canva, Databricks, Snowflake, Atlan, Grab) ----------
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
async function google() {
  const out = [];
  for (let p = 1; p <= 5; p++) {
    let data;
    try {
      data = await jget(
        `https://www.google.com/about/careers/applications/jobs/results?q=%22product+manager%22&page=${p}&sort_by=date`,
      );
    } catch (e) {
      if (p === 1) throw e;
      break;
    }
    const jobs = data?.jobs || [];
    if (jobs.length === 0) break;
    for (const j of jobs) {
      const id = j.id || j.job_id;
      const locations = (j.locations || j.cities || [])
        .map((l) => (typeof l === 'string' ? l : l.display || `${l.city || ''} ${l.country || ''}`))
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
          `https://www.google.com/about/careers/applications/jobs/results/${id}`,
        posted_at: j.publish_date || j.created || j.modified || null,
      });
    }
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
  ['Google',     () => google()],
  ['Microsoft',  () => microsoft()],
  ['Meta',       () => meta()],
  ['Uber',       () => uber()],
  ['Canva',      () => greenhouse('canva', 'Canva')],
  ['Databricks', () => greenhouse('databricks', 'Databricks')],
  ['Snowflake',  () => greenhouse('snowflake', 'Snowflake')],
  ['Atlan',      () => greenhouse('atlan', 'Atlan')],
  ['Grab',       () => greenhouse('grab', 'Grab')],
  ['Salesforce', () => workday('salesforce.wd12.myworkdayjobs.com', 'salesforce/External_Career_Site', 'Salesforce')],
  ['Amazon',     () => amazon()],
];

async function main() {
  const raw = (await Promise.all(SOURCES.map(([n, fn]) => safe(n, fn)))).flat();

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
