import { useEffect, useMemo, useState } from 'react';

const REGIONS = ['EMEA', 'India', 'Singapore', 'Dubai', 'USA'];
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
  const [region, setRegion] = useState('EMEA');
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

  const jobs = data?.jobs ?? [];

  const counts = useMemo(() => {
    const out = {};
    for (const r of REGIONS) out[r] = 0;
    for (const j of jobs) {
      if (out[j.region] !== undefined) out[j.region] += 1;
    }
    return out;
  }, [jobs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs
      .filter((j) => j.region === region)
      .filter((j) => (activeCompanies.size === 0 ? true : activeCompanies.has(j.company)))
      .filter((j) => (q ? `${j.title} ${j.location} ${j.company}`.toLowerCase().includes(q) : true))
      .sort((a, b) => new Date(b.posted_at || 0) - new Date(a.posted_at || 0));
  }, [jobs, region, activeCompanies, query]);

  function toggleCompany(c) {
    setActiveCompanies((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

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
        {REGIONS.map((r) => (
          <button
            key={r}
            className={`tab ${region === r ? 'active' : ''}`}
            onClick={() => setRegion(r)}
          >
            {r}
            <span className="count">({counts[r] ?? 0})</span>
          </button>
        ))}
      </div>

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
          No PM roles found for <strong>{region}</strong> with the current filters.
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
              </div>
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
