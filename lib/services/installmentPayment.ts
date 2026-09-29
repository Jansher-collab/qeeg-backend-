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

export async function getPaymentProgress(report: {
  feeAmount: number | null;
  paidAmount: number | null;
}): Promise<PaymentProgressInfo> {
  const feeAmount = round2(report.feeAmount ?? 65.0);
  const paidAmount = round2(report.paidAmount ?? 0.0);
  const remainingAmount = Math.max(0, round2(feeAmount - paidAmount));
  return { paidAmount, feeAmount, remainingAmount, fullyPaid: remainingAmount <= 0.005 };
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
    const fresh = await prisma.qeeqReport.findUnique({
      where: { id: reportId },
      select: { paidAmount: true },
    });
    const currentPaid = round2(fresh?.paidAmount ?? 0.0);
    const newPaid = round2(currentPaid + amountAUD);
    const freshProgress = await getPaymentProgress({ feeAmount: report.feeAmount, paidAmount: currentPaid });
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
    const existing: PaymentCaptureEntry[] = Array.isArray(report.paymentsJson)
      ? (report.paymentsJson as unknown as PaymentCaptureEntry[])
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
        paymentStatus: 'CAPTURED',
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