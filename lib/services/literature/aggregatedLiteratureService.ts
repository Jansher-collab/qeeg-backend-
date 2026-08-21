import { LiteratureResult, LiteratureSource } from './literatureSource';
import { PubMedProvider } from './pubMedProvider';
import { SemanticScholarProvider } from './semanticScholarProvider';

export class AggregatedLiteratureService {
  private sources: LiteratureSource[];

  constructor() {
    this.sources = [new PubMedProvider(), new SemanticScholarProvider()];
  }

  async searchLiterature(query: string, limitPerSource = 5): Promise<LiteratureResult[]> {
    const resultsPromises = this.sources.map((source) =>
      source.searchLiterature(query, limitPerSource).catch((err) => {
        console.warn(`Source ${source.name} failed:`, err);
        return [] as LiteratureResult[];
      })
    );

    const allResultsArrays = await Promise.all(resultsPromises);
    const combinedResults = allResultsArrays.flat();

    // Deduplicate based on title similarity or DOI
    const seenTitles = new Set<string>();
    const deduplicated: LiteratureResult[] = [];

    for (const paper of combinedResults) {
      const normalizedTitle = paper.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!seenTitles.has(normalizedTitle)) {
        seenTitles.add(normalizedTitle);
        deduplicated.push(paper);
      }
    }

    return deduplicated;
  }
}

export const aggregatedLiteratureService = new AggregatedLiteratureService();
