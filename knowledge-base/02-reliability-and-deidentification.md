# Reliability Scoring and De-Identification Gate

Every report submission is validated by a server-side reliability and de-identification quality gate before it is accepted.

## Mandatory Threshold

The mandatory reliability threshold is 0.80. Submissions scoring below this threshold are rejected, the associated PayPal authorisation is voided, and no data is retained.

## Reliability Score Computation

The reliability score is computed from the TOVA continuous-performance task output and the clinical checklist. Components include test/retest consistency, artifact control (ocular blink and electromyogram removal), and completeness of the forced Likert ratings across all eleven clinical domains (domain_1 to domain_11). Every domain must carry a rating from 0 (Absent) to 4 (Severe / Pervasive); blank domains invalidate the submission.

## De-Identification Enforcement

Ingested payloads are parsed client-side and server-side. Any payload that attempts to include directly identifying patient information such as a full name, birth date, or residential address is rejected with a mandatory zero-PII notice. Only Case Reference, Age, Gender, and Handedness demographic metrics are permitted.