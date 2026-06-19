# PM Job Board

A daily-refreshed job board for **Product Manager** roles across **EMEA, India, Singapore, Dubai, and USA**, pulled from top firms:

Google · Microsoft · Meta · Uber · Canva · Databricks · Snowflake · Atlan · Grab · Salesforce · Amazon / AWS · Anthropic · OpenAI · Mistral

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

## Daily WhatsApp digest (top 5 matches)

After the daily scrape, `scripts/notify.mjs` ranks the day's roles, picks the top 5 above the match threshold, and pushes a WhatsApp message. The script is wired into the workflow but only fires on `schedule` / `workflow_dispatch` (never on every push).

Pick one provider and add the secrets in **Settings → Secrets and variables → Actions**:

### Option 1 — CallMeBot (fastest, free, personal use)

1. Save **+34 644 21 14 81** to your contacts.
2. Send `I allow callmebot to send me messages` from your WhatsApp to that number.
3. You'll get back an API key.
4. Add two repo secrets:
   - `CALLMEBOT_PHONE` — your number in E.164 without `+`, e.g. `918105509308`
   - `CALLMEBOT_APIKEY` — the apikey you received

That's it. The next scheduled run will message you.

### Option 2 — WhatsApp Cloud API (Meta, official)

1. Create an app on developers.facebook.com → add the **WhatsApp** product.
2. From the WhatsApp → API Setup page, copy:
   - **Access token** (use a permanent System User token in production, not the 24h temp token)
   - **Phone number ID**
3. Add a verified recipient phone number (or message your test number from your phone first).
4. Add repo secrets:
   - `WHATSAPP_TOKEN`
   - `WHATSAPP_PHONE_ID`
   - `WHATSAPP_TO` — recipient in E.164 without `+`
   - `WHATSAPP_TEMPLATE` — *(optional but recommended)* an approved template name. Free-form text only works inside the 24h customer-initiated window; for proactive daily alerts you need a template. Create one with a single body parameter that takes the digest text.

If both providers are configured, Cloud API wins.

If neither is configured, the notify step exits 0 silently — the workflow still deploys the site.

## LinkedIn job alerts as a source

LinkedIn doesn't expose a scrape-friendly API, but their daily job-alert emails are perfect raw material. We pipe them into the board via a Google Apps Script that reads your Gmail and pushes parsed jobs to `data/linkedin.json`. The main scraper picks them up the same way it picks up Greenhouse/Lever.

**One-time setup is in `scripts/linkedin-gmail-sync.gs`** — paste that file into `script.google.com`, set three script properties (`GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_TOKEN`), run once to grant Gmail+UrlFetch permissions, schedule a daily trigger. Full step-by-step is in the file's header comment.

Once running, LinkedIn alerts flow into the same pipeline — same PM filter, same region tabs, same **It's a Match!** scoring, same WhatsApp digest.

## Adding a new company without writing code

Drop an entry into `sources.json`:

```json
{
  "sources": [
    { "name": "Stripe", "url": "https://boards.greenhouse.io/stripe" },
    { "name": "Some Co", "url": "https://jobs.lever.co/someco" },
    { "name": "Other", "url": "https://careers.other.com/jobs" }
  ]
}
```

The scraper auto-detects the ATS from the URL hostname:

| If URL contains | Routes to |
|---|---|
| `greenhouse.io` | Greenhouse API |
| `ashbyhq.com` | Ashby API |
| `lever.co` | Lever API |
| `smartrecruiters.com` | SmartRecruiters API |
| `myworkdayjobs.com` | Workday API |
| anything else | Generic HTML scrape (looks for `__NEXT_DATA__` + JSON-LD `JobPosting`) |

The generic scrape works for any modern careers page that hydrates from `__NEXT_DATA__` or emits JSON-LD. SPAs that load jobs purely via custom XHR after page load will return 0 from the generic path — those need a bespoke parser.

## Customizing

- **Add a company**: append an entry to `SOURCES` in `scripts/scrape.mjs` and add the name to `COMPANIES` in `src/App.jsx`.
- **Change the freshness cutoff**: edit `MAX_AGE_DAYS` in `scripts/scrape.mjs`.
- **Refine PM filter**: edit `isPMTitle()` in `scripts/scrape.mjs`.
- **Region buckets**: edit the keyword arrays + `classifyRegion()` in `scripts/scrape.mjs`.
