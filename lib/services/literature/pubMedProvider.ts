import { LiteratureResult, LiteratureSource } from './literatureSource';

export class PubMedProvider implements LiteratureSource {
  name: 'PubMed' = 'PubMed';
  private baseUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

  async searchLiterature(query: string, limit = 5): Promise<LiteratureResult[]> {
    try {
      // Step 1: E-search to get PubMed IDs
      const searchUrl = `${this.baseUrl}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(
        query
      )}&retmode=json&retmax=${limit}`;

      const searchRes = await fetch(searchUrl);
      if (!searchRes.ok) return [];

      const searchData: any = await searchRes.json();
      const idList: string[] = searchData.esearchresult?.idlist || [];

      if (idList.length === 0) return [];

      // Step 2: E-summary to get metadata for PubMed IDs
      const summaryUrl = `${this.baseUrl}/esummary.fcgi?db=pubmed&id=${idList.join(',')}&retmode=json`;
      const summaryRes = await fetch(summaryUrl);
      if (!summaryRes.ok) return [];

      const summaryData: any = await summaryRes.json();
      const resultObj = summaryData.result || {};

      const results: LiteratureResult[] = idList.map((id) => {
        const doc = resultObj[id] || {};
        const authors = (doc.authors || []).map((a: { name?: string }) => a.name || 'Unknown Author');
        const pubDate = doc.pubdate || '';
        const yearMatch = pubDate.match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? parseInt(yearMatch[0], 10) : undefined;

        return {
          id: `PMID-${id}`,
          title: doc.title || 'Untitled PubMed Article',
          authors: authors.slice(0, 5),
          journal: doc.source || doc.fulljournalname,
          year,
          abstract: doc.title ? `PubMed Article (PMID: ${id}) on ${doc.title}` : undefined,
          url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
          source: 'PubMed',
          doi: doc.articleids?.find((aid: { idtype: string }) => aid.idtype === 'doi')?.value,
        };
      });

      return results;
    } catch (error) {
      console.warn('PubMed API search warning:', error);
      return [];
    }
  }
}
