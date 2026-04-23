/**
 * OKN Studio — Admin Digest API
 * =============================
 * Private admin-only workflow for 15-day digest generation, review, editing,
 * preview, review-email notification, and final delivery.
 */

import {
  buildEmailBody,
  DIGEST_PREFIX,
  generateDigestDraft,
  getDigestNamespace,
  json,
  parseRecipients,
  requireDraft,
  saveDraft,
} from '../../_lib/digest.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export async function onRequestGet(context) {
  const { request, env } = context;
  const ns = getDigestNamespace(env);
  if (!ns) {
    return json({ ok: false, error: 'No digest/admin KV configured.' }, 503);
  }

  const url = new URL(request.url);
  const id = String(url.searchParams.get('id') || '').trim();

  if (id) {
    const record = await ns.get(`${DIGEST_PREFIX}${id}`, { type: 'json' });
    if (!record) return json({ ok: false, error: 'Digest draft not found.' }, 404);
    return json({ ok: true, draft: record });
  }

  const listed = await ns.list({ prefix: DIGEST_PREFIX, limit: 50 });
  const keys = (listed.keys || []).map((k) => k.name);
  const rows = await Promise.all(keys.map((k) => ns.get(k, { type: 'json' })));
  const drafts = rows
    .filter((row) => row && typeof row === 'object')
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));

  return json({ ok: true, drafts });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const ns = getDigestNamespace(env);
  if (!ns) {
    return json({ ok: false, error: 'No digest/admin KV configured.' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON.' }, 400);
  }

  const action = String(body.action || '').trim();
  if (!action) return json({ ok: false, error: 'Missing action.' }, 400);

  try {
    if (action === 'digest.generate') {
      const draft = await generateDigestDraft(env);
      await saveDraft(ns, draft);
      return json({ ok: true, draft });
    }

    if (action === 'digest.generateCustom') {
      const lookbackDays = Number(body.lookbackDays);
      if (!Number.isFinite(lookbackDays) || lookbackDays <= 0) {
        return json({ ok: false, error: 'lookbackDays must be a positive number.' }, 400);
      }
      const draft = await generateDigestDraft(env, { lookbackDays });
      await saveDraft(ns, draft);
      return json({ ok: true, draft });
    }

    if (action === 'digest.update') {
      const draft = await updateDraft(ns, body);
      return json({ ok: true, draft });
    }

    if (action === 'digest.removePost') {
      const draft = await removePostFromDraft(ns, body);
      return json({ ok: true, draft });
    }

    if (action === 'digest.delete') {
      const cleanId = String(body.id || '').trim();
      if (!cleanId) return json({ ok: false, error: 'Missing draft id.' }, 400);
      const existing = await ns.get(`${DIGEST_PREFIX}${cleanId}`, { type: 'json' });
      if (!existing) return json({ ok: false, error: 'Digest draft not found.' }, 404);
      await ns.delete(`${DIGEST_PREFIX}${cleanId}`);
      return json({ ok: true, deleted: true, id: cleanId });
    }

    if (action === 'digest.sendReview') {
      const draft = await requireDraft(ns, body.id);
      const reviewRecipients = parseRecipients(String(env.WEEKLY_DIGEST_REVIEW_RECIPIENTS || ''));
      if (!reviewRecipients.length) {
        return json({ ok: false, error: 'WEEKLY_DIGEST_REVIEW_RECIPIENTS is not configured.' }, 400);
      }
      const result = await sendDigestEmail(env, draft, reviewRecipients, '[READY FOR REVIEW]');
      draft.reviewSentAt = new Date().toISOString();
      draft.updatedAt = draft.reviewSentAt;
      draft.status = 'review-sent';
      draft.reviewMessageId = result?.id || '';
      await saveDraft(ns, draft);
      return json({ ok: true, draft, messageId: result?.id || null });
    }

    if (action === 'digest.sendFinal') {
      const draft = await requireDraft(ns, body.id);
      const recipients = parseRecipients(String(env.WEEKLY_DIGEST_RECIPIENTS || ''));
      if (!recipients.length) {
        return json({ ok: false, error: 'WEEKLY_DIGEST_RECIPIENTS is not configured.' }, 400);
      }
      const result = await sendDigestEmail(env, draft, recipients, '');
      draft.sentAt = new Date().toISOString();
      draft.updatedAt = draft.sentAt;
      draft.status = 'sent';
      draft.finalMessageId = result?.id || '';
      await saveDraft(ns, draft);
      return json({ ok: true, draft, messageId: result?.id || null });
    }

    return json({ ok: false, error: `Unsupported action: ${action}` }, 400);
  } catch (error) {
    return json({ ok: false, error: error?.message || 'Failed to process digest action.' }, 500);
  }
}

async function updateDraft(ns, body) {
  const draft = await requireDraft(ns, body.id);
  const currentPosts = Array.isArray(draft.posts) ? draft.posts : [];
  const incomingPosts = Array.isArray(body.posts) ? body.posts : [];
  const byIndex = new Map(
    incomingPosts
      .map((post) => [Number(post?.index), post])
      .filter(([index]) => Number.isInteger(index) && index >= 0)
  );
  const byLink = new Map(incomingPosts.map((post) => [String(post?.link || '').trim(), post]));

  draft.posts = currentPosts.map((post, index) => {
    const edited = byIndex.get(index) || byLink.get(String(post.link || '').trim());
    if (!edited) return post;
    const hasSummary = Object.prototype.hasOwnProperty.call(edited, 'summary');
    const nextSummary = hasSummary ? edited.summary : post.summary;
    return {
      ...post,
      summary: (nextSummary || '').trim(),
    };
  });

  rebuildDraftContent(draft);
  await saveDraft(ns, draft);
  return draft;
}

async function removePostFromDraft(ns, body) {
  const draft = await requireDraft(ns, body.id);
  const index = Number(body.index);
  const link = String(body.link || '').trim();
  const currentPosts = Array.isArray(draft.posts) ? draft.posts : [];
  let nextPosts;

  if (Number.isInteger(index) && index >= 0 && index < currentPosts.length) {
    nextPosts = currentPosts.filter((_, idx) => idx !== index);
  } else if (link) {
    nextPosts = currentPosts.filter((post) => String(post?.link || '').trim() !== link);
    if (nextPosts.length === currentPosts.length) throw new Error('Digest post not found.');
  } else {
    throw new Error('Missing post identifier.');
  }

  draft.posts = nextPosts;
  draft.greekPosts = nextPosts.length;
  rebuildDraftContent(draft);
  await saveDraft(ns, draft);
  return draft;
}

function rebuildDraftContent(draft) {
  draft.updatedAt = new Date().toISOString();
  draft.status = 'edited';
  const rebuilt = buildEmailBody({ siteUrl: draft.siteUrl, fromMs: draft.fromMs, toMs: draft.toMs, posts: draft.posts });
  draft.subject = rebuilt.subject;
  draft.text = rebuilt.text;
  draft.html = rebuilt.html;
}

async function sendDigestEmail(env, draft, recipients, subjectPrefix) {
  const from = String(env.WEEKLY_DIGEST_FROM || '').trim();
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  if (!from) throw new Error('WEEKLY_DIGEST_FROM is not configured.');
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured.');

  return sendWithResend({
    apiKey,
    from,
    to: recipients,
    subject: `${String(subjectPrefix || '').trim()} ${draft.subject}`.trim(),
    text: draft.text,
    html: draft.html,
  });
}

async function sendWithResend({ apiKey, from, to, subject, text, html }) {
  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, text, html }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Resend API failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  return response.json();
}
