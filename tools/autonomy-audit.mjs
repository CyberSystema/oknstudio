#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = new Set(process.argv.slice(2));
const root = process.cwd();

const report = await buildReport(root);

if (args.has('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  printReport(report);
}

if (args.has('--strict') && !report.ok) {
  process.exitCode = 1;
}

async function buildReport(projectRoot) {
  const checks = [];
  const existenceChecks = [];

  const packageJson = await readJson(projectRoot, 'package.json');
  const readme = await readText(projectRoot, 'README.md');
  const functionsReadme = await readText(projectRoot, 'functions/README.md');
  const typeCheckWorkflow = await readText(projectRoot, '.github/workflows/type-check.yml');
  const autonomyWatchWorkflow = await readText(projectRoot, '.github/workflows/autonomy-watch.yml');
  const autonomyEscalationWorkflow = await readText(projectRoot, '.github/workflows/autonomy-escalation.yml');
  const autonomySelfHealWorkflow = await readText(projectRoot, '.github/workflows/autonomy-self-heal.yml');
  const uptimeGuardianWorkflow = await readText(projectRoot, '.github/workflows/uptime-guardian.yml');
  const backupRestoreWorkflow = await readText(projectRoot, '.github/workflows/backup-restore-drill.yml');
  const secretGovernanceWorkflow = await readText(projectRoot, '.github/workflows/secret-rotation-governance.yml');
  const incidentTriageWorkflow = await readText(projectRoot, '.github/workflows/autonomy-incident-triage.yml');
  const dependabotAutomergeWorkflow = await readText(projectRoot, '.github/workflows/dependabot-automerge.yml');
  const deployWorkflow = await readText(projectRoot, '.github/workflows/deploy.yml');
  const analyticsWorkflow = await readText(projectRoot, '.github/workflows/analytics.yml');
  const dependabot = await readText(projectRoot, '.github/dependabot.yml');

  existenceChecks.push(checkExists(checks, projectRoot, 'README.md', 'critical', 'Project runbook exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, 'SECURITY.md', 'important', 'Security policy exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, 'functions/_middleware.js', 'critical', 'Edge authentication middleware exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, 'functions/api/admin/overview.js', 'critical', 'Runtime readiness endpoint exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, 'functions/api/admin/autonomy.js', 'important', 'Runtime autonomy endpoint exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, 'functions/api/admin/probes.js', 'critical', 'Synthetic probe endpoint exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, 'functions/api/admin/control-center.js', 'important', 'Operational control-center exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, 'functions/api/internal/digest-draft.js', 'important', 'Internal cron target exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, 'workers/digest-cron.mjs', 'important', 'Scheduled worker exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, 'site/status/index.html', 'important', 'Status page exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/workflows/type-check.yml', 'critical', 'Type-check workflow exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/workflows/autonomy-watch.yml', 'important', 'Scheduled autonomy watch workflow exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/workflows/autonomy-escalation.yml', 'important', 'Autonomy escalation workflow exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/workflows/autonomy-self-heal.yml', 'important', 'Autonomy self-heal workflow exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/workflows/uptime-guardian.yml', 'important', 'Uptime guardian workflow exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/workflows/backup-restore-drill.yml', 'important', 'Backup restore drill workflow exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/workflows/secret-rotation-governance.yml', 'important', 'Secret rotation governance workflow exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/workflows/autonomy-incident-triage.yml', 'important', 'Autonomy incident triage workflow exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/workflows/dependabot-automerge.yml', 'important', 'Dependabot auto-merge workflow exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/ISSUE_TEMPLATE/autonomy-task.yml', 'important', 'Autonomy task issue template exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/ISSUE_TEMPLATE/external-dependency-outage.yml', 'important', 'External dependency outage issue template exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/ISSUE_TEMPLATE/config.yml', 'important', 'Issue template config exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/pull_request_template.md', 'important', 'Pull request template exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/copilot-instructions.md', 'important', 'Copilot project instructions exist.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/agents/autonomy-orchestrator.agent.md', 'important', 'Autonomy orchestrator agent exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/agents/incident-triage.agent.md', 'important', 'Incident triage agent exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/agents/self-heal-implementer.agent.md', 'important', 'Self-heal implementer agent exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/agents/risk-review-guardian.agent.md', 'important', 'Risk review guardian agent exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/agents/verification-guardian.agent.md', 'important', 'Verification guardian agent exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/prompts/triage-autonomy-incident.prompt.md', 'important', 'Autonomy triage prompt exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/prompts/apply-autonomy-self-heal.prompt.md', 'important', 'Autonomy self-heal prompt exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/prompts/risk-gate-review.prompt.md', 'important', 'Autonomy risk gate prompt exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, 'tools/autonomy-incident-playbooks.mjs', 'important', 'Autonomy incident playbook script exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, 'tools/autonomy-self-heal.mjs', 'important', 'Autonomy self-heal script exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/workflows/deploy.yml', 'critical', 'Deploy workflow exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/workflows/analytics.yml', 'important', 'Analytics workflow exists.'));
  existenceChecks.push(checkExists(checks, projectRoot, '.github/dependabot.yml', 'important', 'Dependabot automation exists.'));

  checkBoolean(
    checks,
    !!packageJson?.scripts?.check,
    'critical',
    'Type-check script is defined.',
    'Missing npm script: check.'
  );
  checkBoolean(
    checks,
    !!packageJson?.scripts?.test,
    'critical',
    'Test script is defined.',
    'Missing npm script: test.'
  );
  checkBoolean(
    checks,
    !!packageJson?.scripts?.verify,
    'important',
    'Combined verification script is defined.',
    'Missing npm script: verify.'
  );

  checkIncludes(
    checks,
    String(packageJson?.scripts?.verify || ''),
    'autonomy:check',
    'important',
    'Verify script includes autonomy audit.',
    'verify script does not run autonomy:check.'
  );

  checkIncludes(
    checks,
    typeCheckWorkflow,
    'npm run autonomy:check',
    'important',
    'CI runs the autonomy audit.',
    'Type-check workflow does not run autonomy audit.'
  );
  checkIncludes(
    checks,
    autonomyWatchWorkflow,
    'schedule:',
    'important',
    'Autonomy watch workflow runs on a schedule.',
    'Autonomy watch workflow is missing a schedule trigger.'
  );
  checkIncludes(
    checks,
    autonomyWatchWorkflow,
    'npm run verify',
    'important',
    'Autonomy watch workflow runs the full verification path.',
    'Autonomy watch workflow does not run npm run verify.'
  );
  checkIncludes(
    checks,
    autonomyEscalationWorkflow,
    "workflows: ['Autonomy Watch']",
    'important',
    'Autonomy escalation workflow listens to Autonomy Watch.',
    'Autonomy escalation workflow is not wired to Autonomy Watch.'
  );
  checkIncludes(
    checks,
    autonomyEscalationWorkflow,
    'issues: write',
    'important',
    'Autonomy escalation workflow can write incident issues.',
    'Autonomy escalation workflow is missing issues: write permissions.'
  );
  checkIncludes(
    checks,
    autonomyEscalationWorkflow,
    'tools/autonomy-incident-playbooks.mjs',
    'important',
    'Autonomy escalation workflow attaches generated recovery playbooks.',
    'Autonomy escalation workflow does not generate recovery playbooks for incidents.'
  );
  checkIncludes(
    checks,
    autonomySelfHealWorkflow,
    "workflows: ['Autonomy Watch']",
    'important',
    'Autonomy self-heal workflow listens to Autonomy Watch.',
    'Autonomy self-heal workflow is not wired to Autonomy Watch.'
  );
  checkIncludes(
    checks,
    autonomySelfHealWorkflow,
    'peter-evans/create-pull-request@',
    'important',
    'Autonomy self-heal workflow can create remediation PRs.',
    'Autonomy self-heal workflow is missing remediation PR creation.'
  );
  checkIncludes(
    checks,
    uptimeGuardianWorkflow,
    'uptime-alert',
    'important',
    'Uptime guardian workflow manages uptime incidents.',
    'Uptime guardian workflow is missing uptime incident management.'
  );
  checkIncludes(
    checks,
    backupRestoreWorkflow,
    'backup-alert',
    'important',
    'Backup restore drill workflow raises backup incidents on failure.',
    'Backup restore drill workflow is missing failure escalation.'
  );
  checkIncludes(
    checks,
    secretGovernanceWorkflow,
    'secrets-rotation',
    'important',
    'Secret rotation governance workflow tracks monthly rotation tasks.',
    'Secret rotation governance workflow is missing rotation issue tracking.'
  );
  checkIncludes(
    checks,
    incidentTriageWorkflow,
    '@copilot',
    'important',
    'Incident triage workflow delegates coding follow-up to Copilot.',
    'Incident triage workflow is missing Copilot delegation guidance.'
  );
  checkIncludes(
    checks,
    incidentTriageWorkflow,
    'Copilot prompt playbook for this incident',
    'important',
    'Incident triage workflow posts a Copilot prompt playbook comment.',
    'Incident triage workflow is missing Copilot prompt playbook comment guidance.'
  );
  checkIncludes(
    checks,
    incidentTriageWorkflow,
    'requiredPromptFiles',
    'important',
    'Incident triage workflow verifies required prompt files exist.',
    'Incident triage workflow is missing required prompt file validation.'
  );
  checkIncludes(
    checks,
    incidentTriageWorkflow,
    'Prompt playbook unavailable: required prompt files are missing.',
    'important',
    'Incident triage workflow posts fallback warning when prompt files are missing.',
    'Incident triage workflow is missing fallback warning behavior for prompt drift.'
  );
  checkIncludes(
    checks,
    dependabotAutomergeWorkflow,
    'dependabot/fetch-metadata@',
    'important',
    'Dependabot auto-merge workflow enforces metadata-based merge guards.',
    'Dependabot auto-merge workflow is missing metadata guard rails.'
  );
  checkIncludes(
    checks,
    readTextSafe(await readText(projectRoot, '.github/ISSUE_TEMPLATE/config.yml')),
    'blank_issues_enabled: false',
    'important',
    'Issue templates enforce non-blank issue intake.',
    'Issue template config does not disable blank issues.'
  );

  checkIncludes(
    checks,
    dependabot,
    'package-ecosystem: npm',
    'important',
    'Dependabot covers npm.',
    'Dependabot is missing npm updates.'
  );
  checkIncludes(
    checks,
    dependabot,
    'package-ecosystem: pip',
    'important',
    'Dependabot covers Python pipeline dependencies.',
    'Dependabot is missing pip updates.'
  );
  checkIncludes(
    checks,
    dependabot,
    'package-ecosystem: github-actions',
    'important',
    'Dependabot covers GitHub Actions.',
    'Dependabot is missing GitHub Actions updates.'
  );

  checkIncludes(
    checks,
    analyticsWorkflow,
    'schedule:',
    'important',
    'Analytics workflow has scheduled automation.',
    'Analytics workflow is missing a cron schedule.'
  );
  checkBoolean(
    checks,
    deployWorkflow.includes('cloudflare/wrangler-action@') && deployWorkflow.includes('command: pages deploy '),
    'important',
    'Deploy workflow performs Cloudflare Pages deployment.',
    'Deploy workflow does not contain the Pages deploy command.'
  );

  checkIncludes(
    checks,
    readme,
    '## Workflows',
    'important',
    'README documents automated workflows.',
    'README is missing a workflows section.'
  );
  checkIncludes(
    checks,
    readme,
    '## Weekly Post Digest',
    'important',
    'README documents the digest automation path.',
    'README is missing digest automation documentation.'
  );
  checkIncludes(
    checks,
    readme,
    '## Autonomy & Self-Maintenance',
    'important',
    'README documents the autonomy contract.',
    'README is missing the autonomy/self-maintenance section.'
  );
  checkIncludes(
    checks,
    readme,
    '### Live autonomy report',
    'important',
    'README documents the live autonomy report.',
    'README is missing live autonomy report documentation.'
  );
  checkIncludes(
    checks,
    readme,
    '### Automatic incident escalation',
    'important',
    'README documents automatic incident escalation.',
    'README is missing automatic incident escalation documentation.'
  );
  checkIncludes(
    checks,
    readme,
    '### Automatic self-healing',
    'important',
    'README documents automatic self-healing.',
    'README is missing automatic self-healing documentation.'
  );
  checkIncludes(
    checks,
    readme,
    '### Environment recovery playbooks',
    'important',
    'README documents environment recovery playbooks.',
    'README is missing environment recovery playbooks documentation.'
  );
  checkIncludes(
    checks,
    readme,
    'Incident playbooks are attached automatically',
    'important',
    'README documents incident playbook attachment behavior.',
    'README is missing incident playbook attachment documentation.'
  );
  checkIncludes(
    checks,
    readme,
    '### Dependabot guarded auto-merge',
    'important',
    'README documents Dependabot guarded auto-merge.',
    'README is missing Dependabot guarded auto-merge documentation.'
  );
  checkIncludes(
    checks,
    readme,
    '### Uptime guardian',
    'important',
    'README documents uptime guardian automation.',
    'README is missing uptime guardian documentation.'
  );
  checkIncludes(
    checks,
    readme,
    '### Backup and restore drill',
    'important',
    'README documents backup and restore drill automation.',
    'README is missing backup and restore drill documentation.'
  );
  checkIncludes(
    checks,
    readme,
    '### Secret rotation governance',
    'important',
    'README documents secret rotation governance.',
    'README is missing secret rotation governance documentation.'
  );
  checkIncludes(
    checks,
    readme,
    '### Incident triage bot',
    'important',
    'README documents incident triage bot behavior.',
    'README is missing incident triage bot documentation.'
  );
  checkIncludes(
    checks,
    readme,
    '### Structured Copilot intake templates',
    'important',
    'README documents structured Copilot intake templates.',
    'README is missing structured Copilot intake template documentation.'
  );
  checkIncludes(
    checks,
    readme,
    '### Copilot agent operating model',
    'important',
    'README documents Copilot agent operating model.',
    'README is missing Copilot agent operating model documentation.'
  );
  checkIncludes(
    checks,
    readme,
    '### Copilot prompt library',
    'important',
    'README documents Copilot prompt library.',
    'README is missing Copilot prompt library documentation.'
  );
  checkIncludes(
    checks,
    functionsReadme,
    'GET /api/admin/control-center',
    'important',
    'Functions README documents the operational control endpoint.',
    'Functions README is missing the control-center route documentation.'
  );
  checkIncludes(
    checks,
    functionsReadme,
    'GET /api/admin/autonomy',
    'important',
    'Functions README documents the autonomy route.',
    'Functions README is missing the autonomy route documentation.'
  );

  await Promise.all(existenceChecks);

  const summary = summarize(checks);

  return {
    ok: summary.criticalFailures === 0,
    generatedAt: new Date().toISOString(),
    score: summary.score,
    summary,
    recommendations: buildRecommendations(checks),
    checks,
  };
}

function summarize(checks) {
  const counts = {
    total: checks.length,
    passed: checks.filter((check) => check.ok).length,
    failed: checks.filter((check) => !check.ok).length,
    criticalFailures: checks.filter((check) => !check.ok && check.severity === 'critical').length,
    importantFailures: checks.filter((check) => !check.ok && check.severity === 'important').length,
    advisoryFailures: checks.filter((check) => !check.ok && check.severity === 'advisory').length,
  };

  const weights = { critical: 12, important: 5, advisory: 2 };
  const max = checks.reduce((sum, check) => sum + weights[check.severity], 0) || 1;
  const earned = checks.reduce((sum, check) => sum + (check.ok ? weights[check.severity] : 0), 0);

  return {
    ...counts,
    score: Math.round((earned / max) * 100),
  };
}

function buildRecommendations(checks) {
  return checks
    .filter((check) => !check.ok)
    .sort((left, right) => severityRank(left.severity) - severityRank(right.severity))
    .slice(0, 8)
    .map((check) => ({
      severity: check.severity,
      action: check.failure,
    }));
}

function severityRank(severity) {
  if (severity === 'critical') return 0;
  if (severity === 'important') return 1;
  return 2;
}

function checkExists(checks, projectRoot, relativePath, severity, success) {
  const entry = {
    id: `exists:${relativePath}`,
    severity,
    ok: false,
    success,
    failure: `Missing required file: ${relativePath}`,
    evidence: relativePath,
  };

  checks.push(entry);

  return access(path.join(projectRoot, relativePath))
    .then(() => {
      entry.ok = true;
    })
    .catch(() => {});
}

function checkBoolean(checks, ok, severity, success, failure) {
  checks.push({
    id: slugify(success),
    severity,
    ok,
    success,
    failure,
  });
}

function checkIncludes(checks, haystack, needle, severity, success, failure) {
  const ok = String(haystack || '').includes(needle);
  checks.push({
    id: slugify(`${success}:${needle}`),
    severity,
    ok,
    success,
    failure,
    evidence: needle,
  });
}

function readTextSafe(value) {
  return String(value || '');
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function readText(projectRoot, relativePath) {
  try {
    return await readFile(path.join(projectRoot, relativePath), 'utf8');
  } catch {
    return '';
  }
}

async function readJson(projectRoot, relativePath) {
  try {
    return JSON.parse(await readFile(path.join(projectRoot, relativePath), 'utf8'));
  } catch {
    return null;
  }
}

function printReport(report) {
  const lines = [
    'OKN Studio Autonomy Audit',
    `Score: ${report.score}/100`,
    `Status: ${report.ok ? 'PASS' : 'FAIL'}`,
    `Checks: ${report.summary.passed}/${report.summary.total} passing`,
    `Critical failures: ${report.summary.criticalFailures}`,
  ];

  if (report.recommendations.length) {
    lines.push('');
    lines.push('Top actions:');
    for (const recommendation of report.recommendations) {
      lines.push(`- [${recommendation.severity}] ${recommendation.action}`);
    }
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}
