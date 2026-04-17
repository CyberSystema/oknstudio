import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const baseUrl = (process.env.OKN_OG_STATUS_BASE_URL || 'https://oknstudio.cybersystema.com').replace(/\/$/, '');
const outputPath = path.join(__dirname, 'status-data.js');
const timeoutMs = Number.parseInt(process.env.OKN_OG_TIMEOUT_MS || '6000', 10);

const checks = [
  { key: 'site', label: 'SITE', path: '/', okStatuses: [200, 401] },
  { key: 'analytics', label: 'ANALYTICS', path: '/analytics/', okStatuses: [200, 401] },
  { key: 'media', label: 'MEDIA', path: '/media/', okStatuses: [200, 401] },
  { key: 'calendar', label: 'CALENDAR', path: '/calendar/', okStatuses: [200, 401] },
  { key: 'reports', label: 'REPORTS', path: '/analytics/full_results.json', okStatuses: [200, 401] },
];

function createController() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timer };
}

async function runCheck(check) {
  const started = Date.now();
  const { controller, timer } = createController();
  const url = `${baseUrl}${check.path}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'user-agent': 'okn-og-status-check/1.0',
        'accept': '*/*',
      },
    });
    clearTimeout(timer);

    const latencyMs = Date.now() - started;
    const ok = check.okStatuses.includes(response.status);

    return {
      ...check,
      url,
      ok,
      statusCode: response.status,
      latencyMs,
      state: ok ? 'operational' : 'down',
      detail: `${response.status} / ${latencyMs}ms`,
    };
  } catch (error) {
    clearTimeout(timer);
    const latencyMs = Date.now() - started;

    return {
      ...check,
      url,
      ok: false,
      statusCode: null,
      latencyMs,
      state: error.name === 'AbortError' ? 'timeout' : 'down',
      detail: error.name === 'AbortError' ? `timeout / ${latencyMs}ms` : `${error.name} / ${latencyMs}ms`,
    };
  }
}

function summarize(results) {
  const online = results.filter((result) => result.ok).length;
  const total = results.length;
  const averageLatencyMs = Math.round(
    results.reduce((sum, result) => sum + result.latencyMs, 0) / Math.max(total, 1)
  );

  let tone = 'operational';
  let label = `${online}/${total} SYSTEMS NOMINAL`;

  if (online === 0) {
    tone = 'down';
    label = 'SYSTEM FAILURE';
  } else if (online !== total) {
    tone = 'degraded';
    label = `${online}/${total} SYSTEMS ONLINE`;
  }

  return {
    tone,
    label,
    shortLabel: online === total ? 'SYNC OK' : online === 0 ? 'SYNC LOST' : 'DEGRADED',
    online,
    total,
    averageLatencyMs,
  };
}

function toPayload(results) {
  const summary = summarize(results);

  return {
    generatedAt: new Date().toISOString(),
    baseUrl,
    version: 'v1.0',
    summary,
    checks: results.map(({ key, label, state, detail, latencyMs, statusCode }) => ({
      key,
      label,
      state,
      detail,
      latencyMs,
      statusCode,
    })),
  };
}

function serialize(payload) {
  return `window.OKN_OG_STATUS = ${JSON.stringify(payload, null, 2)};\n`;
}

async function main() {
  const results = await Promise.all(checks.map(runCheck));
  const payload = toPayload(results);
  await writeFile(outputPath, serialize(payload), 'utf8');

  const failed = payload.checks.filter((check) => check.state !== 'operational');
  console.log(`OG status generated: ${payload.summary.label} (${payload.summary.averageLatencyMs}ms avg)`);
  if (failed.length > 0) {
    console.log(`Checks requiring attention: ${failed.map((check) => `${check.label}:${check.detail}`).join(', ')}`);
  }
}

main().catch((error) => {
  console.error(`Failed to generate OG status: ${error.stack || error.message}`);
  process.exitCode = 1;
});