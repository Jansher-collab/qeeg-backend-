import { prisma } from '../prisma';
import { refundCapture, voidPayment } from './paypalService';
import { logActivity } from './activityLogger';
import type { PaymentCaptureEntry } from './installmentPayment';

export interface RefundReportResult {
  refundedAmount: number;
  refundIds: string[];
  failures: { captureId?: string; error: string }[];
  alreadyVoid: boolean;
}

/**
 * Refunds ALL captured payment installments on a report and returns it to the
 * terminal VOIDED + RELIABILITY_REJECTED state. Called when report generation
 * terminally fails (the worker exhausted its attempts), so a practitioner is
 * never charged for a report that will never be produced. Legacy single-capture
 * rows (paymentsJson null) are refunded from paypalCaptureId; rows that never
 * captured anything have their pending authorization voided instead.
 *
 * Money-optional at the PayPal boundary (refund failures are collected, not
 * thrown) so downstream code always persists the terminal state; a refund
 * failure is surfaced loudly for manual reconciliation.
 */
export async function refundReportPayments(
  reportId: string,
  context: { userId?: string; ipAddress?: string; reason?: string } = {}
): Promise<RefundReportResult> {
  const result: RefundReportResult = { refundedAmount: 0, refundIds: [], failures: [], alreadyVoid: false };
  const report = await prisma.qeeqReport.findUnique({ where: { id: reportId } });
  if (!report) return result;

  if (report.paymentStatus === 'VOIDED') {
    result.alreadyVoid = true;
    return result;
  }

  const entries: PaymentCaptureEntry[] = Array.isArray(report.paymentsJson)
    ? (report.paymentsJson as unknown as PaymentCaptureEntry[])
    : report.paidAmount > 0 && report.paypalCaptureId
      ? [
          {
            captureId: report.paypalCaptureId,
            authorizationId: report.paypalAuthorizationId ?? '',
            amount: report.paidAmount,
            capturedAt: report.updatedAt.toISOString(),
          },
        ]
      : [];
  const refundable = entries.filter((e) => e.captureId);

  for (const entry of refundable) {
    const refund = await refundCapture(entry.captureId, entry.amount);
    if (refund.success) {
      if (refund.refundId) result.refundIds.push(refund.refundId);
      result.refundedAmount += entry.amount;
    } else {
      result.failures.push({ captureId: entry.captureId, error: refund.error ?? 'Refund failed' });
    }
  }

  if (refundable.length === 0 && report.paypalAuthorizationId) {
    const ok = await voidPayment(report.paypalAuthorizationId);
    if (!ok) {
      result.failures.push({ error: `PayPal void of authorization ${report.paypalAuthorizationId} failed` });
    }
  }

  await prisma.qeeqReport.update({
    where: { id: reportId },
    data: {
      paidAmount: 0,
      paymentStatus: 'VOIDED',
      paymentsJson: [],
      status: 'RELIABILITY_REJECTED',
      updatedAt: new Date(),
    },
  });

  await logActivity({
    reportId,
    caseReference: report.caseReference,
    userId: context.userId,
    action: 'PAYMENT_VOIDED',
    details: {
      refundedAmount: result.refundedAmount,
      refundIds: result.refundIds,
      failures: result.failures,
      reason: context.reason ?? 'terminal generation failure',
    },
    ipAddress: context.ipAddress,
  });

  return result;
}