import { prisma } from '../prisma';

export interface ActivityLogInput {
  reportId?: string;
  caseReference?: string;
  userId?: string;
  action:
    | 'SUBMISSION'
    | 'RELIABILITY_VERIFICATION'
    | 'RELIABILITY_FAIL'
    | 'PAYMENT_AUTHORISED'
    | 'PAYMENT_CAPTURED'
    | 'PAYMENT_VOIDED'
    | 'REPORT_GENERATING'
    | 'REPORT_GENERATED'
    | 'DOWNLOAD_INITIATED'
    | 'DOWNLOAD_COMPLETED'
    | 'FILES_AND_RECORD_PURGED'
    | 'PRACTITIONER_REGISTERED'
    | 'USER_LOGIN'
    | 'USER_LOGOUT'
    | 'REPORT_REVIEW_APPROVED'
    | 'REPORT_REVIEW_REJECTED'
    | string;
  details?: Record<string, unknown>;
  ipAddress?: string;
}

/**
 * Centralized Activity Logger service for full lifecycle auditability.
 */
export async function logActivity(input: ActivityLogInput): Promise<void> {
  try {
    await prisma.activityLog.create({
      data: {
        reportId: input.reportId,
        caseReference: input.caseReference,
        userId: input.userId,
        action: input.action,
        details: input.details ? JSON.parse(JSON.stringify(input.details)) : undefined,
        ipAddress: input.ipAddress,
        timestamp: new Date(),
      },
    });
  } catch (error) {
    console.warn(`[ActivityLog Warning] Failed to persist log entry for action ${input.action}:`, error);
  }
}

/**
 * Retrieves activity logs by case reference or report ID.
 */
export async function getActivityLogs(params: {
  reportId?: string;
  caseReference?: string;
  userId?: string;
  limit?: number;
}) {
  return prisma.activityLog.findMany({
    where: {
      ...(params.reportId && { reportId: params.reportId }),
      ...(params.caseReference && { caseReference: params.caseReference }),
      ...(params.userId && { userId: params.userId }),
    },
    orderBy: { timestamp: 'desc' },
    take: params.limit || 50,
  });
}
