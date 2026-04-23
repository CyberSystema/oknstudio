#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const json = args.has('--json');

const result = await run();

if (json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const lines = [
    'OKN Studio Autonomy Self-Heal',
    `Mode: ${apply ? 'apply' : 'dry-run'}`,
    `Changed files: ${result.changedFiles.length}`,
    `Potential fixes: ${result.fixes.length}`,
  ];
  if (result.fixes.length) {
    lines.push('', 'Fixes:');
    for (const fix of result.fixes) lines.push(`- ${fix}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function run() {
  const fixes = [];
  const changedFiles = [];

  const pkgPath = abs('package.json');
  const pkgRaw = await readText(pkgPath);
  let pkg = parseJson(pkgRaw);
  if (pkg && typeof pkg === 'object') {
    pkg.scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};

    if (pkg.scripts['autonomy:check'] !== 'node tools/autonomy-audit.mjs --strict') {
      pkg.scripts['autonomy:check'] = 'node tools/autonomy-audit.mjs --strict';
      fixes.push('package.json: restored scripts.autonomy:check');
    }

    const verify = String(pkg.scripts.verify || '').trim();
    const hasAutonomy = verify.includes('npm run autonomy:check');
    if (!hasAutonomy) {
      const base = verify || 'npm run check && npm test';
      pkg.scripts.verify = `${base} && npm run autonomy:check`;
      fixes.push('package.json: ensured verify includes autonomy:check');
    }

    const nextPkg = `${JSON.stringify(pkg, null, 2)}\n`;
    if (nextPkg !== pkgRaw) {
      if (apply) await writeFile(pkgPath, nextPkg, 'utf8');
      changedFiles.push(rel(pkgPath));
    }
  }

  const typeCheckPath = abs('.github/workflows/type-check.yml');
  let typeCheck = await readText(typeCheckPath);
  if (typeCheck) {
    const needle = 'run: npm run autonomy:check';
    if (!typeCheck.includes(needle)) {
      const anchor = /\n\s*- name:\s*🧪 Tests\n\s*run:\s*npm test\n/;
      const insertion = '\n      - name: 🛰️ Autonomy audit\n        run: npm run autonomy:check\n';
      if (anchor.test(typeCheck)) {
        typeCheck = typeCheck.replace(anchor, (m) => `${m}${insertion}`);
        fixes.push('type-check.yml: restored autonomy audit CI step');
        if (apply) await writeFile(typeCheckPath, typeCheck, 'utf8');
        changedFiles.push(rel(typeCheckPath));
      }
    }
  }

  const watchPath = abs('.github/workflows/autonomy-watch.yml');
  const watchOriginal = await readText(watchPath);
  let watch = watchOriginal;
  if (watch) {
    if (!watch.includes('npm run verify')) {
      const anchor = /\n\s*- name:\s*📥 Install\n\s*run:\s*npm install\n/;
      const insertion = '\n      - name: ✅ Verify repo\n        run: npm run verify\n';
      if (anchor.test(watch)) {
        watch = watch.replace(anchor, (m) => `${m}${insertion}`);
        fixes.push('autonomy-watch.yml: restored npm run verify step');
      }
    }

    if (!watch.includes('schedule:')) {
      const onBlock = /\non:\n(?:[\s\S]*?)\nconcurrency:/;
      if (onBlock.test(watch)) {
        watch = watch.replace(onBlock, (block) => {
          const onHeader = 'on:\n';
          if (!block.startsWith(onHeader)) return block;
          const body = block.slice(onHeader.length, -'\nconcurrency:'.length);
          const next = `on:\n  schedule:\n    - cron: '30 0 * * *'\n${body}\nconcurrency:`;
          return `\n${next}`;
        });
        fixes.push('autonomy-watch.yml: restored schedule trigger');
      }
    }

    if (watch !== watchOriginal) {
      if (apply) await writeFile(watchPath, watch, 'utf8');
      changedFiles.push(rel(watchPath));
    }
  }

  return {
    ok: true,
    mode: apply ? 'apply' : 'dry-run',
    changedFiles: Array.from(new Set(changedFiles)),
    fixes,
  };
}

function abs(filePath) {
  return path.join(root, filePath);
}

function rel(filePath) {
  return path.relative(root, filePath) || filePath;
}

async function readText(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
