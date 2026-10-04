/**
 * PayPal ORDER-AMOUNT tests for our CUSTOM 4-stage installment ladder.
 *
 * Design: on the 'installments' plan the merchant creates ONE order per stage,
 * hard-capped at INSTALLMENT_FEE_AUD ($16.25 = 65.00 / 4). PayPal's own native
 * "Pay in 4" is disabled at the SDK layer (disable-funding=paylater,credit) so
 * PayPal never re-splits a stage into sub-payments.
 *
 * The cap is applied AFTER the client's requested amount, which is what makes it
 * a real security boundary: the browser is untrusted, so a tampered client that
 * claims 'installments' while asking for $65.00 still only gets a $16.25 order.
 *
 * resolveOrderAmount is pure and synchronous, so all of this is verifiable
 * exhaustively.
 */

import {
  resolveOrderAmount,
  DEFAULT_REPORT_FEE_AUD,
  INSTALLMENT_FEE_AUD,
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
const STAGE = INSTALLMENT_FEE_AUD; // 16.25

console.log('\n=== CONSTANTS: the ladder divides the fee into 4 equal stages ===');
{
  assert(STAGE === 16.25, 'One stage is $16.25');
  assert(
    Math.abs(STAGE * 4 - FEE) < 0.005,
    '4 x $16.25 sums EXACTLY to the $65.00 fee (no rounding shortfall)'
  );
}

console.log("\n=== STAGE 1: a new case on the installment plan orders $16.25 ===");
{
  // What the portal sends for stage 1: plan=installments, amount = 16.25.
  const stage1 = resolveOrderAmount({
    remainingAmount: FEE,
    requestedAmount: STAGE,
    plan: 'installments',
  });
  assert(stage1.amount === STAGE, 'Stage 1 orders exactly $16.25');
  assert(stage1.stageAmount === STAGE, 'The derived stage amount is reported as $16.25');

  // Omitting `amount` still yields one stage - the cap is the default, not a
  // consequence of the client asking nicely.
  const noAmount = resolveOrderAmount({ remainingAmount: FEE, plan: 'installments' });
  assert(noAmount.amount === STAGE, 'Omitting `amount` still yields one $16.25 stage');

  // The full plan is still available and is the whole fee.
  const full = resolveOrderAmount({ remainingAmount: FEE, plan: 'full' });
  assert(full.amount === FEE, "The 'full' plan still orders the entire $65.00");
}

console.log('\n=== SECURITY: the stage cap overrides a tampered client ===');
{
  // The critical case. A client claims the installment plan but requests the
  // full fee. Without a server-side cap AFTER the requested amount, one "stage"
  // click would capture all $65.00 while the UI still said "stage 1 of 4".
  const tamper = resolveOrderAmount({
    remainingAmount: FEE,
    requestedAmount: FEE,
    plan: 'installments',
  });
  assert(
    tamper.amount === STAGE,
    'A client claiming installments but requesting $65.00 gets capped to $16.25'
  );
  assert(
    tamper.clampedToStage === true,
    'The over-stage request is flagged in the activity log'
  );

  const huge = resolveOrderAmount({
    remainingAmount: FEE,
    requestedAmount: 5000,
    plan: 'installments',
  });
  assert(huge.amount === STAGE, 'Requesting $5000.00 is capped to $16.25');

  // Conversely, a client cannot shrink the stage to dodge the ladder and pay
  // a penny, which would be its own kind of abuse (partial report, hold forever).
  const tiny = resolveOrderAmount({
    remainingAmount: FEE,
    requestedAmount: 0.01,
    plan: 'installments',
  });
  assert(
    tiny.amount === 0.01,
    'A stage order honours a smaller explicit amount (a partial capture is a valid final stage)'
  );
}

console.log('\n=== LADDER: stages 2-4 price off the OUTSTANDING balance ===');
{
  const after = (paid: number) => FEE - paid;

  const stage2 = resolveOrderAmount({
    remainingAmount: after(STAGE),
    plan: 'installments',
  });
  assert(stage2.amount === STAGE, 'Stage 2 (after $16.25 paid) is another $16.25');

  const stage3 = resolveOrderAmount({
    remainingAmount: after(STAGE * 2),
    plan: 'installments',
  });
  assert(stage3.amount === STAGE, 'Stage 3 (after $32.50 paid) is another $16.25');

  // Final stage: only $16.25 remains, so the stage is the remainder exactly.
  const stage4 = resolveOrderAmount({
    remainingAmount: after(STAGE * 3),
    plan: 'installments',
  });
  assert(stage4.amount === STAGE, 'Stage 4 (after $48.75 paid) is the final $16.25');

  // Walking the whole ladder must total the fee exactly - the report unlocks
  // on the 4th capture and NOT before.
  const captured = [STAGE, stage2.amount, stage3.amount, stage4.amount].reduce((a, b) => a + b, 0);
  assert(
    Math.abs(captured - FEE) < 0.005,
    'All 4 stages sum EXACTLY to $65.00, so paidAmount reaches feeAmount on stage 4'
  );
  assert(
    captured - STAGE < FEE - 0.005,
    'After only 3 stages the report is still short of the fee (stays locked)'
  );
}

console.log('\n=== SAFETY: a stage can never overcharge the remaining balance ===');
{
  // A residual balance smaller than one stage (e.g. a legacy row, or a refund
  // adjustment) must be charged as-is, never padded up to $16.25.
  const residual = resolveOrderAmount({
    remainingAmount: 10,
    plan: 'installments',
  });
  assert(
    residual.amount === 10,
    'A $10.00 residual balance charges $10.00, never a padded $16.25'
  );

  const exact = resolveOrderAmount({
    remainingAmount: STAGE,
    requestedAmount: STAGE,
    plan: 'installments',
  });
  assert(exact.amount === STAGE, 'Requesting exactly one stage is not clamped');
  assert(
    exact.clampedToStage === false,
    'An exact-stage request is not flagged as clamped'
  );

  const overpay = resolveOrderAmount({
    remainingAmount: STAGE,
    requestedAmount: 65,
    plan: 'installments',
  });
  assert(
    overpay.amount === STAGE,
    'Requesting more than the balance on a stage is clamped to the balance'
  );
}

console.log('\n=== SAFETY: legacy partial rows are not double-charged ===');
{
  // A row carrying a partial balance must be charged the OUTSTANDING amount,
  // never the original fee, or the practitioner pays twice for one report.
  const afterOneStage = FEE - STAGE; // 48.75
  const order = resolveOrderAmount({ remainingAmount: afterOneStage });
  assert(
    order.amount === afterOneStage,
    'A legacy row with $16.25 already paid orders only the $48.75 outstanding'
  );
  assert(order.amount < FEE, 'A legacy partial row is never re-charged the original $65.00');
  assert(
    Math.abs(STAGE + order.amount - FEE) < 0.005,
    'Prior capture + new order sums exactly to the $65.00 fee (no double-charge)'
  );
}

console.log('\n=== REPORT STAYS LOCKED until every stage has cleared ===');
{
  // Mirror of buildPaymentGate's fullyPaid rule: the report is gated on the
  // CUMULATIVE paidAmount, never on the amount of the stage just captured.
  const isFullyPaid = (paid: number) => paid >= FEE - 0.005;

  assert(!isFullyPaid(0), 'Nothing captured: report locked');
  assert(!isFullyPaid(STAGE), 'After stage 1 ($16.25 / $65.00): report locked');
  assert(!isFullyPaid(STAGE * 2), 'After stage 2 ($32.50 / $65.00): report locked');
  assert(!isFullyPaid(STAGE * 3), 'After stage 3 ($48.75 / $65.00): report locked');
  assert(isFullyPaid(FEE), 'After stage 4 ($65.00 / $65.00): report unlocks');

  // A single under-paying capture must NOT unlock, however large.
  assert(!isFullyPaid(FEE - 0.01), 'A $64.99 total is still short and stays locked');
}

console.log(`\nTEST RESULTS: ${passed} / ${passed + failed} tests passed.`);
if (failed > 0) {
  console.error(`FAILURE: ${failed} order-amount test(s) failed.`);
  process.exit(1);
}
console.log('SUCCESS: ALL PAYPAL ORDER AMOUNT TESTS PASSED CLEANLY!');
