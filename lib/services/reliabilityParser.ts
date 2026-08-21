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

  // 2. Extract Test/Retest reliability score from TDT header or reliability block
  let reliabilityScore = 0;
  let age: number | undefined = payload.demographics?.age;
  let gender: string | undefined = payload.demographics?.gender;
  let handedness: string | undefined = payload.demographics?.handedness;

  if (payload.tdtContent) {
    const parsedTdt = parseTdtContent(payload.tdtContent);
    reliabilityScore = parsedTdt.reliabilityScore;
    if (parsedTdt.age !== undefined) age = parsedTdt.age;
    if (parsedTdt.gender !== undefined) gender = parsedTdt.gender;
    if (parsedTdt.handedness !== undefined) handedness = parsedTdt.handedness;
  } else if (payload.reliabilityBlock) {
    reliabilityScore =
      payload.reliabilityBlock.testRetest ??
      payload.reliabilityBlock.overallReliability ??
      payload.reliabilityBlock.splitHalf ??
      0;
  }

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

  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    // Parse Test-Retest or Reliability metrics
    if (/^(?:Test-Retest|TestRetest|Reliability|Split-Half)\s*[:=]\s*([0-9.]+)/i.test(trimmed)) {
      const match = trimmed.match(/([0-9.]+)/);
      if (match) {
        reliabilityScore = parseFloat(match[1]);
      }
    }

    // Parse Demographics
    if (/^Age\s*[:=]\s*([0-9.]+)/i.test(trimmed)) {
      const match = trimmed.match(/([0-9.]+)/);
      if (match) age = parseFloat(match[1]);
    }
    if (/^Gender\s*[:=]\s*([A-Za-z]+)/i.test(trimmed)) {
      const match = trimmed.match(/([A-Za-z]+)/);
      if (match) gender = match[1];
    }
    if (/^Handedness\s*[:=]\s*([A-Za-z]+)/i.test(trimmed)) {
      const match = trimmed.match(/([A-Za-z]+)/);
      if (match) handedness = match[1];
    }
  }

  return {
    reliabilityScore,
    age,
    gender,
    handedness,
  };
}
