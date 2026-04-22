#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const DEFAULT_SITE_URL = 'https://orthodoxkorea.org';
const DEFAULT_LOOKBACK_DAYS = 7;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function env(name, fallback = '') {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : fallback;
}

function isValidEmail(value) {
  const email = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parseRecipients(input) {
  const raw = String(input || '').replace(/\\n/g, '\n');
  const parts = raw
    .split(/[;,\n]/g)
    .map((v) => v.trim())
    .filter(Boolean);

  const unique = [];
  const seen = new Set();
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    unique.push(part);
  }

  return unique;
}

function toBoolean(value) {
  if (!value) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    // Collapse spaces that appear around apostrophes/hyphens due to HTML tags between chars
    .replace(/\s+([''\u2018\u2019\u2014\u2013-])\s+/g, '$1')
    .replace(/\s+(['])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
    .replace(/&#x([\da-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    // Common named entities not covered by numeric decoding
    .replace(/&hellip;/g, '\u2026')
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rdquo;/g, '\u201D')
    .replace(/&ldquo;/g, '\u201C')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&laquo;/g, '\u00AB')
    .replace(/&raquo;/g, '\u00BB')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toPlainText(html) {
  const text = decodeEntities(stripHtml(html || ''));
  // Strip WordPress read-more markers: [&hellip;] decoded to […] or [...]
  return text.replace(/\[\s*[\u2026\.]{1,3}\s*\]/g, '').replace(/\s+/g, ' ').trim();
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('el-GR', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    timeZone: 'Asia/Seoul',
  }).format(date);
}

function withinRange(isoDate, fromMs, toMs) {
  const t = new Date(isoDate).getTime();
  return Number.isFinite(t) && t >= fromMs && t <= toMs;
}

async function fetchWordPressPosts(siteUrl, afterIso) {
  const url = new URL('/wp-json/wp/v2/posts', siteUrl);
  url.searchParams.set('after', afterIso);
  url.searchParams.set('per_page', '100');
  url.searchParams.set('_fields', 'date,link,title,excerpt,content');

  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'okn-weekly-digest/1.0',
    },
  });

  if (!res.ok) {
    throw new Error(`WordPress API returned ${res.status}`);
  }

  const data = await res.json();
  if (!Array.isArray(data)) return [];

  return data
    .map((item) => ({
      title: decodeEntities(stripHtml(item?.title?.rendered || 'Untitled post')),
      link: item?.link || siteUrl,
      date: item?.date || new Date().toISOString(),
      excerpt: toPlainText(item?.excerpt?.rendered || ''),
      content: toPlainText(item?.content?.rendered || ''),
    }))
    .filter((item) => item.title && item.link);
}

function parseRss(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;

  let itemMatch = itemRegex.exec(xml);
  while (itemMatch) {
    const chunk = itemMatch[1] || '';

    const titleMatch = chunk.match(/<title>([\s\S]*?)<\/title>/i);
    const linkMatch = chunk.match(/<link>([\s\S]*?)<\/link>/i);
    const pubDateMatch = chunk.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);

    const title = decodeEntities(stripHtml(titleMatch?.[1] || 'Untitled post'));
    const link = decodeEntities(stripHtml(linkMatch?.[1] || ''));
    const date = new Date((pubDateMatch?.[1] || '').trim()).toISOString();

    if (title && link && date !== 'Invalid Date') {
      items.push({ title, link, date, excerpt: '', content: '' });
    }

    itemMatch = itemRegex.exec(xml);
  }

  return items;
}

async function fetchRssPosts(siteUrl) {
  const url = new URL('/feed/', siteUrl);
  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
      'User-Agent': 'okn-weekly-digest/1.0',
    },
  });

  if (!res.ok) {
    throw new Error(`RSS feed returned ${res.status}`);
  }

  const xml = await res.text();
  return parseRss(xml);
}

function looksGreekText(text) {
  const sample = String(text || '').slice(0, 6000);
  if (!sample) return false;

  const greekMatches = sample.match(/[\u0370-\u03FF\u1F00-\u1FFF]/g) || [];
  const latinMatches = sample.match(/[A-Za-z]/g) || [];
  const greekCount = greekMatches.length;
  const latinCount = latinMatches.length;

  return greekCount >= 20 && greekCount >= latinCount;
}

function isGreekPost(post) {
  const url = String(post?.link || '').toLowerCase();
  if (url.includes('/el/')) return true;

  const combined = [post?.title, post?.excerpt, post?.content].filter(Boolean).join(' ');
  return looksGreekText(combined);
}

function summarizationInput(post) {
  // Prefer full content over excerpt to avoid duplicated sentences.
  // The title is sent separately in the payload and must NOT be included here.
  const content = post?.content || '';
  const excerpt = post?.excerpt || '';
  const body = content.length >= excerpt.length ? content : excerpt;
  return body.slice(0, 9000);
}

function cleanSummaryText(summary) {
  const text = String(summary || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
  if (!text) return 'Δεν υπάρχει διαθέσιμη σύνοψη.';
  return text.length > 1200 ? `${text.slice(0, 1197)}...` : text;
}

let cachedAnthropicModels = null;

async function listAnthropicModels(apiKey) {
  if (cachedAnthropicModels) return cachedAnthropicModels;

  const res = await fetch('https://api.anthropic.com/v1/models', {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });

  if (!res.ok) {
    cachedAnthropicModels = [];
    return cachedAnthropicModels;
  }

  const data = await res.json().catch(() => ({}));
  const ids = Array.isArray(data?.data)
    ? data.data.map((m) => String(m?.id || '').trim()).filter(Boolean)
    : [];
  cachedAnthropicModels = ids;
  return cachedAnthropicModels;
}

function sortLikelyNewest(ids) {
  return [...ids].sort((a, b) => b.localeCompare(a));
}

// Claude summarizer — cheapest model, minimal tokens to preserve credits.
// Only used when ANTHROPIC_API_KEY is set. Falls back to local model otherwise.
async function summarizeWithClaude({ post, maxSentences }) {
  const apiKey = env('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  // claude-3-5-haiku pricing is low enough for weekly use.
  // Keep an explicit model env, but auto-fallback across known valid IDs
  // because Anthropic account access varies by model/version.
  const preferredModel = env('WEEKLY_DIGEST_CLAUDE_MODEL', 'claude-haiku-4-5');

  // Build model candidates from account-available models first.
  const availableModels = await listAnthropicModels(apiKey);
  const availableHaiku = sortLikelyNewest(availableModels.filter((id) => /haiku/i.test(id)));

  const modelCandidates = [
    preferredModel,
    ...availableHaiku,
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-3-5-haiku-latest',
    'claude-3-haiku-20240307',
  ].filter((m, idx, arr) => m && arr.indexOf(m) === idx);
  // 6000 chars (~1500 tokens) gives richer context while staying very low cost.
  const content = summarizationInput(post).slice(0, 6000);
  const title = post.title || '';

  const userPrompt =
    `Τίτλος: ${title}\n\nΠεριεχόμενο:\n${content}\n\n` +
    `Γράψε σύνοψη στα ελληνικά σε ${maxSentences} προτάσεις. ` +
    `Συμπεριέλαβε μόνο συγκεκριμένα γεγονότα. Μην επαναλαμβάνεις τον τίτλο.`;

  let lastError = '';
  for (const model of modelCandidates) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 350,
        temperature: 0,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      lastError = `model=${model} status=${res.status} body=${body.slice(0, 200)}`;
      // If the model is unavailable for this account, try next candidate.
      if (res.status === 404 || res.status === 400) continue;
      throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const summary = String(data?.content?.[0]?.text || '').trim();
    if (!summary) throw new Error('Anthropic API returned empty response');
    return summary;
  }

  throw new Error(`Anthropic model unavailable for this key: ${lastError || 'no candidate model succeeded'}`);
}

function summarizeInGreekWithLocalModel({ post, maxSentences }) {
  const text = summarizationInput(post);
  if (!text) {
    return 'Δεν υπάρχει επαρκές κείμενο για σύνοψη.';
  }

  const payload = {
    title: post.title || '',
    text,
    max_sentences: maxSentences,
    model_name: env('WEEKLY_DIGEST_SUMMARY_MODEL', 'intfloat/multilingual-e5-large-instruct'),
  };

  const run = spawnSync('python3', ['tools/greek_summarizer.py'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });

  if (run.error) {
    throw new Error(`Local summarizer execution failed: ${run.error.message}`);
  }

  if (run.status !== 0) {
    const stderr = String(run.stderr || '').trim();
    throw new Error(`Local summarizer failed (${run.status}): ${stderr.slice(0, 500)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(String(run.stdout || '{}'));
  } catch {
    throw new Error('Local summarizer returned invalid JSON');
  }

  const summary = String(parsed?.summary || '').trim();
  if (!summary) {
    throw new Error('Local summarizer returned an empty summary');
  }

  return summary;
}

async function summarizePostsInGreek(posts, { dryRun, maxSentences }) {
  const out = [];
  for (const post of posts) {
    try {
      let summary;
      try {
        summary = await summarizeWithClaude({ post, maxSentences });
      } catch (cloudErr) {
        // Local model is fallback only when the Anthropic call fails.
        console.warn(`[weekly-digest] Claude unavailable, using local fallback: ${cloudErr.message}`);
        summary = summarizeInGreekWithLocalModel({ post, maxSentences });
      }
      out.push({ ...post, summary: cleanSummaryText(summary) });
    } catch (err) {
      if (!dryRun) throw err;

      const fallback = summarizationInput(post).slice(0, 360);
      out.push({
        ...post,
        summary: cleanSummaryText(fallback
          ? `Πρόχειρη σύνοψη (dry run χωρίς μοντέλο): ${fallback}${fallback.length >= 360 ? '...' : ''}`
          : 'Δεν υπάρχει επαρκές κείμενο για σύνοψη.'),
      });
    }
  }
  return out;
}

function buildEmailBody({ siteUrl, fromMs, toMs, posts }) {
  const fromText = formatDate(new Date(fromMs).toISOString());
  const toText = formatDate(new Date(toMs).toISOString());
  const rangeText = `${fromText} to ${toText}`;

  if (!posts.length) {
    return {
      subject: `Εβδομαδιαίο δελτίο Orthodox Korea (${rangeText})`,
      text: [
        'Χριστός Ανέστη!',
        '',
        `Δεν δημοσιεύτηκαν νέες ελληνικές αναρτήσεις στο ${siteUrl} την τελευταία εβδομάδα (${rangeText}).`,
        '',
        `Ιστότοπος: ${siteUrl}`,
      ].join('\n'),
      html: [
        '<p>Χριστός Ανέστη!</p>',
        `<p>Δεν δημοσιεύτηκαν νέες ελληνικές αναρτήσεις στο <a href="${siteUrl}">${siteUrl}</a> την τελευταία εβδομάδα (${rangeText}).</p>`,
        `<p><a href="${siteUrl}">Επίσκεψη στο Orthodox Korea</a></p>`,
      ].join(''),
    };
  }

  const lines = posts.map((p, idx) => [
    `${idx + 1}. ${p.title} (${formatDate(p.date)})`,
    `${p.link}`,
    `Σύνοψη: ${p.summary || 'Δεν υπάρχει διαθέσιμη σύνοψη.'}`,
  ].join('\n'));
  const htmlItems = posts
    .map((p) => {
      const safeTitle = escapeHtml(p.title);
      const safeSummary = escapeHtml(p.summary || 'Δεν υπάρχει διαθέσιμη σύνοψη.');
      return `<li><a href="${p.link}">${safeTitle}</a> <em>(${formatDate(p.date)})</em><br><strong>Σύνοψη:</strong> ${safeSummary}</li>`;
    })
    .join('');

  return {
    subject: `Εβδομαδιαίο δελτίο Orthodox Korea: ${posts.length} νέα ελληνική ανάρτηση${posts.length === 1 ? '' : 'ς'}`,
    text: [
      'Χριστός Ανέστη!',
      '',
      `Νέες ελληνικές αναρτήσεις από το ${siteUrl} για το διάστημα ${rangeText}:`,
      '',
      ...lines,
      '',
      `Ιστότοπος: ${siteUrl}`,
    ].join('\n'),
    html: [
      '<p>Χριστός Ανέστη!</p>',
      `<p>Νέες ελληνικές αναρτήσεις από το <a href="${siteUrl}">${siteUrl}</a> για το διάστημα ${rangeText}:</p>`,
      `<ol>${htmlItems}</ol>`,
      `<p><a href="${siteUrl}">Επίσκεψη στο Orthodox Korea</a></p>`,
    ].join(''),
  };
}

async function sendWithResend({ apiKey, from, to, subject, text, html }) {
  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, text, html }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Resend API failed (${response.status}): ${detail.slice(0, 500)}`);
  }

  return response.json();
}

async function getPostsForLastWeek(siteUrl, lookbackDays) {
  const nowMs = Date.now();
  const fromMs = nowMs - lookbackDays * 24 * 60 * 60 * 1000;
  const afterIso = new Date(fromMs).toISOString();

  let posts = [];
  let source = 'wordpress-api';

  try {
    posts = await fetchWordPressPosts(siteUrl, afterIso);
  } catch (err) {
    source = 'rss-fallback';
    const rssPosts = await fetchRssPosts(siteUrl);
    posts = rssPosts.filter((p) => withinRange(p.date, fromMs, nowMs));
  }

  posts.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return { posts, fromMs, toMs: nowMs, source };
}

async function main() {
  const siteUrl = env('WEEKLY_DIGEST_SITE_URL', DEFAULT_SITE_URL);
  const lookbackDaysRaw = Number(env('WEEKLY_DIGEST_LOOKBACK_DAYS', String(DEFAULT_LOOKBACK_DAYS)));
  const lookbackDays = Number.isFinite(lookbackDaysRaw) && lookbackDaysRaw > 0 ? lookbackDaysRaw : DEFAULT_LOOKBACK_DAYS;

  const recipientsList = env('WEEKLY_DIGEST_RECIPIENTS', '');
  const recipientSingle = env('WEEKLY_DIGEST_RECIPIENT', '');
  const recipients = parseRecipients([recipientsList, recipientSingle].filter(Boolean).join(','));
  const sender = env('WEEKLY_DIGEST_FROM', '');
  const resendApiKey = env('RESEND_API_KEY', '');
  const anthropicApiKey = env('ANTHROPIC_API_KEY', '');
  const maxSummarySentencesRaw = Number(env('WEEKLY_DIGEST_SUMMARY_MAX_SENTENCES', '3'));
  const maxSummarySentences = Number.isFinite(maxSummarySentencesRaw) && maxSummarySentencesRaw > 0
    ? Math.min(5, Math.max(1, Math.floor(maxSummarySentencesRaw)))
    : 3;
  const summaryModel = env('WEEKLY_DIGEST_SUMMARY_MODEL', 'intfloat/multilingual-e5-large-instruct');
  const dryRun = toBoolean(env('WEEKLY_DIGEST_DRY_RUN', 'false'));

  if (!recipients.length) {
    throw new Error('At least one recipient is required via WEEKLY_DIGEST_RECIPIENT or WEEKLY_DIGEST_RECIPIENTS.');
  }

  const invalidRecipients = recipients.filter((email) => !isValidEmail(email));
  if (invalidRecipients.length) {
    throw new Error(`Invalid recipient email(s): ${invalidRecipients.join(', ')}`);
  }

  if (!sender) {
    throw new Error('WEEKLY_DIGEST_FROM is required.');
  }

  if (!dryRun && !resendApiKey) {
    throw new Error('RESEND_API_KEY is required unless WEEKLY_DIGEST_DRY_RUN=true.');
  }

  if (!dryRun && !anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is required unless WEEKLY_DIGEST_DRY_RUN=true.');
  }

  const { posts, fromMs, toMs, source } = await getPostsForLastWeek(siteUrl, lookbackDays);
  const greekPosts = posts.filter(isGreekPost);
  const summarizedGreekPosts = await summarizePostsInGreek(greekPosts, {
    dryRun,
    maxSentences: maxSummarySentences,
  });
  const body = buildEmailBody({ siteUrl, fromMs, toMs, posts: summarizedGreekPosts });

  if (dryRun) {
    console.log('[DRY RUN] Weekly digest prepared');
    console.log(`Source: ${source}`);
    console.log(`Total posts found: ${posts.length}`);
    console.log(`Greek posts kept: ${greekPosts.length}`);
    console.log(`AI model: local ${summaryModel}`);
    console.log(`Summary sentences per post: ${maxSummarySentences}`);
    console.log(`Recipients: ${recipients.join(', ')}`);
    console.log(`Subject: ${body.subject}`);
    console.log('Text preview:');
    console.log(body.text);
    return;
  }

  const result = await sendWithResend({
    apiKey: resendApiKey,
    from: sender,
    to: recipients,
    subject: body.subject,
    text: body.text,
    html: body.html,
  });

  console.log(`Digest sent to ${recipients.length} recipient(s).`);
  console.log(`Total posts found: ${posts.length}`);
  console.log(`Greek posts emailed: ${summarizedGreekPosts.length}`);
  console.log(`AI model: local ${summaryModel}`);
  console.log(`Summary sentences per post: ${maxSummarySentences}`);
  console.log(`Source: ${source}`);
  if (result?.id) {
    console.log(`Message ID: ${result.id}`);
  }
}

main().catch((err) => {
  console.error('[weekly-digest] Failed:', err?.message || err);
  process.exit(1);
});
