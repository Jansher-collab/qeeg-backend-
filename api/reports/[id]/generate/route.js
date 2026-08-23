"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.POST = POST;
const server_1 = require("next/server");
const path_1 = __importDefault(require("path"));
const promises_1 = __importDefault(require("fs/promises"));
const prisma_1 = require("@/lib/backend/prisma");
const correlationEngine_1 = require("@/lib/backend/services/correlationEngine");
const paypalService_1 = require("@/lib/backend/services/paypalService");
const activityLogger_1 = require("@/lib/backend/services/activityLogger");
const emailService_1 = require("@/lib/backend/services/emailService");
async function POST(req, { params }) {
    try {
        const { id: reportId } = await params;
        const clientIp = req.headers.get('x-forwarded-for') || '127.0.0.1';
        // 1. Fetch report from database
        const report = await prisma_1.prisma.qeeqReport.findUnique({
            where: { id: reportId },
        });
        if (!report) {
            return server_1.NextResponse.json({ error: 'Report not found.' }, { status: 404 });
        }
        if (report.status === 'COMPLETED') {
            return server_1.NextResponse.json({ message: 'Report has already been compiled.', reportId: report.id }, { status: 200 });
        }
        // Update status to GENERATING
        await prisma_1.prisma.qeeqReport.update({
            where: { id: reportId },
            data: { status: 'GENERATING' },
        });
        await (0, activityLogger_1.logActivity)({
            reportId: report.id,
            caseReference: report.caseReference,
            userId: report.submittingPractitionerId,
            action: 'REPORT_GENERATING',
            ipAddress: clientIp,
        });
        // 2. Execute Correlation Engine & Live Literature Pipeline
        const compiledFindings = await (0, correlationEngine_1.compileCorrelationReport)(report.caseReference, report.age ?? undefined, report.gender ?? undefined, report.handedness ?? undefined, report.tovaData, report.checklistData, report.reliabilityScore ?? undefined);
        // Save report artifact file to server disk
        const reportsDir = path_1.default.join(process.cwd(), 'uploads', report.caseReference);
        await promises_1.default.mkdir(reportsDir, { recursive: true });
        const filePath = path_1.default.join(reportsDir, `QEEG_Report_${report.caseReference}.json`);
        await promises_1.default.writeFile(filePath, JSON.stringify(compiledFindings, null, 2), 'utf-8');
        // 3. CAPTURE payment via PayPal ONLY after correlation engine successfully completes
        let captureSuccess = false;
        let captureId;
        if (report.paypalAuthorizationId) {
            const captureResult = await (0, paypalService_1.capturePayment)(report.paypalAuthorizationId, report.feeAmount);
            captureSuccess = captureResult.success;
            captureId = captureResult.captureId;
            if (!captureSuccess) {
                // Void authorization if capture fails
                await (0, paypalService_1.voidPayment)(report.paypalAuthorizationId);
                await prisma_1.prisma.qeeqReport.update({
                    where: { id: reportId },
                    data: { status: 'PENDING_RELIABILITY', paymentStatus: 'FAILED' },
                });
                return server_1.NextResponse.json({ error: 'Payment capture failed.', details: captureResult.error }, { status: 400 });
            }
        }
        else {
            // Mock mode fallback
            captureSuccess = true;
            captureId = `CAP-MOCK-${reportId}`;
        }
        // 4. Update database report status to COMPLETED & paymentStatus to CAPTURED
        const updatedReport = await prisma_1.prisma.qeeqReport.update({
            where: { id: reportId },
            data: {
                status: 'COMPLETED',
                confidenceScore: compiledFindings.confidenceScore,
                findings: JSON.parse(JSON.stringify(compiledFindings)),
                reportSummary: compiledFindings.overallSummary,
                filePaths: [filePath],
                paypalCaptureId: captureId,
                paymentStatus: 'CAPTURED',
            },
        });
        // 5. Log REPORT_GENERATED and PAYMENT_CAPTURED activity
        await (0, activityLogger_1.logActivity)({
            reportId: updatedReport.id,
            caseReference: updatedReport.caseReference,
            userId: updatedReport.submittingPractitionerId,
            action: 'REPORT_GENERATED',
            details: {
                confidenceScore: compiledFindings.confidenceScore,
                domainCount: compiledFindings.domains.length,
            },
            ipAddress: clientIp,
        });
        await (0, activityLogger_1.logActivity)({
            reportId: updatedReport.id,
            caseReference: updatedReport.caseReference,
            userId: updatedReport.submittingPractitionerId,
            action: 'PAYMENT_CAPTURED',
            details: {
                captureId,
                amountCaptured: updatedReport.feeAmount,
                currency: 'AUD',
            },
            ipAddress: clientIp,
        });
        // 6. Trigger Amazon SES (ap-southeast-2 Sydney) Transactional Email Notification
        try {
            const practitioner = await prisma_1.prisma.user.findUnique({
                where: { id: updatedReport.submittingPractitionerId },
                include: { practitionerProfile: true },
            });
            const recipientEmail = practitioner?.practitionerProfile?.notificationEmail ||
                practitioner?.practitionerProfile?.practiceEmail ||
                practitioner?.email;
            if (recipientEmail) {
                const downloadUrl = `${process.env.APP_BASE_URL || 'https://qeeg.com.au'}/portal`;
                const practitionerName = practitioner.practitionerProfile?.fullName || 'Practitioner';
                const emailResult = await (0, emailService_1.sendReportReadyNotification)(recipientEmail, practitionerName, updatedReport.caseReference, downloadUrl);
                if (emailResult.success) {
                    await (0, activityLogger_1.logActivity)({
                        reportId: updatedReport.id,
                        caseReference: updatedReport.caseReference,
                        userId: updatedReport.submittingPractitionerId,
                        action: 'EMAIL_DISPATCHED_SES',
                        details: {
                            recipient: recipientEmail,
                            region: 'ap-southeast-2',
                            messageId: emailResult.messageId,
                        },
                        ipAddress: clientIp,
                    });
                }
            }
        }
        catch (emailErr) {
            console.warn('[SES Notification Warning] Non-blocking email dispatch issue:', emailErr);
        }
        return server_1.NextResponse.json({
            message: 'Report generated and payment captured successfully.',
            reportId: updatedReport.id,
            caseReference: updatedReport.caseReference,
            confidenceScore: compiledFindings.confidenceScore,
            status: updatedReport.status,
            paymentStatus: updatedReport.paymentStatus,
            reportData: compiledFindings,
        });
    }
    catch (error) {
        console.error('Report generation error:', error);
        return server_1.NextResponse.json({ error: error instanceof Error ? error.message : 'Internal Server Error' }, { status: 500 });
    }
}
