import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { prisma } from '../prisma';
import { logActivity } from './activityLogger';

export const LEGAL_DOCUMENT_TYPES = ['DPA', 'EULA'] as const;
export type LegalDocumentType = (typeof LEGAL_DOCUMENT_TYPES)[number];

export const MAX_LEGAL_DOCUMENT_BYTES = 20 * 1024 * 1024; // 20 MB

// Legal PDFs are permanent platform assets (not clinical data) and live in a
// dedicated directory alongside the report scratch space.
const LEGAL_DIR = path.join(process.cwd(), 'uploads', 'legal');

export function normalizeLegalType(value: string): LegalDocumentType | null {
  const upper = String(value).toUpperCase();
  return (LEGAL_DOCUMENT_TYPES as readonly string[]).includes(upper)
    ? (upper as LegalDocumentType)
    : null;
}

async function ensureLegalDir(): Promise<void> {
  await fs.mkdir(LEGAL_DIR, { recursive: true });
}

function versionDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Generates a unique document version. Defaults to the upload date (matching
 * the historical "2026-09-01" convention). If that version already exists for
 * the type (e.g. two uploads on the same day), a numeric suffix is appended:
 * 2026-09-15, 2026-09-15-2, 2026-09-15-3 ...
 */
export async function generateDocumentVersion(type: string): Promise<string> {
  const base = versionDate(new Date());
  let candidate = base;
  let suffix = 2;
  for (;;) {
    const existing = await prisma.legalDocument.findUnique({
      where: { documentType_version: { documentType: type, version: candidate } },
      select: { id: true },
    });
    if (!existing) return candidate;
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
}

/**
 * Returns the currently-active documents as a public-safe shape consumed by the
 * signup page and portal. `pdfUrl` is the backend route that streams the bytes.
 */
export async function getCurrentLegalDocuments() {
  const docs = await prisma.legalDocument.findMany({
    where: { isActive: true },
    orderBy: { uploadedAt: 'desc' },
  });
  return docs.map((d) => ({
    documentType: d.documentType,
    version: d.version,
    fileName: d.fileName,
    sizeBytes: d.sizeBytes,
    sha256: d.sha256,
    uploadedAt: d.uploadedAt,
    pdfUrl: `/api/legal/documents/pdf/${d.documentType.toLowerCase()}?v=${encodeURIComponent(d.version)}`,
  }));
}

export async function listLegalDocuments(type?: string) {
  const normalized = type ? normalizeLegalType(type) : null;
  return prisma.legalDocument.findMany({
    where: normalized ? { documentType: normalized } : {},
    include: { uploadedBy: { select: { email: true } } },
    orderBy: [{ documentType: 'asc' }, { uploadedAt: 'desc' }],
  });
}

export type LegalDocumentSearch = {
  documentType: string;
  version?: string;
};

export async function findLegalDocumentPdf({ documentType, version }: LegalDocumentSearch) {
  const type = normalizeLegalType(documentType);
  if (!type) return null;
  if (version) {
    return prisma.legalDocument.findUnique({
      where: { documentType_version: { documentType: type, version } },
    });
  }
  return prisma.legalDocument.findFirst({ where: { documentType: type, isActive: true } });
}

export interface ReplaceLegalDocumentInput {
  documentType: string;
  fileName?: string;
  contentType?: string;
  base64: string;
  uploadedByUserId: string;
  ipAddress?: string;
}

/**
 * Replaces the active version of a legal document. The new PDF is written to
 * disk with a freshly generated version, all older rows for the type are marked
 * inactive (kept as history for audit), and the previous physical file is
 * removed. Returns the newly-created active row.
 */
export async function replaceLegalDocument(
  input: ReplaceLegalDocumentInput
): Promise<Awaited<ReturnType<typeof prisma.legalDocument.create>>> {
  const type = normalizeLegalType(input.documentType);
  if (!type) {
    throw new Error(`documentType must be one of: ${LEGAL_DOCUMENT_TYPES.join(', ')}.`);
  }

  const buffer = Buffer.from(input.base64, 'base64');
  if (buffer.length === 0) {
    throw new Error('The uploaded file is empty.');
  }
  // Reject anything that isn't a PDF ("%PDF-" magic bytes) so a replacement
  // can never silently publish a corrupt/non-PDF file.
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('The uploaded file is not a valid PDF.');
  }
  if (buffer.length > MAX_LEGAL_DOCUMENT_BYTES) {
    throw new Error(
      `The uploaded PDF exceeds the ${Math.round(MAX_LEGAL_DOCUMENT_BYTES / 1024 / 1024)} MB limit.`
    );
  }

  await ensureLegalDir();
  const version = await generateDocumentVersion(type);
  const safeName = (input.fileName || `${type.toLowerCase()}-${version}.pdf`).replace(
    /[^\w. -]+/g,
    '_'
  );
  const fileName = safeName.toLowerCase().endsWith('.pdf') ? safeName : `${safeName}.pdf`;
  const filePath = path.join(LEGAL_DIR, `${type.toLowerCase()}-${version}.pdf`);

  await fs.writeFile(filePath, buffer);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  const previousActive = await prisma.legalDocument.findFirst({
    where: { documentType: type, isActive: true },
  });

  const document = await prisma.$transaction(async (tx) => {
    await tx.legalDocument.updateMany({
      where: { documentType: type, isActive: true },
      data: { isActive: false },
    });
    return tx.legalDocument.create({
      data: {
        documentType: type,
        version,
        fileName,
        filePath,
        contentType: input.contentType || 'application/pdf',
        sizeBytes: buffer.length,
        sha256,
        isActive: true,
        uploadedByUserId: input.uploadedByUserId,
      },
    });
  });

  // Prune the previous version's physical file (its DB history row is kept).
  if (previousActive && previousActive.filePath !== filePath) {
    fs.unlink(previousActive.filePath).catch(() => undefined);
  }

  await logActivity({
    userId: input.uploadedByUserId,
    action: 'LEGAL_DOCUMENT_UPDATED',
    details: { documentType: type, version, fileName, sha256 },
    ipAddress: input.ipAddress || 'admin-panel',
  }).catch(() => undefined);

  return document;
}