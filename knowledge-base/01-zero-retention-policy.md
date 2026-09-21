# Zero-Retention Data Policy

QEEG.com.au operates a strict zero-retention data policy in accordance with the Australian Privacy Act 1988 (Privacy Principles 1 to 13, with particular focus on Principle 11 — Security of Personal Information).

## Patient Data Minimisation

The platform never requests, stores, or processes patient full names, birth dates, addresses, or any other directly identifying personal information. Referring practitioners record only a unique Case Reference and basic demographic metrics: age (whole years), biological gender, and dominant handedness.

## Permanent Destruction on First Download

When a report is downloaded, the system performs a permanent, verifiable purge. Both the database record (findings, TOVA metrics, checklist data, report summary, and file paths) and all physical report artifacts on the Sydney sovereign server (ap-southeast-2) are destroyed. Once purged, the report cannot be retrieved again.

## Data Residency

All data is processed and stored in the ap-southeast-2 (Sydney) region on AWS sovereign infrastructure. No data leaves Australia.

## Compliance Term

Downloading a report constitutes acceptance of the zero-retention terms. Reports may only be downloaded once; subsequent download attempts return a 410 Gone status indicating the artifact has been permanently purged.