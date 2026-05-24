# PM Job Board

A daily-refreshed job board for **Product Manager** roles across **EMEA, India, Singapore, Dubai, and USA**, pulled from top firms:

Google · Microsoft · Meta · Uber · Canva · Databricks · Snowflake · Atlan · Grab · Salesforce · Amazon / AWS

Roles older than 60 days are filtered out.

## How it works

- **Frontend**: React + Vite static site (`src/`, built into `dist/`). Tabs by region, free-text search, company chips.
- **Scraper**: `scripts/scrape.mjs` — hits each company's public careers API (Greenhouse for Canva / Databricks / Snowflake / Atlan / Grab; Microsoft / Google / Amazon search APIs; Workday for Salesforce; Uber & Meta best-effort). Writes `public/jobs.json`.
- **Daily refresh**: GitHub Actions workflow (`.github/workflows/daily.yml`) runs the scraper at 06:17 UTC every day, commits the updated JSON, rebuilds, and deploys to GitHub Pages.

Sources are best-effort: any source that returns 4xx/5xx, times out, or changes shape is logged and skipped — the rest of the board still ships.

## Local development

```bash
npm install
npm run scrape   # populate public/jobs.json
npm run dev      # http://localhost:5173
```

## Build

```bash
npm run build    # outputs to dist/
npm run preview
```

## Deploying

The workflow deploys to GitHub Pages. To enable:

1. Repo **Settings → Pages → Source → GitHub Actions**.
2. Make sure the repo allows Actions to write (`Settings → Actions → General → Workflow permissions → Read and write`).
3. Push to `main` (or trigger via **Actions → Daily refresh + deploy → Run workflow**).

Site URL: `https://<user>.github.io/mybillboard/`. If you fork or rename, override the base path via `VITE_BASE` in the workflow.

## Customizing

- **Add a company**: append an entry to `SOURCES` in `scripts/scrape.mjs` and add the name to `COMPANIES` in `src/App.jsx`.
- **Change the freshness cutoff**: edit `MAX_AGE_DAYS` in `scripts/scrape.mjs`.
- **Refine PM filter**: edit `isPMTitle()` in `scripts/scrape.mjs`.
- **Region buckets**: edit the keyword arrays + `classifyRegion()` in `scripts/scrape.mjs`.
