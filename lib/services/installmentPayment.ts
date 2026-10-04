import { prisma } from '../prisma';
import { capturePayment, classifyPaymentError, refundCapture } from './paypalService';
import { logActivity } from './activityLogger';

export interface PaymentCaptureEntry {
  authorizationId: string;
  captureId: string;
  amount: number;
  capturedAt: string;
}

export interface PaymentProgressInfo {
  paidAmount: number;
  feeAmount: number;
  remainingAmount: number;
  fullyPaid: boolean;
}

export interface PaymentInstallmentProgress extends PaymentProgressInfo {
  reportId: string;
  caseReference: string;
  authorizationId: string;
  captureId?: string;
  amount: number;
}

/**
 * Derived (never persisted) payment state for a report row.
 *
 * This exists so the payment gate has ONE definition shared by the API and the
 * generation pipeline. Previously each consumer re-derived "is this paid?"
 * independently, which let the practitioner table render a "Ready" badge from
 * `status === 'COMPLETED'` alone and unlock the download button for a case that
 * had only paid its first $16.25 installment.
 *
 * It is derived rather than a new PaymentStatus enum member on purpose: the
 * stored enum (NOT_STARTED | AUTHORISED | CAPTURED | VOIDED | FAILED) is
 * PayPal's authorisation lifecycle, not the instalment ladder, and cannot
 * express "3 of 4 stages paid". Deriving it needs no schema migration.
 */
export type DerivedPaymentState = 'NOT_STARTED' | 'PARTIAL' | 'PAID';

export interface PaymentGate {
  paidAmount: number;
  feeAmount: number;
  remainingAmount: number;
  fullyPaid: boolean;
  /** PARTIAL for any case that is mid-ladder (e.g. 3 of 4 stages). */
  paymentState: DerivedPaymentState;
  /** Analysis/artifact finished, i.e. status reached COMPLETED. */
  analysisComplete: boolean;
  /**
   * The single authority for "may this practitioner download & purge?".
   * Requires BOTH a finished analysis and the full fee - never status alone.
   */
  downloadEligible: boolean;
}

/** Thrown by capturePaymentInstallment; carries a machine-readable code. */
export class InstallmentPaymentError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'InstallmentPaymentError';
    this.code = code;
  }
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Default fee when a report predates the feeAmount column default. */
export const DEFAULT_REPORT_FEE_AUD = 65.0;
/** One stage of our 4-stage ladder: 65.00 / 4 = 16.25 AUD. */
export const INSTALLMENT_FEE_AUD = 16.25;
/**
 * Half-cent tolerance. Summed cent-accurate stages must equal the fee exactly,
 * but float addition can drift by a hair, and a false "not paid" would
 * permanently lock a report the customer fully paid for.
 */
export const PAYMENT_EPSILON = 0.005;

export function isFullyPaidAmounts(
  feeAmount: number | null | undefined,
  paidAmount: number | null | undefined,
): boolean {
  return round2(feeAmount ?? DEFAULT_REPORT_FEE_AUD) - round2(paidAmount ?? 0.0) <= PAYMENT_EPSILON;
}

/**
 * Builds the authoritative payment gate for a report row. Synchronous and
 * allocation-free so listing endpoints can map it over a whole page of rows.
 */
export function buildPaymentGate(report: {
  status?: string | null;
  feeAmount?: number | null;
  paidAmount?: number | null;
  paymentStatus?: string | null;
}): PaymentGate {
  const feeAmount = round2(report.feeAmount ?? DEFAULT_REPORT_FEE_AUD);
  const paidAmount = round2(report.paidAmount ?? 0.0);
  const remainingAmount = Math.max(0, round2(feeAmount - paidAmount));
  const fullyPaid = remainingAmount <= PAYMENT_EPSILON;

  // A voided/failed authorisation owns the state, not the running total.
  const paymentVoided =
    report.paymentStatus === 'VOIDED' || report.paymentStatus === 'FAILED';
  const analysisComplete = report.status === 'COMPLETED';

  const paymentState: DerivedPaymentState = paymentVoided
    ? 'NOT_STARTED'
    : paidAmount <= 0
      ? 'NOT_STARTED'
      : fullyPaid
        ? 'PAID'
        : 'PARTIAL';

  return {
    paidAmount,
    feeAmount,
    remainingAmount,
    fullyPaid,
    paymentState,
    analysisComplete,
    // Both conditions, always. Analysis completion alone must never unlock a
    // download, and neither must payment alone (the artifact may not exist).
    downloadEligible: analysisComplete && fullyPaid && !paymentVoided,
  };
}

/**
 * Resolves the amount a PayPal order may be created for.
 *
 * Our 4-stage ladder is managed HERE, server-side: on the 'installments' plan
 * the order is hard-capped at ONE stage ($16.25) no matter what the client
 * asks for. The browser is untrusted, so a client that requests 65.00 while
 * claiming the installment plan still gets a 16.25 order - otherwise one
 * "stage" click would silently capture the whole fee.
 *
 * PayPal's native Pay Later is separately disabled at the SDK layer
 * (disable-funding=paylater,credit), so a $16.25 stage is never re-split into
 * sub-payments on PayPal's side.
 *
 * Only the explicit 'full' plan can charge the whole outstanding balance, and
 * no plan can ever exceed what is actually owed.
 */
export function resolveOrderAmount(args: {
  remainingAmount: number;
  requestedAmount?: number;
  plan?: 'full' | 'installments';
}): { amount: number; stageAmount: number; clampedToStage: boolean } {
  const remaining = round2(Math.max(0, args.remainingAmount));
  const requested =
    args.requestedAmount !== undefined && args.requestedAmount > 0
      ? round2(args.requestedAmount)
      : undefined;
  const stageAmount = round2(Math.min(INSTALLMENT_FEE_AUD, remaining));

  if (args.plan === 'installments') {
    const amount = round2(Math.min(stageAmount, requested ?? stageAmount));
    return {
      amount,
      stageAmount,
      clampedToStage: requested !== undefined && requested > stageAmount + PAYMENT_EPSILON,
    };
  }

  return {
    amount: round2(Math.min(requested ?? remaining, remaining)),
    stageAmount,
    clampedToStage: false,
  };
}

export async function getPaymentProgress(report: {  feeAmount: number | null;
  paidAmount: number | null;
}): Promise<PaymentProgressInfo> {
  const feeAmount = round2(report.feeAmount ?? DEFAULT_REPORT_FEE_AUD);
  const paidAmount = round2(report.paidAmount ?? 0.0);
  const remainingAmount = Math.max(0, round2(feeAmount - paidAmount));
  return { paidAmount, feeAmount, remainingAmount, fullyPaid: remainingAmount <= PAYMENT_EPSILON };
}

/**
 * Captures ONE installment payment against a report and records it cumulatively
 * on the report row (paidAmount + paymentsJson). While paidAmount < feeAmount
 * the report stays on HOLD (status PAYMENT_AUTHORISED); generation only starts
 * once the cumulative total reaches the fee. Payments that would overshoot the
 * remaining balance are clamped/rejected, and a concurrent double-apply is
 * detected via a paidAmount-gated update (the extra capture is refunded).
 */
export async function capturePaymentInstallment(args: {
  reportId: string;
  authorizationId: string;
  amount: number;
  ipAddress?: string;
  userId?: string;
}): Promise<PaymentInstallmentProgress> {
  const { reportId, authorizationId, amount } = args;
  const amountAUD = round2(amount);

  const report = await prisma.qeeqReport.findUnique({ where: { id: reportId } });
  if (!report) throw new InstallmentPaymentError('Report not found.', 'REPORT_NOT_FOUND');
  if (report.status !== 'PAYMENT_AUTHORISED') {
    throw new InstallmentPaymentError(
      `This report is not open for further payments (status: ${report.status}).`,
      'REPORT_NOT_OPEN_FOR_PAYMENT'
    );
  }

  const progressCheck = await getPaymentProgress(report);
  if (progressCheck.fullyPaid) {
    throw new InstallmentPaymentError('This report is already fully paid.', 'REPORT_ALREADY_PAID');
  }
  if (amountAUD <= 0) {
    throw new InstallmentPaymentError('Payment amount must be greater than zero.', 'INVALID_AMOUNT');
  }
  if (amountAUD > progressCheck.remainingAmount + 0.005) {
    throw new InstallmentPaymentError(
      `Payment amount exceeds the outstanding balance of ${progressCheck.remainingAmount.toFixed(2)} AUD.`,
      'AMOUNT_EXCEEDS_REMAINING'
    );
  }

  const cap = await capturePayment(authorizationId, amountAUD);
  if (!cap.success || !cap.captureId) {
    // Reuse the fine-grained classifier so the frontend shows the same friendly
    // reason it sees for authorize failures (declined card, PUI_TXN_AMOUNT,
    // insufficient funds, ...).
    const classified = classifyPaymentError(cap.error, amountAUD);
    throw new InstallmentPaymentError(classified.message, classified.code);
  }

  // Apply cumulatively with a paidAmount compare-and-set so two concurrent
  // installments cannot double-apply the same balance. On a lost race the
  // freshly captured amount is refunded rather than silently dropped.
  let committed = false;
  for (let attempt = 0; attempt < 3 && !committed; attempt += 1) {
    // paidAmount AND paymentsJson must come from the SAME read that the
    // compare-and-set below is gated on. Rebuilding the ledger from the
    // pre-loop snapshot would silently drop an entry committed by a
    // concurrent installment that we lost the first race against, leaving the
    // cumulative total and the transaction history permanently out of sync.
    const fresh = await prisma.qeeqReport.findUnique({
      where: { id: reportId },
      select: { paidAmount: true, feeAmount: true, paymentsJson: true },
    });
    const currentPaid = round2(fresh?.paidAmount ?? 0.0);
    const newPaid = round2(currentPaid + amountAUD);
    const freshProgress = await getPaymentProgress({
      feeAmount: fresh?.feeAmount ?? report.feeAmount,
      paidAmount: currentPaid,
    });
    if (newPaid > freshProgress.feeAmount + 0.005) {
      const refund = await refundCapture(cap.captureId, amountAUD);
      throw new InstallmentPaymentError(
        `Payment of ${amountAUD.toFixed(2)} AUD could not be applied` +
          (refund.success
            ? ' (concurrent payment detected; your payment was refunded).'
            : ` and the automatic refund FAILED: ${refund.error ?? 'unknown error'}. MANUAL ACTION REQUIRED.`),
        'CONCURRENT_PAYMENT_OVERFLOW'
      );
    }
    const existing: PaymentCaptureEntry[] = Array.isArray(fresh?.paymentsJson)
      ? (fresh.paymentsJson as unknown as PaymentCaptureEntry[])
      : [];
    const entry: PaymentCaptureEntry = {
      authorizationId,
      captureId: cap.captureId,
      amount: amountAUD,
      capturedAt: new Date().toISOString(),
    };
    const update = await prisma.qeeqReport.updateMany({
      where: { id: reportId, paidAmount: currentPaid },
      data: {
        paidAmount: newPaid,
        paymentsJson: JSON.parse(JSON.stringify([...existing, entry])),
        paypalCaptureId: cap.captureId,
        paypalAuthorizationId: authorizationId,
        // A partially paid report must NOT read as settled: it stays
        // AUTHORISED (funds still outstanding) until the cumulative total
        // reaches the fee, and only then flips to CAPTURED.
        paymentStatus: newPaid >= freshProgress.feeAmount - 0.005 ? 'CAPTURED' : 'AUTHORISED',
        updatedAt: new Date(),
      },
    });
    if (update.count === 1) committed = true;
  }
  if (!committed) {
    const refund = await refundCapture(cap.captureId, amountAUD);
    throw new InstallmentPaymentError(
      `Payment of ${amountAUD.toFixed(2)} AUD could not be recorded on the report` +
        (refund.success
          ? '; your payment was refunded.'
          : ` and the automatic refund FAILED: ${refund.error ?? 'unknown error'}. MANUAL ACTION REQUIRED.`),
      'PAYMENT_RECORD_FAILED'
    );
  }

  const finalReport = await prisma.qeeqReport.findUnique({ where: { id: reportId } });
  const finalProgress = await getPaymentProgress(finalReport ?? report);

  await logActivity({
    reportId,
    caseReference: report.caseReference,
    userId: args.userId,
    action: 'PAYMENT_CAPTURED',
    details: {
      amount: amountAUD,
      captureId: cap.captureId,
      authorizationId,
      paidAmount: finalProgress.paidAmount,
      feeAmount: finalProgress.feeAmount,
      remainingAmount: finalProgress.remainingAmount,
      fullyPaid: finalProgress.fullyPaid,
    },
    ipAddress: args.ipAddress,
  });

  return {
    reportId,
    caseReference: report.caseReference,
    authorizationId,
    captureId: cap.captureId,
    amount: amountAUD,
    paidAmount: finalProgress.paidAmount,
    feeAmount: finalProgress.feeAmount,
    remainingAmount: finalProgress.remainingAmount,
    fullyPaid: finalProgress.fullyPaid,
  };
}