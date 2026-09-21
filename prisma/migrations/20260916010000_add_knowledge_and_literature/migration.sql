-- Admin-uploaded research PDFs for the Knowledge Base. Each PDF is ingested by
-- the AI/PDF pipeline into structured LiteratureEntry rows; every entry links
-- back to its source PDF through sourcePdfId so provenance is always traceable.
CREATE TABLE "KnowledgeSourcePdf" (
    "id" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'application/pdf',
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_INGESTION',
    "error" TEXT,
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "uploadedByUserId" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeSourcePdf_pkey" PRIMARY KEY ("id")
);

-- Structured, curated research entries extracted from source PDFs. Mirrors the
-- correlation engine's LiteratureResult shape and stays host-linked via
-- sourcePdfId (cascade delete when a source PDF is retracted).
CREATE TABLE "LiteratureEntry" (
    "id" TEXT NOT NULL,
    "sourcePdfId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "journal" TEXT,
    "year" INTEGER,
    "abstract" TEXT,
    "url" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'CURATED',
    "doi" TEXT,
    "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "relevanceScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiteratureEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KnowledgeSourcePdf_status_idx" ON "KnowledgeSourcePdf"("status");
CREATE INDEX "KnowledgeSourcePdf_uploadedAt_idx" ON "KnowledgeSourcePdf"("uploadedAt");
CREATE INDEX "LiteratureEntry_sourcePdfId_idx" ON "LiteratureEntry"("sourcePdfId");
CREATE INDEX "LiteratureEntry_title_idx" ON "LiteratureEntry"("title");

ALTER TABLE "KnowledgeSourcePdf" ADD CONSTRAINT "KnowledgeSourcePdf_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LiteratureEntry" ADD CONSTRAINT "LiteratureEntry_sourcePdfId_fkey" FOREIGN KEY ("sourcePdfId") REFERENCES "KnowledgeSourcePdf"("id") ON DELETE CASCADE ON UPDATE CASCADE;