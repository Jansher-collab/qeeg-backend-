"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.POST = POST;
const server_1 = require("next/server");
const prisma_1 = require("@/lib/backend/prisma");
const authService_1 = require("@/lib/backend/services/authService");
const activityLogger_1 = require("@/lib/backend/services/activityLogger");
const client_1 = require("@/generated/prisma/client");
async function POST(req, context) {
    try {
        const user = await (0, authService_1.getAuthenticatedUser)(req);
        if (!user || (user.role !== 'NEUROSCIENTIST' && user.role !== 'ADMIN')) {
            return server_1.NextResponse.json({ error: 'Forbidden. Access restricted to Clinical Neuroscientists.' }, { status: 403 });
        }
        const { id } = await context.params;
        const body = (await req.json());
        const { action, reviewerNotes, editedSummary, findings } = body;
        const report = await prisma_1.prisma.qeeqReport.findUnique({
            where: { id },
        });
        if (!report) {
            return server_1.NextResponse.json({ error: 'Report not found.' }, { status: 404 });
        }
        const newStatus = action === 'APPROVE' ? client_1.ReportStatus.COMPLETED : client_1.ReportStatus.RELIABILITY_REJECTED;
        const updatedReport = await prisma_1.prisma.qeeqReport.update({
            where: { id },
            data: {
                status: newStatus,
                reviewerNotes: reviewerNotes || null,
                reportSummary: editedSummary || report.reportSummary,
                findings: findings || report.findings,
                reviewedBy: user.email,
                reviewedAt: new Date(),
            },
        });
        // Log Activity
        const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
        await (0, activityLogger_1.logActivity)({
            reportId: report.id,
            caseReference: report.caseReference,
            userId: user.id,
            action: action === 'APPROVE' ? 'REPORT_REVIEW_APPROVED' : 'REPORT_REVIEW_REJECTED',
            details: {
                reviewer: user.email,
                notes: reviewerNotes,
            },
            ipAddress: ip,
        });
        return server_1.NextResponse.json({
            message: `Report ${action === 'APPROVE' ? 'approved' : 'rejected'} successfully.`,
            report: updatedReport,
        });
    }
    catch (error) {
        console.error('Error reviewing report:', error);
        return server_1.NextResponse.json({ error: error.message }, { status: 500 });
    }
}
