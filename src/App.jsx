import { useEffect, useMemo, useState } from 'react';
import { computeMatch, MATCH_THRESHOLD } from './matchProfile.js';

const REGION_TABS = ['EMEA', 'India', 'Singapore', 'Dubai', 'USA'];
const MATCH_TAB = "It's a Match!";
const TABS = [MATCH_TAB, ...REGION_TABS];

const COMPANIES = [
  'Google',
  'Microsoft',
  'Meta',
  'Uber',
  'Canva',
  'Databricks',
  'Snowflake',
  'Atlan',
  'Grab',
  'Salesforce',
  'Amazon',
];

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months > 1 ? 's' : ''} ago`;
}

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(MATCH_TAB);
  const [query, setQuery] = useState('');
  const [activeCompanies, setActiveCompanies] = useState(new Set());

  useEffect(() => {
    const url = `${import.meta.env.BASE_URL}jobs.json`;
    fetch(url, { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  const scoredJobs = useMemo(() => {
    const jobs = data?.jobs ?? [];
    return jobs.map((j) => ({ ...j, ...computeMatch(j) }));
  }, [data]);

  const counts = useMemo(() => {
    const out = { [MATCH_TAB]: 0 };
    for (const r of REGION_TABS) out[r] = 0;
    for (const j of scoredJobs) {
      if (out[j.region] !== undefined) out[j.region] += 1;
      if (j.score >= MATCH_THRESHOLD) out[MATCH_TAB] += 1;
    }
    return out;
  }, [scoredJobs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let pool;
    if (tab === MATCH_TAB) {
      pool = scoredJobs.filter((j) => j.score >= MATCH_THRESHOLD);
    } else {
      pool = scoredJobs.filter((j) => j.region === tab);
    }
    return pool
      .filter((j) => (activeCompanies.size === 0 ? true : activeCompanies.has(j.company)))
      .filter((j) =>
        q ? `${j.title} ${j.location} ${j.company}`.toLowerCase().includes(q) : true,
      )
      .sort((a, b) => {
        if (tab === MATCH_TAB) return b.score - a.score;
        return new Date(b.posted_at || 0) - new Date(a.posted_at || 0);
      })
      .slice(0, tab === MATCH_TAB ? 60 : 1000);
  }, [scoredJobs, tab, activeCompanies, query]);

  function toggleCompany(c) {
    setActiveCompanies((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  const isMatchTab = tab === MATCH_TAB;

  return (
    <div className="container">
      <div className="header">
        <div>
          <h1 className="title">Product Manager Job Board</h1>
          <p className="subtitle">
            Fresh PM roles from top firms across EMEA, India, Singapore, Dubai &amp; USA. Refreshed daily.
          </p>
        </div>
        <div className="meta">
          {data?.generated_at && (
            <>Last refreshed: {new Date(data.generated_at).toLocaleString()}</>
          )}
        </div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t}
            className={`tab ${tab === t ? 'active' : ''} ${t === MATCH_TAB ? 'tab-match' : ''}`}
            onClick={() => setTab(t)}
          >
            {t}
            <span className="count">({counts[t] ?? 0})</span>
          </button>
        ))}
      </div>

      {isMatchTab && (
        <div className="match-banner">
          Ranked against Pragati's resume — Senior/Lead/Group/Staff PM roles in data
          governance, AI platforms, ML/agentic systems, and search. Top 60 shown,
          sorted by match score.
        </div>
      )}

      <div className="toolbar">
        <input
          className="search"
          placeholder="Search by title, company or city..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="company-filter">
          {COMPANIES.map((c) => (
            <button
              key={c}
              onClick={() => toggleCompany(c)}
              className={`chip ${activeCompanies.has(c) ? 'active' : ''}`}
              title={`Filter ${c}`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="empty">
          Could not load jobs.json — {error}. The daily scraper may not have run yet.
        </div>
      )}

      {!error && data && filtered.length === 0 && (
        <div className="empty">
          {isMatchTab
            ? 'No matching roles cleared the threshold today — try widening the filters or check again tomorrow.'
            : `No PM roles found for ${tab} with the current filters.`}
        </div>
      )}

      <div className="cards">
        {filtered.map((j) => (
          <article key={j.id} className="card">
            <div className="card-main">
              <h3>
                <a href={j.url} target="_blank" rel="noopener noreferrer">
                  {j.title}
                </a>
              </h3>
              <div className="card-row">
                <span className="tag company">{j.company}</span>
                <span>{j.location}</span>
                {j.posted_at && <span>• {formatDate(j.posted_at)}</span>}
                {!isMatchTab && <span className="tag tag-region">{j.region}</span>}
                {isMatchTab && (
                  <span className="tag tag-score" title={`Score ${j.score}`}>
                    {scoreLabel(j.score)} · {j.score}
                  </span>
                )}
              </div>
              {isMatchTab && j.matched && j.matched.length > 0 && (
                <div className="match-keywords">
                  {j.matched.map((kw) => (
                    <span key={kw} className="kw">
                      {kw}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <a className="apply" href={j.url} target="_blank" rel="noopener noreferrer">
              View role →
            </a>
          </article>
        ))}
      </div>

      <div className="footer">
        Sources: company careers APIs (Greenhouse, Workday, Microsoft, Google, Amazon, Meta). Best-effort
        — failed sources are skipped. Jobs older than 60 days are filtered out.
      </div>
    </div>
  );
}

function scoreLabel(score) {
  if (score >= 90) return 'strong match';
  if (score >= 70) return 'great match';
  if (score >= 55) return 'good match';
  return 'match';
}
