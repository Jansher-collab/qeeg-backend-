"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logActivity = logActivity;
exports.getActivityLogs = getActivityLogs;
const prisma_1 = require("../prisma");
/**
 * Centralized Activity Logger service for full lifecycle auditability.
 */
async function logActivity(input) {
    try {
        await prisma_1.prisma.activityLog.create({
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
    }
    catch (error) {
        console.warn(`[ActivityLog Warning] Failed to persist log entry for action ${input.action}:`, error);
    }
}
/**
 * Retrieves activity logs by case reference or report ID.
 */
async function getActivityLogs(params) {
    return prisma_1.prisma.activityLog.findMany({
        where: {
            ...(params.reportId && { reportId: params.reportId }),
            ...(params.caseReference && { caseReference: params.caseReference }),
            ...(params.userId && { userId: params.userId }),
        },
        orderBy: { timestamp: 'desc' },
        take: params.limit || 50,
    });
}
