---
name: Risk Gate Review
description: "Run strict safety review and block risky workflow edits without rollback documentation."
argument-hint: "Provide changed files and rollback section text."
agent: "risk-review-guardian"
---
Review these autonomy changes with strict risk-gate criteria.

You must block approval if:
- `.github/workflows/` changed with no explicit rollback steps.
- `tools/autonomy-*.mjs` changed with no explicit rollback steps.
- Automation blast radius increased without a risk statement.

Return exactly:
1. Decision: GO or NO-GO
2. Blocking findings
3. Required fixes
4. Accepted rollback plan (if GO)
