#!/usr/bin/env node

import process from 'node:process';
import { buildRecoveryPlaybooks } from '../functions/api/admin/autonomy.js';

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');

const env = {
  GITHUB_REPO: String(process.env.GITHUB_REPOSITORY || process.env.GITHUB_REPO || '').trim(),
  SITE_PASSWORD_HASH: String(process.env.SITE_PASSWORD_HASH || '').trim(),
  TOKEN_SECRET: String(process.env.TOKEN_SECRET || '').trim(),
  ADMIN_PASSWORD_HASH: String(process.env.ADMIN_PASSWORD_HASH || '').trim(),
  UPLOAD_PASSWORD_HASH: String(process.env.UPLOAD_PASSWORD_HASH || '').trim(),
  GITHUB_PAT: String(process.env.GITHUB_PAT || '').trim(),
  B2_KEY_ID: String(process.env.B2_KEY_ID || '').trim(),
  B2_APP_KEY: String(process.env.B2_APP_KEY || '').trim(),
  B2_ENDPOINT: String(process.env.B2_ENDPOINT || '').trim(),
  B2_BUCKET: String(process.env.B2_BUCKET || '').trim(),
  ANTHROPIC_API_KEY: String(process.env.ANTHROPIC_API_KEY || '').trim(),
  RESEND_API_KEY: String(process.env.RESEND_API_KEY || '').trim(),
  WEEKLY_DIGEST_FROM: String(process.env.WEEKLY_DIGEST_FROM || '').trim(),
  WEEKLY_DIGEST_REVIEW_RECIPIENTS: String(process.env.WEEKLY_DIGEST_REVIEW_RECIPIENTS || '').trim(),
  WEEKLY_DIGEST_RECIPIENTS: String(process.env.WEEKLY_DIGEST_RECIPIENTS || '').trim(),
  DIGEST_CRON_SECRET: String(process.env.DIGEST_CRON_SECRET || '').trim(),
  RATE_LIMIT_KV: process.env.RATE_LIMIT_KV ? {} : null,
  AUDIT_LOG_KV: process.env.AUDIT_LOG_KV ? {} : null,
  LOGS_KV: process.env.LOGS_KV ? {} : null,
};

const playbooks = buildRecoveryPlaybooks(env);

if (asJson) {
  process.stdout.write(`${JSON.stringify(playbooks, null, 2)}\n`);
  process.exit(0);
}

process.stdout.write(renderMarkdown(playbooks));

function renderMarkdown(rows) {
  const lines = ['## Environment Recovery Playbooks', ''];

  for (const row of rows) {
    lines.push(`### ${row.title}`);
    lines.push(`- Severity: ${row.severity}`);
    lines.push(`- Status: ${row.status}`);
    lines.push(`- Summary: ${row.summary}`);
    lines.push(`- Note: ${row.note}`);
    if (Array.isArray(row.missing) && row.missing.length) {
      lines.push(`- Missing: ${row.missing.join(', ')}`);
    }
    lines.push('');
    lines.push('```bash');
    for (const command of row.commands || []) {
      lines.push(String(command));
    }
    lines.push('```');
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}
