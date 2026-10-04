/**
 * Payment-gate regression tests.
 *
 * These lock in the rule that caused the reported bug: "analysis finished"
 * and "fee fully paid" are INDEPENDENT facts, and a download is unlocked only
 * when BOTH hold. A report that has completed correlation while still owing
 * money on an installment schedule must never be downloadable.
 *
 * Pure and dependency-free (buildPaymentGate is a synchronous pure function),
 * so this runs without a database.
 */

import {
  buildPaymentGate,
  isFullyPaidAmounts,
  DEFAULT_REPORT_FEE_AUD,
  type DerivedPaymentState,
} from '../services/installmentPayment';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
  if (condition) {
    console.log(`  [PASS] ${name}`);
    passed += 1;
  } else {
    console.error(`  [FAIL] ${name}`);
    failed += 1;
  }
}

const FEE = DEFAULT_REPORT_FEE_AUD; // 65.00

function gate(p: {
  fee?: number;
  paid?: number;
  status?: string;
  paymentStatus?: string;
}) {
  return buildPaymentGate({
    status: p.status ?? 'COMPLETED',
    feeAmount: p.fee ?? FEE,
    paidAmount: p.paid ?? 0,
    paymentStatus: p.paymentStatus ?? 'AUTHORISED',
  });
}

console.log('\n=== PAYMENT GATE: one-time full payment ($65 upfront) ===');
{
  const g = gate({ paid: FEE, paymentStatus: 'CAPTURED' });
  assert(g.fullyPaid === true, 'One-time $65 upfront is fullyPaid');
  assert(g.paymentState === 'PAID', 'One-time $65 upfront reports paymentState PAID');
  assert(g.remainingAmount === 0, 'One-time $65 upfront leaves nothing outstanding');
  assert(g.downloadEligible === true, 'One-time $65 upfront unlocks download immediately');
  assert(g.analysisComplete === true, 'Analysis complete flag is true for COMPLETED');
}

console.log('\n=== PAYMENT GATE: an underpaid report NEVER unlocks, whatever the cause ===');
{
  // The payment model is now a single full-amount order (PayPal's native Pay in
  // 4 handles the buyer's schedule), so an underpaid row should not normally
  // exist. The gate must still hold for ANY shortfall, because it is the only
  // thing standing between an unfinished analysis and an irreversible purge -
  // and legacy rows may still carry a partial balance from before the switch.
  const underpaid: Array<{ paid: number; note: string }> = [
    { paid: 0, note: 'nothing paid' },
    { paid: 16.25, note: 'one legacy 16.25 stage' },
    { paid: 32.5, note: 'two legacy stages' },
    { paid: 48.75, note: 'three legacy stages' },
    { paid: 64.99, note: 'one cent short' },
  ];

  for (const u of underpaid) {
    const g = gate({ paid: u.paid });
    assert(
      g.paymentState === ('PARTIAL' as DerivedPaymentState) || u.paid === 0,
      `$${u.paid.toFixed(2)} paid (${u.note}) is not treated as settled`
    );
    assert(
      g.downloadEligible === false,
      `REGRESSION: $${u.paid.toFixed(2)} paid (${u.note}) stays download-LOCKED even though analysis is COMPLETED`
    );
    assert(
      g.analysisComplete === true,
      `$${u.paid.toFixed(2)} paid still reports analysisComplete === true (the two are independent)`
    );
    assert(
      Math.abs(g.remainingAmount - (FEE - u.paid)) < 0.005,
      `$${u.paid.toFixed(2)} paid reports the correct outstanding balance`
    );
  }

  const full = gate({ paid: FEE });
  assert(full.paymentState === 'PAID', 'A single full $65.00 capture reports PAID');
  assert(full.remainingAmount === 0, 'A full capture leaves nothing outstanding');
  assert(full.downloadEligible === true, 'A full $65.00 capture unlocks the download');
}

console.log('\n=== PAYMENT GATE: payment alone must not unlock a download ===');
{
  // Fully paid but the artifact has not been generated yet.
  const g = gate({ paid: FEE, status: 'PAYMENT_AUTHORISED', paymentStatus: 'CAPTURED' });
  assert(g.fullyPaid === true, 'Fully paid while still generating');
  assert(g.analysisComplete === false, 'analysisComplete is false before generation');
  assert(
    g.downloadEligible === false,
    'Fully paid but NOT generated must stay locked (no artifact to download)'
  );
}

console.log('\n=== PAYMENT GATE: unpaid / voided / edge cases ===');
{
  const unpaid = gate({ paid: 0, status: 'PAYMENT_AUTHORISED' });
  assert(unpaid.paymentState === 'NOT_STARTED', 'Zero paid reports NOT_STARTED');
  assert(unpaid.downloadEligible === false, 'Zero paid is not downloadable');

  const voided = gate({ paid: 16.25, paymentStatus: 'VOIDED' });
  assert(
    voided.paymentState === 'NOT_STARTED',
    'A VOIDED authorisation reports NOT_STARTED even with a partial total'
  );
  assert(voided.downloadEligible === false, 'A VOIDED authorisation is never downloadable');

  // Sub-cent float drift must not permanently lock a genuinely paid report.
  assert(
    isFullyPaidAmounts(FEE, 64.9999999) === true,
    'Float drift just under the fee is still treated as paid'
  );
  assert(
    isFullyPaidAmounts(FEE, 48.74) === false,
    'A cent short is correctly treated as unpaid'
  );
  assert(
    isFullyPaidAmounts(null, 0) === false,
    'Null feeAmount falls back to the $65 default and is not paid at $0'
  );
}

console.log(
  `\nTEST RESULTS: ${passed} / ${passed + failed} tests passed.`
);
if (failed > 0) {
  console.error(`FAILURE: ${failed} payment-gate test(s) failed.`);
  process.exit(1);
}
console.log('SUCCESS: ALL PAYMENT GATE TESTS PASSED CLEANLY!');
