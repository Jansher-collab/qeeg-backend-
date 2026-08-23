"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aggregatedLiteratureService = exports.AggregatedLiteratureService = void 0;
const pubMedProvider_1 = require("./pubMedProvider");
const semanticScholarProvider_1 = require("./semanticScholarProvider");
class AggregatedLiteratureService {
    sources;
    constructor() {
        this.sources = [new pubMedProvider_1.PubMedProvider(), new semanticScholarProvider_1.SemanticScholarProvider()];
    }
    async searchLiterature(query, limitPerSource = 5) {
        const resultsPromises = this.sources.map((source) => source.searchLiterature(query, limitPerSource).catch((err) => {
            console.warn(`Source ${source.name} failed:`, err);
            return [];
        }));
        const allResultsArrays = await Promise.all(resultsPromises);
        const combinedResults = allResultsArrays.flat();
        // Deduplicate based on title similarity or DOI
        const seenTitles = new Set();
        const deduplicated = [];
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
exports.AggregatedLiteratureService = AggregatedLiteratureService;
exports.aggregatedLiteratureService = new AggregatedLiteratureService();
