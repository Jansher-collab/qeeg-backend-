-- Enforce global uniqueness of the practitioner-facing Case Reference. The
-- reference keys the per-case upload directory (uploads/<caseReference>) and
-- the report's identity, so a collision could let a purge for one case delete
-- another case's files. Replaces the previous non-unique lookup index.
DROP INDEX IF EXISTS "QeeqReport_caseReference_idx";
CREATE UNIQUE INDEX "QeeqReport_caseReference_key" ON "QeeqReport"("caseReference");
