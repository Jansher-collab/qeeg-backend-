import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import pdfParse from 'pdf-parse';
import { prisma } from '../prisma';
import { logActivity } from './activityLogger';
import { fetchWithTimeout } from './timeout';

export const MAX_KNOWLEDGE_PDF_BYTES = 25 * 1024 * 1024; // 25 MB
export const MAX_KNOWLEDGE_PDF_BATCH = 10; // max PDFs per multi-upload request

// Admin-uploaded research PDFs are persistent platform assets (not clinical
// data) and live in their own scratch-adjacent directory.
const KB_PDF_DIR = path.join(process.cwd(), 'uploads', 'knowledge-pdfs');

export const KNOWLEDGE_SOURCE_STATUS = {
  PENDING_INGESTION: 'PENDING_INGESTION',
  INGESTING: 'INGESTING',
  INGESTED: 'INGESTED',
  FAILED: 'FAILED',
  RETRACTED: 'RETRACTED',
} as const;

export type KnowledgeSourceStatus = (typeof KNOWLEDGE_SOURCE_STATUS)[keyof typeof KNOWLEDGE_SOURCE_STATUS];

const STOPWORDS = new Set(
  ('the a an of and or for with on in to from by at this as are was were is be been being have has had ' +
   'that which who whom whose what how when where why it its their there here they them their our your ' +
   'not no but if then than so such both each few more most other some between during before after above ' +
   'study studies research results result data analysis clinical effect effects group groups patient patients ' +
   'participants methods method objective objectives conclusion conclusions findings objective analysis ' +
   'over under again further once also often always never sometimes doi pmid et al').split(' ')
);

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function safeStoredName(original: string, index: number): string {
  const ext = original.toLowerCase().endsWith('.pdf') ? '' : '.pdf';
  const safeBase = original.replace(/\.[A-Za-z0-9]+$/, '').replace(/[^\w. -]+/g, '_').trim().replace(/\s+/g, '_');
  const base = (safeBase || 'knowledge-source').slice(0, 80);
  return `${Date.now()}-${index}-${base}${ext}.pdf`;
}

/**
 * Decodes base64 into a PDF buffer and rejects anything that is not a PDF
 * (checked via the "%PDF-" magic bytes) or exceeds the size limit.
 */
export async function createSourcePdfFromUpload(input: {
  fileName?: string;
  contentType?: string;
  base64: string;
  uploadedByUserId: string;
  ipAddress?: string;
}) {
  const buffer = Buffer.from(input.base64, 'base64');
  if (buffer.length === 0) throw new Error('The uploaded file is empty.');
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('The uploaded file is not a valid PDF.');
  }
  if (buffer.length > MAX_KNOWLEDGE_PDF_BYTES) {
    throw new Error(
      `The uploaded PDF exceeds the ${Math.round(MAX_KNOWLEDGE_PDF_BYTES / 1024 / 1024)} MB limit.`
    );
  }

  await ensureDir(KB_PDF_DIR);
  const originalFileName = input.fileName || `knowledge-source-${Date.now()}.pdf`;
  const fileName = safeStoredName(originalFileName, 0);
  const filePath = path.join(KB_PDF_DIR, fileName);

  await fs.writeFile(filePath, buffer);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  let sourcePdf;
  try {
    sourcePdf = await prisma.knowledgeSourcePdf.create({
      data: {
        originalFileName,
        fileName,
        filePath,
        contentType: input.contentType || 'application/pdf',
        sizeBytes: buffer.length,
        sha256,
        status: KNOWLEDGE_SOURCE_STATUS.PENDING_INGESTION,
        uploadedByUserId: input.uploadedByUserId,
      },
    });
  } catch (error: any) {
    await fs.unlink(filePath).catch(() => undefined);
    throw error;
  }

  await logActivity({
    userId: input.uploadedByUserId,
    action: 'KNOWLEDGE_SOURCE_PDF_UPLOADED',
    details: { sourcePdfId: sourcePdf.id, fileName: originalFileName, sha256 },
    ipAddress: input.ipAddress || 'admin-panel',
  }).catch(() => undefined);

  return sourcePdf;
}

/**
 * Main ingestion pipeline: extract the raw text from the PDF, run the
 * AI-structure pass (Anthropic when configured) or a deterministic heuristic
 * fallback, persist the extracted LiteratureEntry rows, and flip the source
 * PDF status to INGESTED (or FAILED recorded on the row). Never throws — the
 * failure is captured on the source PDF so the admin can retry from the panel.
 */
export async function ingestSourcePdf(sourcePdfId: string): Promise<{ count: number; sourcePdfId: string }> {
  const sourcePdf = await prisma.knowledgeSourcePdf.findUnique({ where: { id: sourcePdfId } });
  if (!sourcePdf) throw new Error('Source PDF not found.');

  await prisma.knowledgeSourcePdf.update({
    where: { id: sourcePdfId },
    data: { status: KNOWLEDGE_SOURCE_STATUS.INGESTING, error: null },
  });

  try {
    const rawText = await extractPdfText(sourcePdf.filePath);

    const aiEntries = await extractEntriesWithAnthropic(rawText).catch((e: any) => {
      console.warn('[KnowledgeIngestion] Anthropic extraction failed, falling back to heuristics.', e);
      return null;
    });
    const fallbackEntries = aiEntries && aiEntries.length > 0
      ? aiEntries
      : extractEntriesHeuristic(rawText);

    const entries = await prisma.$transaction(async (tx) => {
      await tx.literatureEntry.deleteMany({ where: { sourcePdfId } });
      const created: { id: string }[] = [];
      for (const entry of fallbackEntries) {
        const row = await tx.literatureEntry.create({
          data: {
            sourcePdfId,
            title: entry.title || 'Untitled research entry',
            authors: entry.authors || [],
            journal: entry.journal ?? null,
            year: entry.year ?? null,
            abstract: entry.abstract ?? null,
            url: entry.doi
              ? `https://doi.org/${entry.doi}`
              : `/api/admin/knowledge/source-pdfs/${sourcePdfId}/pdf`,
            source: 'CURATED',
            doi: entry.doi ?? null,
            keywords: entry.keywords || [],
          },
          select: { id: true },
        });
        created.push(row);
      }
      return created;
    });

    await prisma.knowledgeSourcePdf.update({
      where: { id: sourcePdfId },
      data: {
        status: KNOWLEDGE_SOURCE_STATUS.INGESTED,
        entryCount: entries.length,
        error: null,
        title: fallbackEntries[0]?.title || sourcePdf.originalFileName,
      },
    });

    await logActivity({
      userId: sourcePdf.uploadedByUserId || 'system',
      action: 'KNOWLEDGE_SOURCE_INGESTED',
      details: { sourcePdfId, entryCount: entries.length, title: fallbackEntries[0]?.title },
      ipAddress: 'knowledge-ingestion',
    }).catch(() => undefined);

    return { count: entries.length, sourcePdfId };
  } catch (error: any) {
    await prisma.knowledgeSourcePdf.update({
      where: { id: sourcePdfId },
      data: {
        status: KNOWLEDGE_SOURCE_STATUS.FAILED,
        error: error?.message || 'Ingestion failed.',
      },
    });
    await logActivity({
      userId: sourcePdf.uploadedByUserId || 'system',
      action: 'KNOWLEDGE_SOURCE_INGESTION_FAILED',
      details: { sourcePdfId, error: error?.message || 'Ingestion failed.' },
      ipAddress: 'knowledge-ingestion',
    }).catch(() => undefined);
    return { count: 0, sourcePdfId };
  }
}

async function extractPdfText(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const data = await pdfParse(buffer);
  const text = (data.text || '').replace(/\r\n/g, '\n');
  if (text.trim().length < 40) {
    throw new Error('The PDF has no extractable text (scanned/empty document).');
  }
  return text;
}

interface ExtractedEntry {
  title: string;
  authors: string[];
  journal?: string;
  year?: number;
  abstract?: string;
  doi?: string;
  keywords: string[];
}

function getAnthropicConfigured(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== '');
}

function requireAnthropicModel(): string {
  if (!process.env.ANTHROPIC_MODEL) {
    throw new Error(
      '[KnowledgeIngestion] ANTHROPIC_MODEL is not configured — refusing to silently downgrade the model.'
    );
  }
  return process.env.ANTHROPIC_MODEL;
}

/**
 * AI pass: asks Claude to read the PDF text and emit structured literature
 * entries as strict JSON. Returns null whenever the call fails so the caller
 * can fall back to the deterministic heuristic extraction.
 */
async function extractEntriesWithAnthropic(rawText: string): Promise<ExtractedEntry[] | null> {
  if (!getAnthropicConfigured()) return null;

  const prompt = `You are a research-information extraction service. From the research document text below, extract the structured metadata of each distinct research study/paper it describes.

For a typical single-paper PDF return exactly one entry. If the document clearly contains multiple studies (e.g. a symposium digest), return one entry per study.

Return ONLY valid JSON with this exact shape (no markdown fences, no commentary):
{"entries":[{"title":"string","authors":["string"],"journal":"string or null","year":int or null,"abstract":"string (up to ~500 words, verbatim from the text when possible)","doi":"string or null","keywords":["string"]}]}

Rules:
- Do not invent titles, authors, venues, years, DOI, or findings. If a field is absent from the text, use null (or an empty array for lists).
- The abstract must come from the text itself; if none is present, summarise the stated aims/findings in your own words grounded strictly in the text.
- keywords: 3-8 concise domain terms (e.g. "QEEG", "ADHD", "neurofeedback", "theta-beta").`;

  const res = await fetchWithTimeout(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: requireAnthropicModel(),
        max_tokens: 4096,
        system:
          'You extract research-paper metadata into strict JSON. You never invent information and always return the JSON shape requested by the user prompt.',
        messages: [{ role: 'user', content: `Research document text:\n\n${rawText.slice(0, 60000)}\n\n${prompt}` }],
      }),
    },
    60_000
  );

  if (!res.ok) {
    throw new Error(`Anthropic extraction failed with status ${res.status}.`);
  }

  const data: any = await res.json();
  const content = (data.content || [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n')
    .trim();

  const jsonStart = content.indexOf('{');
  const jsonEnd = content.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) throw new Error('Anthropic did not return JSON.');
  const parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1));

  const rawEntries: any[] = Array.isArray(parsed?.entries) ? parsed.entries : [];
  return rawEntries.map(sanitizeEntry).filter((e) => !!(e.title && e.title.trim()));
}

function sanitizeEntry(raw: any): ExtractedEntry {
  return {
    title: String(raw?.title || '').trim().slice(0, 500),
    authors: Array.isArray(raw?.authors)
      ? raw.authors.map((a: any) => String(a).trim()).filter(Boolean).slice(0, 12)
      : [],
    journal: raw?.journal ? String(raw.journal).trim().slice(0, 300) : undefined,
    year: raw?.year && Number.isInteger(raw.year) && raw.year > 1900 && raw.year < 2200 ? raw.year : undefined,
    abstract: raw?.abstract ? String(raw.abstract).trim().slice(0, 5000) : undefined,
    doi: raw?.doi ? String(raw.doi).match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/i)?.[0] : undefined,
    keywords: Array.isArray(raw?.keywords)
      ? raw.keywords.map((k: any) => String(k).trim()).filter(Boolean).slice(0, 10)
      : [],
  };
}

/**
 * Deterministic fallback extraction used when no AI key is configured or the AI
 * call fails. Produces a single, best-effort structured entry per PDF.
 */
function extractEntriesHeuristic(rawText: string): ExtractedEntry[] {
  const text = rawText.trim();

  const doi =
    text.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/i)?.[0] || undefined;
  const year = extractYear(text);
  const title = extractTitle(text);
  const authors = extractAuthors(text);
  const abstract = extractAbstract(text);
  const keywords = extractKeywords(`${title} ${abstract} ${text.slice(0, 4000)}`);

  return [
    {
      title,
      authors,
      year,
      abstract,
      doi,
      keywords,
    },
  ];
}

function extractYear(text: string): number | undefined {
  const match = text.slice(0, 6000).match(/\b(?:19|20)\d{2}\b/);
  if (!match) return undefined;
  const year = Number(match[0]);
  return year > 1900 && year < 2200 ? year : undefined;
}

function extractTitle(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return 'Untitled research document';
  if (text.length < 160) return lines[0].slice(0, 200);
  // Academic PDFs start with a title line, then author affiliation lines, then
  // the abstract. The title is usually the first line that looks like a heading.
  for (const line of lines.slice(0, 8)) {
    if (/^(abstract|introduction|background)\b/i.test(line)) break;
    const words = line.split(/\s+/);
    if (line.length >= 12 && line.length <= 160 && words.length <= 18 && !/^[\d\s\W]+$/.test(line)) {
      return line.slice(0, 300);
    }
  }
  return lines[0].slice(0, 300);
}

function extractAuthors(text: string): string[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const authors: string[] = [];
  for (const line of lines.slice(1, 12)) {
    if (authors.length >= 6) break;
    // Author lines: a handful of capitalized name tokens, optionally "and",
    // commas, superscript numbers/asterisks for affiliations.
    if (!/^[A-Z]/.test(line)) continue;
    if (/\b(abstract|introduction|background|corresponding|department|university|institute|school)\b/i.test(line)) break;
    const tokens = line.split(/,\s*|\band\b|[*\d]+/).map((t) => t.trim()).filter(Boolean);
    const candidate = tokens
      .filter((t) => /^[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*)*$/.test(t) && t.split(/\s+/).length <= 4)
      .map((t) => t.replace(/\s+/g, ' ').trim());
    if (candidate.length > 0 && candidate.join(' ').length > 4 && candidate.join(' ').length < 90) {
      authors.push(...candidate.flatMap((c) => c.split(/\s*;\s*/)));
    }
  }
  // Deduplicate preserving order.
  const seen = new Set<string>();
  return authors.filter((a) => (seen.has(a) ? false : (seen.add(a), true))).slice(0, 6);
}

function extractAbstract(text: string): string | undefined {
  const abstractMatch = text.match(/(?:^|\n)\s*abstract\b[\s:]*\n?([\s\S]*?)(?:\n\s*(?:introduction|background|1\.\s|keywords?|key words)\b)/i);
  if (abstractMatch && abstractMatch[1]) {
    const candidate = abstractMatch[1].trim();
    if (candidate.length > 40) return candidate.slice(0, 5000);
  }
  // Fall back to the first substantial paragraph after the author block.
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 40 && p.length < 3000);
  return paragraphs[0]?.slice(0, 5000);
}

function extractKeywords(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
  const counts = new Map<string, number>();
  for (const t of tokens) {
    if (STOPWORDS.has(t) || t.length < 4) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([t]) => t);
}

export async function listKnowledgeSourcePdfs() {
  return prisma.knowledgeSourcePdf.findMany({
    include: { uploadedBy: { select: { email: true } } },
    orderBy: { uploadedAt: 'desc' },
  });
}

export async function findKnowledgeSourcePdfPdf(sourcePdfId: string) {
  const sourcePdf = await prisma.knowledgeSourcePdf.findUnique({ where: { id: sourcePdfId } });
  if (!sourcePdf) return null;
  const buffer = await fs.readFile(sourcePdf.filePath).catch(() => null);
  if (!buffer) return null;
  return { sourcePdf, buffer };
}

export async function listLiteratureEntries(filter?: { sourcePdfId?: string }) {
  return prisma.literatureEntry.findMany({
    where: filter?.sourcePdfId ? { sourcePdfId: filter.sourcePdfId } : undefined,
    include: {
      sourcePdf: { select: { id: true, originalFileName: true, status: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Removes a source PDF and everything derived from it: its extracted entries
 * (cascade) and the physical file. Logged as a retraction for audit.
 */
export async function retractKnowledgeSourcePdf(sourcePdfId: string, actor?: { id: string; email: string }): Promise<void> {
  const sourcePdf = await prisma.knowledgeSourcePdf.findUnique({ where: { id: sourcePdfId } });
  if (!sourcePdf) throw new Error('Source PDF not found.');

  const entryCount = await prisma.literatureEntry.count({ where: { sourcePdfId } });
  await prisma.$transaction([
    prisma.literatureEntry.deleteMany({ where: { sourcePdfId } }),
    prisma.knowledgeSourcePdf.delete({ where: { id: sourcePdfId } }),
  ]);
  await fs.unlink(sourcePdf.filePath).catch(() => undefined);

  await logActivity({
    userId: actor?.id || sourcePdf.uploadedByUserId || 'system',
    action: 'KNOWLEDGE_SOURCE_RETRACTED',
    details: {
      sourcePdfId,
      fileName: sourcePdf.originalFileName,
      downloadedEntryCount: entryCount,
    },
    ipAddress: 'admin-panel',
  }).catch(() => undefined);
}