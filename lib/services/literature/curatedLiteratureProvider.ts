import { prisma } from '../../prisma';
import { LiteratureResult, LiteratureSource } from './literatureSource';

// Search support for the admin-curated Knowledge Base entries extracted from
// uploaded source PDFs. Registered first in the aggregation layer so curated
// references are matched alongside (and take precedence over) PubMed /
// Semantic Scholar results during report generation.
export class CuratedLiteratureProvider implements LiteratureSource {
  name = 'CURATED';

  async searchLiterature(query: string, limit = 5): Promise<LiteratureResult[]> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const entries = await prisma.literatureEntry.findMany({
      where: { sourcePdf: { status: 'INGESTED' } },
      select: {
        id: true,
        title: true,
        authors: true,
        journal: true,
        year: true,
        abstract: true,
        url: true,
        doi: true,
        keywords: true,
      },
    });

    return entries
      .map((e) => {
        const haystack = `${e.title} ${(e.keywords || []).join(' ')} ${e.abstract || ''}`;
        const score = scoreEntry(queryTokens, haystack, e.title);
        if (score <= 0) return null;
        return {
          id: e.id,
          title: e.title,
          authors: e.authors || [],
          journal: e.journal || undefined,
          year: e.year || undefined,
          abstract: e.abstract || undefined,
          url: e.url || (e.doi ? `https://doi.org/${e.doi}` : ''),
          source: this.name,
          doi: e.doi || undefined,
          relevanceScore: score,
        } as LiteratureResult;
      })
      .filter((r): r is LiteratureResult => r !== null)
      .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0))
      .slice(0, limit);
  }
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{3,}/g) || []).map((t) => t.trim());
}

function scoreEntry(queryTokens: string[], content: string, title: string): number {
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
    if (content.toLowerCase().includes(q)) score += 1;
  }
  const wordCount = content.toLowerCase().split(' ').length || 1;
  return score / Math.sqrt(wordCount);
}

export const curatedLiteratureProvider = new CuratedLiteratureProvider();