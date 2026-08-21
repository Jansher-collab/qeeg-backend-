import { verifyIngestionPayload } from '../services/reliabilityParser';
import { authorisePayment, capturePayment, getReportFeeAUD } from '../services/paypalService';
import { compileCorrelationReport, MANDATORY_NEUROFEEDBACK_COI_DISCLOSURE, MANDATORY_AI_GENERATION_DISCLAIMER } from '../services/correlationEngine';
import { executePurgeOnDownload } from '../services/purgeService';
import { logActivity, getActivityLogs } from '../services/activityLogger';

async function runBackendPipelineTestSuite() {
  console.log('--- STARTING BACKEND PIPELINE TEST SUITE ---');
  let testsPassed = 0;
  let testsTotal = 0;

  function assert(condition: boolean, testName: string) {
    testsTotal++;
    if (condition) {
      console.log(`✓ [PASS] ${testName}`);
      testsPassed++;
    } else {
      console.error(`✗ [FAIL] ${testName}`);
    }
  }

  // ----------------------------------------------------
  // TEST 1: Reliability Backstop (Pass case >= 0.80)
  // ----------------------------------------------------
  const validPayload = {
    caseReference: 'CASE-TEST-001',
    reliabilityBlock: { testRetest: 0.89 },
    demographics: { age: 34, gender: 'Male', handedness: 'Right' },
    tovaData: { adhdScore: -2.4 },
    checklistData: { anxiety: true },
  };

  const validVerification = verifyIngestionPayload(validPayload);
  assert(validVerification.passed === true, 'Reliability verification passes when Test/Retest >= 0.80');
  assert(validVerification.reliabilityScore === 0.89, 'Extracts correct Test/Retest score (0.89)');

  // ----------------------------------------------------
  // TEST 2: Reliability Backstop (Reject case < 0.80)
  // ----------------------------------------------------
  const lowReliabilityPayload = {
    caseReference: 'CASE-TEST-LOW',
    reliabilityBlock: { testRetest: 0.62 },
    demographics: { age: 29 },
  };

  const lowVerification = verifyIngestionPayload(lowReliabilityPayload);
  assert(lowVerification.passed === false, 'Reliability verification fails when Test/Retest < 0.80');
  assert(
    lowVerification.rejectionReason?.includes('below the mandatory quality threshold of 0.8') ?? false,
    'Returns clear rejection reason for low reliability'
  );

  // ----------------------------------------------------
  // TEST 3: De-identification PII Backstop
  // ----------------------------------------------------
  const piiPayload = {
    caseReference: 'CASE-TEST-PII',
    patientName: 'John Smith',
    reliabilityBlock: { testRetest: 0.92 },
  };

  const piiVerification = verifyIngestionPayload(piiPayload as any);
  assert(piiVerification.passed === false, 'Rejects payload containing patient PII (patientName)');
  assert(piiVerification.deidentified === false, 'Marks payload as non-deidentified on PII detection');

  // ----------------------------------------------------
  // TEST 4: PayPal Authorisation & Fee Configuration
  // ----------------------------------------------------
  const currentFee = await getReportFeeAUD();
  assert(currentFee === 65.0, 'Default report fee is set to AU$65.00');

  const authResult = await authorisePayment(validPayload.caseReference, currentFee);
  assert(authResult.success === true, 'Payment authorisation succeeds');
  assert(authResult.amount === 65.0, 'Authorised amount matches configured fee ($65 AUD)');
  assert(!!authResult.authorizationId, 'Returns valid PayPal authorisation ID');

  // ----------------------------------------------------
  // TEST 5: Correlation Engine & 5 Domains Compilation
  // ----------------------------------------------------
  const reportFindings = await compileCorrelationReport(
    validPayload.caseReference,
    validPayload.demographics.age,
    validPayload.demographics.gender,
    validPayload.demographics.handedness,
    validPayload.tovaData,
    validPayload.checklistData,
    validVerification.reliabilityScore
  );

  assert(reportFindings.domains.length === 5, 'Correlation engine produces findings across all 5 domains');
  assert(reportFindings.confidenceScore >= 0.75, 'Computes overall report confidence score (>= 0.75)');

  // Check mandatory neurofeedback COI disclosure
  const nfbDomain = reportFindings.domains.find((d) => d.domain === 'Neurofeedback Treatment-Response');
  assert(
    nfbDomain?.conflictOfInterestDisclosure === MANDATORY_NEUROFEEDBACK_COI_DISCLOSURE,
    'Includes mandatory Neurofeedback Conflict of Interest disclosure'
  );

  // Check mandatory AI-generation disclaimer
  assert(
    reportFindings.aiDisclaimer === MANDATORY_AI_GENERATION_DISCLAIMER,
    'Appends mandatory AI-generation disclaimer to final report'
  );

  // ----------------------------------------------------
  // TEST 6: PayPal Payment Capture (Post Report Generation)
  // ----------------------------------------------------
  const captureResult = await capturePayment(authResult.authorizationId!, currentFee);
  assert(captureResult.success === true, 'Payment capture succeeds after report compilation');
  assert(!!captureResult.captureId, 'Returns valid PayPal capture ID');

  // ----------------------------------------------------
  // TEST 7: Activity Logging Audit Trail
  // ----------------------------------------------------
  await logActivity({
    caseReference: validPayload.caseReference,
    action: 'SUBMISSION',
    details: { testRun: true },
  });

  const logs = await getActivityLogs({ caseReference: validPayload.caseReference });
  assert(Array.isArray(logs), 'Activity logger returns logs array for case reference');

  // ----------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------
  console.log(`\nTEST RESULTS: ${testsPassed} / ${testsTotal} tests passed.`);
  if (testsPassed === testsTotal) {
    console.log('SUCCESS: ALL BACKEND PIPELINE COMPONENT TESTS PASSED CLEANLY!');
  } else {
    console.error('FAILURE: SOME TESTS DID NOT PASS.');
  }
}

// Execute test suite if run directly
runBackendPipelineTestSuite().catch(console.error);
