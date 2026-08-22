import { LiteratureResult, LiteratureSource } from './literatureSource';

export class SemanticScholarProvider implements LiteratureSource {
  name: 'SemanticScholar' = 'SemanticScholar';
  private baseUrl = 'https://api.semanticscholar.org/graph/v1/paper/search';

  async searchLiterature(query: string, limit = 5): Promise<LiteratureResult[]> {
    try {
      const url = `${this.baseUrl}?query=${encodeURIComponent(
        query
      )}&limit=${limit}&fields=paperId,title,authors,venue,year,abstract,url,externalIds`;

      const response = await fetch(url);
      if (!response.ok) return [];

      const data: any = await response.json();
      const papers = data.data || [];

      return papers.map(
        (paper: {
          paperId: string;
          title: string;
          authors?: Array<{ name: string }>;
          venue?: string;
          year?: number;
          abstract?: string;
          url?: string;
          externalIds?: { DOI?: string };
        }) => ({
          id: `S2-${paper.paperId}`,
          title: paper.title || 'Untitled Semantic Scholar Paper',
          authors: (paper.authors || []).map((a) => a.name).slice(0, 5),
          journal: paper.venue || 'Academic Journal',
          year: paper.year,
          abstract: paper.abstract || undefined,
          url: paper.url || `https://www.semanticscholar.org/paper/${paper.paperId}`,
          source: 'SemanticScholar',
          doi: paper.externalIds?.DOI,
        })
      );
    } catch (error) {
      console.warn('Semantic Scholar API search warning:', error);
      return [];
    }
  }
}
