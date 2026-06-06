import {
  createDigestDraftIfMissing,
  getDigestNamespace,
  getReviewRecipients,
  json,
  sendReviewEmail,
} from '../../_lib/digest.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!(await isAuthorized(request, env))) {
    return json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  try {
    const result = await createDigestDraftIfMissing(env);
    const review = await deliverReview(env, result.draft);
    return json({ ok: true, created: result.created, review, draft: result.draft });
  } catch (error) {
    const status = String(error?.message || '').includes('No digest/admin KV configured') ? 503 : 500;
    return json({ ok: false, error: error?.message || 'Failed to create digest draft.' }, status);
  }
}

// Auto-sends the review email so the scheduled cron delivers it without manual
// intervention. Idempotent per window: a draft that already has reviewSentAt is
// left untouched, while a draft created on an earlier run that failed to send is
// retried here. A send failure is reported but does not discard the saved draft.
async function deliverReview(env, draft) {
  if (draft?.reviewSentAt) {
    return { sent: false, skipped: 'already-sent', sentAt: draft.reviewSentAt };
  }
  if (!getReviewRecipients(env).length) {
    return { sent: false, skipped: 'no-recipients' };
  }

  try {
    const result = await sendReviewEmail(getDigestNamespace(env), env, draft);
    return { sent: true, messageId: result?.id || null };
  } catch (error) {
    return { sent: false, error: error?.message || 'Failed to send review email.' };
  }
}

async function isAuthorized(request, env) {
  const expected = String(env.DIGEST_CRON_SECRET || '').trim();
  if (!expected) return false;

  const auth = String(request.headers.get('authorization') || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const header = String(request.headers.get('x-digest-cron-secret') || '').trim();
  const provided = bearer || header;
  if (!provided) return false;

  return timingSafeEqual(provided, expected);
}

async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(a)),
    crypto.subtle.sign('HMAC', key, enc.encode(b)),
  ]);
  const aArr = new Uint8Array(sigA);
  const bArr = new Uint8Array(sigB);
  let diff = 0;
  for (let i = 0; i < aArr.length; i++) diff |= aArr[i] ^ bArr[i];
  return diff === 0;
}
