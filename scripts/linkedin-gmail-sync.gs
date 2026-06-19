/**
 * LinkedIn Job Alert → GitHub repository sync.
 *
 * Reads LinkedIn job-alert emails from your Gmail, extracts each job
 * (title, company, location, url, posted_at), and pushes them to
 * data/linkedin.json in the mybillboard repo via the GitHub Contents
 * API. Processed threads get a "job-board-processed" Gmail label so
 * they're never reparsed.
 *
 * The daily scrape pipeline (scripts/scrape.mjs) loads
 * data/linkedin.json and merges those jobs through the same PM-title
 * filter, region classifier, and dedup as every other source — so
 * LinkedIn-sourced roles show up alongside Greenhouse/Lever/etc. on
 * the board and in the WhatsApp digest.
 *
 * ============================================================
 * ONE-TIME SETUP
 * ============================================================
 *
 * 1. Configure LinkedIn job alerts (if you haven't already):
 *      linkedin.com/jobs/search/?keywords=product+manager
 *      → bell icon (top-right) → Manage alerts
 *      → set Frequency = Daily, Delivery = Email
 *      Repeat for each region/keyword combo you care about
 *      (India / Singapore / EMEA / Dubai / USA × any seniority).
 *
 * 2. Create a GitHub Personal Access Token:
 *      https://github.com/settings/personal-access-tokens/new
 *      • Resource owner: Pragati-Sharma-29
 *      • Repository access: Only select repositories → mybillboard
 *      • Permissions → Repository → Contents: Read and write
 *      • Generate, copy the token (starts with github_pat_...)
 *
 * 3. Paste this file into a new Google Apps Script project:
 *      script.google.com → New project
 *      → name it "LinkedIn → Job Board"
 *      → paste this code as Code.gs, save.
 *
 * 4. Set script properties:
 *      Project Settings (gear icon, left rail)
 *      → Script Properties → Add script property:
 *           GITHUB_OWNER  = Pragati-Sharma-29
 *           GITHUB_REPO   = mybillboard
 *           GITHUB_TOKEN  = (the PAT you just generated)
 *
 * 5. Run once manually to grant permissions:
 *      Editor → select syncLinkedInJobs from the function dropdown
 *      → Run. Google will prompt for Gmail + UrlFetch permissions —
 *      review and accept. The log (View → Logs) should show how many
 *      jobs got synced.
 *
 * 6. Schedule it daily:
 *      Triggers (clock icon, left rail) → Add Trigger
 *      → Function: syncLinkedInJobs
 *      → Event source: Time-driven
 *      → Type: Day timer → 7am-8am (or whatever you prefer)
 *      → Save.
 *
 * That's it. New jobs from LinkedIn alert emails will appear on the
 * board on the daily scrape that follows each sync.
 * ============================================================
 */

const PROP = PropertiesService.getScriptProperties();
const OWNER = PROP.getProperty('GITHUB_OWNER');
const REPO = PROP.getProperty('GITHUB_REPO');
const TOKEN = PROP.getProperty('GITHUB_TOKEN');
const FILE_PATH = 'data/linkedin.json';
const PROCESSED_LABEL = 'job-board-processed';
const MAX_AGE_DAYS = 60;

function syncLinkedInJobs() {
  if (!OWNER || !REPO || !TOKEN) {
    throw new Error(
      'Missing script properties. Set GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN in Project Settings.',
    );
  }

  const label =
    GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL);

  // LinkedIn sends alerts from a few addresses (jobs-noreply, jobalerts-noreply,
  // messages-noreply). The common ground is "from:linkedin.com" + a job-ish
  // subject. We skip anything already processed.
  const query =
    'from:linkedin.com (subject:"job" OR subject:"jobs" OR subject:"opportunity" OR subject:"alert" OR subject:"matches") -label:' +
    PROCESSED_LABEL +
    ' newer_than:30d';
  const threads = GmailApp.search(query, 0, 100);
  console.log('Found ' + threads.length + ' unprocessed LinkedIn threads');
  if (threads.length === 0) return;

  const newJobs = new Map();
  for (const thread of threads) {
    for (const message of thread.getMessages()) {
      const parsed = parseEmail(message);
      for (const job of parsed) {
        if (!newJobs.has(job.url)) newJobs.set(job.url, job);
      }
    }
  }
  console.log('Extracted ' + newJobs.size + ' unique job postings from this batch');

  if (newJobs.size > 0) {
    const existing = fetchExisting();
    const merged = new Map((existing.jobs || []).map((j) => [j.url, j]));
    for (const [url, job] of newJobs) {
      // Don't overwrite — preserve earliest posted_at and richest field set
      if (!merged.has(url)) merged.set(url, job);
    }

    // Drop entries older than MAX_AGE_DAYS so the file doesn't grow forever
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
    const fresh = Array.from(merged.values()).filter((j) => {
      if (!j.posted_at) return true;
      const t = new Date(j.posted_at).getTime();
      return !Number.isFinite(t) || t > cutoff;
    });
    fresh.sort(
      (a, b) => new Date(b.posted_at || 0).getTime() - new Date(a.posted_at || 0).getTime(),
    );

    pushToRepo(
      {
        _note:
          'Synced from LinkedIn job alert emails by scripts/linkedin-gmail-sync.gs',
        generated_at: new Date().toISOString(),
        jobs: fresh,
      },
      existing.sha,
    );
    console.log('Synced ' + fresh.length + ' total jobs to ' + OWNER + '/' + REPO);
  }

  // Mark all processed threads even if 0 new jobs were extracted (avoids
  // re-parsing emails that genuinely contain no usable postings).
  for (const thread of threads) thread.addLabel(label);
}

/**
 * Parse a single Gmail message into an array of job objects.
 * LinkedIn alert emails embed each job as a clickable title link to
 * /comm/jobs/view/{id}, with the company and location nearby.
 */
function parseEmail(message) {
  const jobs = [];
  const html = message.getBody();
  const date = message.getDate();
  if (!html) return jobs;

  const urlRe = /https?:\/\/www\.linkedin\.com\/comm\/jobs\/view\/(\d+)[^"'\s<>]*/g;
  const seen = new Set();
  let m;
  while ((m = urlRe.exec(html)) !== null) {
    const jobId = m[1];
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    // Title: text inside the <a href="...jobs/view/JOBID...">TITLE</a>
    const titleRe = new RegExp(
      '<a[^>]*?jobs\\/view\\/' + jobId + '[^>]*?>([\\s\\S]{0,500}?)<\\/a>',
      'i',
    );
    const tMatch = html.match(titleRe);
    const title = tMatch ? clean(stripHtml(tMatch[1])) : '';
    if (!title) continue;

    // Look at the next ~3KB after the link for company + location.
    const after = html.substring(m.index, Math.min(html.length, m.index + 3500));
    const lines = stripHtml(after)
      .split(/\n|\s{2,}/)
      .map(clean)
      .filter(Boolean);

    let company = '';
    let location = '';
    const noise = /^(view (job|all)|apply|easy apply|promoted|early applicant|hours? ago|days? ago|weeks? ago|months? ago|posted|new|\d+\+?\s+applicants?|see (all|jobs|more)|matches|recommend(ed|ation)s?|because you|linkedin|actively recruiting|\d[\d,]*\s+company alumni)/i;
    let pastTitle = false;
    const titleStart = title.substring(0, Math.min(15, title.length)).toLowerCase();
    for (const line of lines) {
      if (!pastTitle) {
        if (line.toLowerCase().indexOf(titleStart) !== -1) pastTitle = true;
        continue;
      }
      if (noise.test(line)) continue;
      if (line.length > 200) continue;

      // LinkedIn alert emails render "Company · Location" on a single
      // line, separated by U+00B7 middle dot. Detect and split.
      const dotIdx = line.indexOf('·');
      if (dotIdx > 0 && dotIdx < line.length - 1) {
        company = clean(line.substring(0, dotIdx));
        location = clean(line.substring(dotIdx + 1));
        break;
      }

      // Fall back to two-line layout (older email format or alternative
      // alert types where company and location are on separate lines).
      if (!company) {
        company = line;
        continue;
      }
      if (!location) {
        location = line;
        break;
      }
    }

    jobs.push({
      id: 'linkedin-' + jobId,
      company: company || 'LinkedIn',
      title,
      location,
      url: 'https://www.linkedin.com/jobs/view/' + jobId + '/',
      posted_at: date.toISOString(),
      source: 'linkedin',
    });
  }
  return jobs;
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function clean(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function fetchExisting() {
  const url =
    'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + FILE_PATH;
  const res = UrlFetchApp.fetch(url, {
    headers: {
      Authorization: 'token ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'mybillboard-linkedin-sync',
    },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 404) return { sha: null, jobs: [] };
  if (code >= 400) throw new Error('GitHub GET ' + code + ': ' + res.getContentText());
  const data = JSON.parse(res.getContentText());
  const decoded = Utilities.newBlob(Utilities.base64Decode(data.content)).getDataAsString();
  let json;
  try {
    json = JSON.parse(decoded);
  } catch {
    json = { jobs: [] };
  }
  return { sha: data.sha, jobs: Array.isArray(json.jobs) ? json.jobs : [] };
}

function pushToRepo(payload, sha) {
  const url =
    'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + FILE_PATH;
  const body = {
    message: 'chore: sync LinkedIn job alerts → data/linkedin.json',
    content: Utilities.base64Encode(JSON.stringify(payload, null, 2)),
  };
  if (sha) body.sha = sha;
  const res = UrlFetchApp.fetch(url, {
    method: 'put',
    headers: {
      Authorization: 'token ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'mybillboard-linkedin-sync',
    },
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 400) {
    throw new Error('GitHub PUT failed: ' + res.getContentText());
  }
}
