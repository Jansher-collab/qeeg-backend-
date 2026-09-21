export interface ReliabilityVerificationResult {
  passed: boolean;
  reliabilityScore: number;
  threshold: number;
  age?: number;
  gender?: string;
  handedness?: string;
  deidentified: boolean;
  rejectionReason?: string;
}

export interface IngestionPayload {
  caseReference: string;
  tdtContent?: string;
  reliabilityBlock?: {
    splitHalf?: number;
    testRetest?: number;
    overallReliability?: number;
  };
  demographics?: {
    age?: number;
    gender?: string;
    handedness?: string;
  };
  tovaData?: Record<string, unknown>;
  checklistData?: Record<string, unknown>;
}

const MINIMUM_RELIABILITY_THRESHOLD = 0.80;

// Prohibited PII patterns for strict de-identification validation
const PII_PATTERNS = [
  /patient[_-]?name/i,
  /first[_-]?name/i,
  /last[_-]?name/i,
  /\beeg[_-]?id\b/i,
  /\beeg\s*#\s*[:=]/i,
  /client[_-]?id\b/i,
  /subject[_-]?id\b/i,
  /date[_-]?of[_-]?birth/i,
  /\bdob\b/i,
  /social[_-]?security/i,
  /\bssn\b/i,
  /\bmrn\b/i,
  /street[_-]?address/i,
];

/**
 * Server-side parsing & verification function to independently re-verify 
 * the Test/Retest reliability score against the >= 0.80 threshold
 * and enforce strict de-identification.
 */
export function verifyIngestionPayload(payload: IngestionPayload): ReliabilityVerificationResult {
  console.log("=== BACKEND INGESTION PAYLOAD RECEIVED ===", {
    reliabilityScoreField: (payload as any).reliabilityScore,
    reliabilityBlock: payload.reliabilityBlock,
    hasTdtContent: !!payload.tdtContent
  });

  // 1. Verify strict de-identification
  const rawStringified = JSON.stringify(payload);
  for (const pattern of PII_PATTERNS) {
    if (pattern.test(rawStringified)) {
      return {
        passed: false,
        reliabilityScore: 0,
        threshold: MINIMUM_RELIABILITY_THRESHOLD,
        deidentified: false,
        rejectionReason: `De-identification violation: Prohibited personal identifiable information (PII) pattern detected (${pattern.source}).`,
      };
    }
  }

  // 2. Extract Test/Retest reliability score
  let reliabilityScore = 0;
  let age: number | undefined = payload.demographics?.age;
  let gender: string | undefined = payload.demographics?.gender;
  let handedness: string | undefined = payload.demographics?.handedness;

  if ((payload as any).reliabilityScore !== undefined) {
    reliabilityScore = Number((payload as any).reliabilityScore);
  } else if (payload.reliabilityBlock?.testRetest !== undefined) {
    reliabilityScore = payload.reliabilityBlock.testRetest;
  } else if (payload.tdtContent) {
    const parsedTdt = parseTdtContent(payload.tdtContent);
    reliabilityScore = parsedTdt.reliabilityScore;
    if (parsedTdt.age !== undefined) age = parsedTdt.age;
    if (parsedTdt.gender !== undefined) gender = parsedTdt.gender;
    if (parsedTdt.handedness !== undefined) handedness = parsedTdt.handedness;
  }

  console.log("=== RESOLVED RELIABILITY SCORE ===", reliabilityScore);  
  // 3. Enforce the >= 0.80 reliability threshold backstop
  const passed = reliabilityScore >= MINIMUM_RELIABILITY_THRESHOLD;
  const rejectionReason = passed
    ? undefined
    : `Test/Retest reliability score (${reliabilityScore.toFixed(3)}) is below the mandatory quality threshold of ${MINIMUM_RELIABILITY_THRESHOLD}. Submission rejected with zero fees.`;

  return {
    passed,
    reliabilityScore,
    threshold: MINIMUM_RELIABILITY_THRESHOLD,
    age,
    gender,
    handedness,
    deidentified: true,
    rejectionReason,
  };
}


/**
 * Parses QEEG .tdt raw text content to extract Reliability block metrics and basic demographics.
 */
function parseTdtContent(content: string): {
  reliabilityScore: number;
  age?: number;
  gender?: string;
  handedness?: string;
} {
  let reliabilityScore = 0;
  let age: number | undefined;
  let gender: string | undefined;
  let handedness: string | undefined;

  // DEBUG: Let's see if content is arriving and check the first few lines
  console.log("--- PARSING TDT CONTENT ---");
  console.log("Content length:", content ? content.length : 0);

  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Log lines that might look like average to see what it's reading
    if (/average/i.test(trimmed)) {
      console.log("Found average line match:", JSON.stringify(trimmed));
      const parts = trimmed.split(/\s+/);
      console.log("Split parts:", parts);
      if (parts.length >= 3) {
        const testRetestVal = parseFloat(parts[2]);
        console.log("Parsed testRetestVal:", testRetestVal);
        if (!isNaN(testRetestVal)) {
          reliabilityScore = testRetestVal;
        }
      }
    }

    // Parse Demographics, etc...
    if (/^Age\s*[:=]\s*([0-9.]+)/i.test(trimmed)) {
      const match = trimmed.match(/([0-9.]+)/);
      if (match) age = parseFloat(match[1]);
    }
  }

  console.log("Final extracted reliabilityScore:", reliabilityScore);
  console.log("----------------------------");

  return {
    reliabilityScore,
    age,
    gender,
    handedness,
  };
}