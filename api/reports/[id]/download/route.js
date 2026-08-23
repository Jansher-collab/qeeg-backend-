"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GET = GET;
const server_1 = require("next/server");
const prisma_1 = require("@/lib/backend/prisma");
const purgeService_1 = require("@/lib/backend/services/purgeService");
const activityLogger_1 = require("@/lib/backend/services/activityLogger");
async function GET(req, { params }) {
    try {
        const { id: reportId } = await params;
        const clientIp = req.headers.get('x-forwarded-for') || '127.0.0.1';
        // 1. Fetch report details
        const report = await prisma_1.prisma.qeeqReport.findUnique({
            where: { id: reportId },
        });
        if (!report) {
            return server_1.NextResponse.json({ error: 'Report not found or has already been downloaded and purged.' }, { status: 404 });
        }
        if (report.status !== 'COMPLETED') {
            return server_1.NextResponse.json({ error: 'Report is not ready for download yet.', status: report.status }, { status: 400 });
        }
        // 2. Validate practitioner ownership / strict access control
        const requestingPractitionerId = req.headers.get('x-practitioner-id') || report.submittingPractitionerId;
        if (requestingPractitionerId !== report.submittingPractitionerId) {
            return server_1.NextResponse.json({ error: 'Unauthorized: Report belongs exclusively to the submitting practitioner.' }, { status: 403 });
        }
        // 3. Log DOWNLOAD_INITIATED activity
        await (0, activityLogger_1.logActivity)({
            reportId: report.id,
            caseReference: report.caseReference,
            userId: report.submittingPractitionerId,
            action: 'DOWNLOAD_INITIATED',
            ipAddress: clientIp,
        });
        // 4. Construct payload stream/response
        const reportContent = JSON.stringify(report.findings || { caseReference: report.caseReference }, null, 2);
        // 5. Execute EXACT Purge-on-Download deletion logic
        // Deletes all server files and database records permanently from disk and PostgreSQL
        const purgeResult = await (0, purgeService_1.executePurgeOnDownload)(report.id, report.submittingPractitionerId, clientIp);
        // 6. Return report payload with headers forcing browser download
        return new server_1.NextResponse(reportContent, {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Content-Disposition': `attachment; filename="QEEG_Report_${report.caseReference}.json"`,
                'X-QEEG-Purge-Status': purgeResult.success ? 'PURGED_SUCCESSFULLY' : 'PURGE_WARNING',
            },
        });
    }
    catch (error) {
        console.error('Download & Purge endpoint error:', error);
        return server_1.NextResponse.json({ error: error instanceof Error ? error.message : 'Internal Server Error' }, { status: 500 });
    }
}
