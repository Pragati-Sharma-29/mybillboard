#!/usr/bin/env node
// Daily WhatsApp digest: top 5 matched PM roles based on Pragati's profile.
//
// Run after scripts/scrape.mjs. Sends via whichever provider is configured
// (env vars). If neither provider is configured, exits 0 silently — the
// workflow keeps going.
//
// Providers (set as GitHub Actions secrets):
//
//   1) CallMeBot (free, personal use only):
//        CALLMEBOT_PHONE   — your number in international format, no +,
//                            e.g. "918105509308"
//        CALLMEBOT_APIKEY  — apikey returned by the CallMeBot bot
//        Setup: https://www.callmebot.com/blog/free-api-whatsapp-messages/
//
//   2) WhatsApp Cloud API (Meta, official):
//        WHATSAPP_TOKEN    — permanent system user access token
//        WHATSAPP_PHONE_ID — sender phone number ID (from Meta dashboard)
//        WHATSAPP_TO       — recipient in E.164 without +, e.g. "918105509308"
//        WHATSAPP_TEMPLATE — (optional) approved template name; if set,
//                            sends a template message instead of free-form.
//                            Required when the recipient hasn't messaged
//                            the sender in the last 24h.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMatch, MATCH_THRESHOLD } from '../src/matchProfile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOBS_PATH = resolve(__dirname, '..', 'public', 'jobs.json');
const SITE_URL =
  process.env.SITE_URL || 'https://pragati-sharma-29.github.io/mybillboard/';
const TOP_N = 5;

const data = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const scored = (data.jobs || []).map((j) => ({ ...j, ...computeMatch(j) }));
const top = scored
  .filter((j) => j.score >= MATCH_THRESHOLD)
  .sort((a, b) => b.score - a.score)
  .slice(0, TOP_N);

if (top.length === 0) {
  console.log('No matches above threshold today; skipping WhatsApp notification.');
  process.exit(0);
}

const today = new Date().toLocaleDateString('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric',
});

const lines = [`*PM Job Board — top ${top.length} today (${today})*`, ''];
for (let i = 0; i < top.length; i++) {
  const j = top[i];
  lines.push(`${i + 1}. *${j.title}*`);
  lines.push(`   ${j.company} · ${j.region} · ${truncate(j.location, 60)}`);
  lines.push(`   match ${j.score} · ${j.url}`);
  lines.push('');
}
lines.push(`Full board: ${SITE_URL}`);
const message = lines.join('\n');

console.log('Message preview:\n' + message + '\n---');

const hasCloud =
  process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID && process.env.WHATSAPP_TO;
const hasCallMeBot = process.env.CALLMEBOT_PHONE && process.env.CALLMEBOT_APIKEY;

if (hasCloud) {
  await sendCloudApi(message);
} else if (hasCallMeBot) {
  await sendCallMeBot(message);
} else {
  console.log('No WhatsApp provider configured — set CALLMEBOT_* or WHATSAPP_* secrets to enable.');
  process.exit(0);
}

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

async function sendCallMeBot(text) {
  const url =
    `https://api.callmebot.com/whatsapp.php` +
    `?phone=${encodeURIComponent(process.env.CALLMEBOT_PHONE)}` +
    `&apikey=${encodeURIComponent(process.env.CALLMEBOT_APIKEY)}` +
    `&text=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  const body = await res.text();
  console.log(`CallMeBot HTTP ${res.status}`);
  console.log(body.slice(0, 400));
  if (!res.ok) process.exit(1);
}

async function sendCloudApi(text) {
  const endpoint = `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
  const body = process.env.WHATSAPP_TEMPLATE
    ? {
        messaging_product: 'whatsapp',
        to: process.env.WHATSAPP_TO,
        type: 'template',
        template: {
          name: process.env.WHATSAPP_TEMPLATE,
          language: { code: 'en_US' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text }] },
          ],
        },
      }
    : {
        messaging_product: 'whatsapp',
        to: process.env.WHATSAPP_TO,
        type: 'text',
        text: { preview_url: false, body: text },
      };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const respBody = await res.text();
  console.log(`Cloud API HTTP ${res.status}`);
  console.log(respBody.slice(0, 400));
  if (!res.ok) process.exit(1);
}
