import fs from 'fs';
import path from 'path';
import { prisma } from '../prisma';
import { fetchWithTimeout } from './timeout';

const KB_DIR = path.join(process.cwd(), 'knowledge-base');
const TOP_K = 6;
const MAX_CHUNK_LENGTH = 2400;

let ingestedFlag = false;

/** Splits raw text into overlapping chunks by paragraph for reliable retrieval. */
function chunkText(raw: string, maxLen = MAX_CHUNK_LENGTH): string[] {
  const normalized = raw.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buffer = '';

  const flushBuffer = () => {
    if (buffer.trim().length > 40) chunks.push(buffer.trim());
    buffer = '';
  };

  for (const para of paragraphs) {
    if (buffer && buffer.length + para.length + 1 <= maxLen) {
      buffer = `${buffer}\n\n${para}`;
      continue;
    }
    flushBuffer();
    if (para.length <= maxLen) {
      buffer = para;
      continue;
    }
    // Single over-long paragraph: hard-split on sentence boundaries.
    let remaining = para;
    while (remaining.length > maxLen) {
      let cut = remaining.lastIndexOf('. ', maxLen);
      if (cut < maxLen / 2) cut = maxLen;
      const piece = remaining.slice(0, cut + 1).trim();
      if (piece.length > 40) chunks.push(piece);
      remaining = remaining.slice(cut + 1).trim();
    }
    if (remaining.length > 40) chunks.push(remaining);
  }

  flushBuffer();
  return chunks;
}

/**
 * Ingests every .md/.txt/.mdx file under knowledge-base/ into the
 * KnowledgeChunk table (idempotent). Chunks that no longer exist on disk are
 * removed. Returns the number of chunks upserted.
 */
export async function ingestKnowledgeBase(): Promise<number> {
  if (!fs.existsSync(KB_DIR)) {
    fs.mkdirSync(KB_DIR, { recursive: true });
  }

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(md|txt|mdx)$/i.test(entry.name)) files.push(full);
    }
  };
  walk(KB_DIR);

  let total = 0;
  const seen = new Set<string>();

  for (const file of files) {
    const rel = path.relative(KB_DIR, file).replace(/\\/g, '/');
    const raw = fs.readFileSync(file, 'utf-8');
    const title = path.basename(file);

    // Use the first markdown heading (# / ##) as the entry title when present.
    const headingMatch = raw.match(/^#{1,2}\s+(.+)$/m);
    const entryTitle = (headingMatch && headingMatch[1]?.trim()) || title;

    const chunks = chunkText(raw);
    for (let i = 0; i < chunks.length; i++) {
      seen.add(`${rel}|${i}`);
      await prisma.knowledgeChunk.upsert({
        where: { sourceFile_chunkIndex: { sourceFile: rel, chunkIndex: i } },
        update: { title: entryTitle, content: chunks[i], updatedAt: new Date() },
        create: { sourceFile: rel, title: entryTitle, content: chunks[i], chunkIndex: i },
      });
      total++;
    }
  }

  // Garbage-collect chunks for files/chunks that no longer exist.
  if (seen.size > 0) {
    const keep = Array.from(seen).map((key) => {
      const [sourceFile, chunkIndex] = key.split('|');
      return { sourceFile, chunkIndex: Number(chunkIndex) };
    });
    await prisma.knowledgeChunk.deleteMany({ where: { NOT: { OR: keep } } });
  }

  return total;
}

async function ensureIngested(): Promise<void> {
  if (ingestedFlag) return;
  const count = await prisma.knowledgeChunk.count();
  if (count === 0) {
    const total = await ingestKnowledgeBase();
    console.log(`[KnowledgeBase] Ingested ${total} chunks.`);
  }
  ingestedFlag = true;
}

/** Tokenizes a query into lower-case word tokens for scoring. */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{3,}/g) || []).map((t) => t.trim());
}

/** TF-style lexical relevance score between a query and a chunk. */
function scoreChunk(queryTokens: string[], content: string, title: string): number {
  const bodyTokens = tokenize(content);
  if (bodyTokens.length === 0) return 0;
  const titleTokens = new Set(tokenize(title));
  let score = 0;
  for (const q of queryTokens) {
    for (const b of bodyTokens) {
      if (b === q) score += 2;
      else if (b.startsWith(q) || q.startsWith(b)) score += 1;
    }
    if (titleTokens.has(q)) score += 3;
    // Bonus for multi-word phrases found verbatim.
    if (content.toLowerCase().includes(q)) score += 1;
  }
  const bigramCount = content.toLowerCase().split(' ').length;
  return score / Math.sqrt(bigramCount || 1);
}

export interface KnowledgeBaseAnswer {
  answer: string;
  grounded: boolean;
  sourceChunks: { sourceFile: string; title: string; excerpt: string }[];
}

export function getAnthropicConfigured(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== '');
}

function requireAnthropicModel(): string {
  if (!process.env.ANTHROPIC_MODEL) {
    throw new Error(
      '[KnowledgeBase] ANTHROPIC_MODEL is not configured — refusing to silently downgrade the model.'
    );
  }
  return process.env.ANTHROPIC_MODEL;
}

/**
 * Retrieval-augmented knowledge-base query.
 *
 * 1. Lexically ranks KnowledgeChunk rows against the question.
 * 2. If ANTHROPIC_API_KEY is configured, asks Claude to synthesise a grounded
 *    answer using ONLY the retrieved excerpts (with citations).
 * 3. Otherwise returns the top excerpts as a self-contained `answer`.
 */
export async function queryKnowledgeBase(question: string): Promise<KnowledgeBaseAnswer> {
  await ensureIngested();

  const queryTokens = tokenize(question);
  if (queryTokens.length === 0) {
    return { answer: 'Please provide a longer question.', grounded: false, sourceChunks: [] };
  }

  const chunks = await prisma.knowledgeChunk.findMany();
  const ranked = chunks
    .map((c) => ({
      chunk: c,
      score: scoreChunk(queryTokens, c.content, c.title),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  const sourceChunks = ranked.map(({ chunk }) => ({
    sourceFile: chunk.sourceFile,
    title: chunk.title,
    excerpt: chunk.content.slice(0, 500),
  }));

  if (ranked.length === 0) {
    return {
      answer: 'The knowledge base does not yet contain information matching this question.',
      grounded: false,
      sourceChunks: [],
    };
  }

  // Optional Anthropic-grounded synthesis (Section 6.1a).
  if (getAnthropicConfigured()) {
    try {
      const retrieverContext = ranked
        .map(({ chunk }, i) => `[Source ${i + 1}] (${chunk.sourceFile})\n${chunk.content}`)
        .join('\n\n');

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
            max_tokens: 1024,
            system:
              'You are a clinical-support assistant for QEEG.com.au. Answer using ONLY the provided knowledge-base excerpts. If the excerpts do not contain the answer, say so explicitly. Cite excerpts as [Source N]. Never invent facts, never provide medical advice, and never mention that you are an AI model.',
            messages: [{ role: 'user', content: `Question: ${question}\n\nKnowledge base excerpts:\n\n${retrieverContext}` }],
          }),
        },
        30_000
      );

      if (res.ok) {
        const data: any = await res.json();
        const answer = (data.content || [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n')
          .trim();
        if (answer) return { answer, grounded: true, sourceChunks };
      }
      console.warn('[KnowledgeBase] Anthropic call failed, falling back to excerpts.', res.status);
    } catch (e) {
      console.warn('[KnowledgeBase] Anthropic call error, falling back to excerpts.', e);
    }
  }

  const excerptAnswer = sourceChunks
    .map((s, i) => `[Source ${i + 1}] ${s.title} (${s.sourceFile})\n${s.excerpt}`)
    .join('\n\n');
  return {
    answer: excerptAnswer,
    grounded: true,
    sourceChunks,
  };
}