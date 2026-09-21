export interface LiteratureResult {
  id: string;
  title: string;
  authors: string[];
  journal?: string;
  year?: number;
  abstract?: string;
  url: string;
  source: string;
  doi?: string;
  relevanceScore?: number;
}

export interface LiteratureSource {
  name: string;
  searchLiterature(query: string, limit?: number): Promise<LiteratureResult[]>;
}
