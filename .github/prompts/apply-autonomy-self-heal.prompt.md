---
name: Apply Autonomy Self-Heal
description: "Implement a deterministic autonomy fix with strict verification and rollback evidence."
argument-hint: "Provide confirmed root cause and exact file boundaries."
agent: "Autonomy Orchestrator"
---
Implement the smallest deterministic autonomy remediation.

Requirements:
- Limit changes to confirmed root-cause files.
- Avoid unrelated refactors.
- Run full required checks.
- Produce explicit rollback steps.

Required checks:
- npm run autonomy:check
- npm run verify

Return concise sections for:
1. Changes made
2. Why each change is needed
3. Verification evidence
4. Rollback plan
