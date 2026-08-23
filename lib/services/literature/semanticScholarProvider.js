"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SemanticScholarProvider = void 0;
class SemanticScholarProvider {
    name = 'SemanticScholar';
    baseUrl = 'https://api.semanticscholar.org/graph/v1/paper/search';
    async searchLiterature(query, limit = 5) {
        try {
            const url = `${this.baseUrl}?query=${encodeURIComponent(query)}&limit=${limit}&fields=paperId,title,authors,venue,year,abstract,url,externalIds`;
            const response = await fetch(url);
            if (!response.ok)
                return [];
            const data = await response.json();
            const papers = data.data || [];
            return papers.map((paper) => ({
                id: `S2-${paper.paperId}`,
                title: paper.title || 'Untitled Semantic Scholar Paper',
                authors: (paper.authors || []).map((a) => a.name).slice(0, 5),
                journal: paper.venue || 'Academic Journal',
                year: paper.year,
                abstract: paper.abstract || undefined,
                url: paper.url || `https://www.semanticscholar.org/paper/${paper.paperId}`,
                source: 'SemanticScholar',
                doi: paper.externalIds?.DOI,
            }));
        }
        catch (error) {
            console.warn('Semantic Scholar API search warning:', error);
            return [];
        }
    }
}
exports.SemanticScholarProvider = SemanticScholarProvider;
