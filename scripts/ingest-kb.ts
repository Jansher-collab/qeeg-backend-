import 'dotenv/config';
import { ingestKnowledgeBase } from '../lib/services/knowledgeBaseService';

async function main() {
  const total = await ingestKnowledgeBase();
  console.log(`[KnowledgeBase] Ingest complete: ${total} chunks upserted.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[KnowledgeBase] Ingest failed:', err);
    process.exit(1);
  });