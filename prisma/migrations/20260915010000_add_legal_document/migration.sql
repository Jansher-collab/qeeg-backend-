-- Registry of current + historical legal documents (DPA/EULA). PDFs live on disk
-- (uploads/legal/<type>-<version>.pdf); this table tracks version, size, sha256,
-- the activating admin, and whether the row is the currently-served version.
CREATE TABLE "LegalDocument" (
    "id" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'application/pdf',
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "uploadedByUserId" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalDocument_pkey" PRIMARY KEY ("id")
);

-- Enforce exactly one active version per document type at the DB level.
CREATE UNIQUE INDEX "LegalDocument_single_active_per_type" ON "LegalDocument"("documentType") WHERE "isActive" = true;

-- Matches the @@unique([documentType, version]) in schema.prisma
CREATE UNIQUE INDEX "LegalDocument_documentType_version_key" ON "LegalDocument"("documentType", "version");

-- Matches the @@index([documentType, isActive]) and @@index([documentType, uploadedAt]) declarations
CREATE INDEX "LegalDocument_documentType_isActive_idx" ON "LegalDocument"("documentType", "isActive");
CREATE INDEX "LegalDocument_documentType_uploadedAt_idx" ON "LegalDocument"("documentType", "uploadedAt");

-- Foreign key to the uploading admin user (kept as audit metadata; safe if user deleted).
ALTER TABLE "LegalDocument" ADD CONSTRAINT "LegalDocument_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;