---
name: Triage Autonomy Incident
description: "Classify a failing autonomy incident and propose minimal safe remediation."
argument-hint: "Paste failing workflow name, symptoms, and timeframe."
agent: "Autonomy Orchestrator"
---
Triage this autonomy incident end-to-end.

Requirements:
- Identify likely root cause with evidence.
- Classify as code regression, config drift, external outage, or unknown.
- Propose minimal safe remediation options.
- Include rollback steps and confidence level.

Return concise sections for:
1. Classification
2. Evidence
3. Remediation options
4. Rollback plan
5. Confidence
