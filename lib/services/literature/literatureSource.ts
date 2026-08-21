export interface LiteratureResult {
  id: string;
  title: string;
  authors: string[];
  journal?: string;
  year?: number;
  abstract?: string;
  url: string;
  source: 'PubMed' | 'SemanticScholar';
  doi?: string;
  relevanceScore?: number;
}

export interface LiteratureSource {
  name: 'PubMed' | 'SemanticScholar';
  searchLiterature(query: string, limit?: number): Promise<LiteratureResult[]>;
}
