"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GET = GET;
exports.POST = POST;
const server_1 = require("next/server");
const path_1 = __importDefault(require("path"));
const promises_1 = __importDefault(require("fs/promises"));
const prisma_1 = require("@/lib/backend/prisma");
const reliabilityParser_1 = require("@/lib/backend/services/reliabilityParser");
const paypalService_1 = require("@/lib/backend/services/paypalService");
const activityLogger_1 = require("@/lib/backend/services/activityLogger");
const authService_1 = require("@/lib/backend/services/authService");
const purgeService_1 = require("@/lib/backend/services/purgeService");
const correlationEngine_1 = require("@/lib/backend/services/correlationEngine");
const emailService_1 = require("@/lib/backend/services/emailService");
async function GET(req, { params }) {
    const action = params.action;
    // Pattern: GET /api/reports/[id]/download
    if (action?.length === 2 && action[1] === 'download') {
        return handleDownload(req, action[0]);
    }
    return server_1.NextResponse.json({ error: 'Not Found' }, { status: 404 });
}
async function POST(req, { params }) {
    const action = params.action;
    // Pattern: POST /api/reports/submit
    if (action?.length === 1 && action[0] === 'submit') {
        return handleSubmit(req);
    }
    // Pattern: POST /api/reports/[id]/generate
    if (action?.length === 2 && action[1] === 'generate') {
        return handleGenerate(req, action[0]);
    }
    return server_1.NextResponse.json({ error: 'Not Found' }, { status: 404 });
}
async function handleSubmit(req) {
    try {
        const authUser = await (0, authService_1.getAuthenticatedUser)(req);
        const body = (await req.json());
        if (!body.caseReference) {
            return server_1.NextResponse.json({ error: 'Case reference is required.' }, { status: 400 });
        }
        const practitionerId = authUser?.id || body.submittingPractitionerId || 'default-practitioner-id';
        const clientIp = req.headers.get('x-forwarded-for') || '127.0.0.1';
        const verification = (0, reliabilityParser_1.verifyIngestionPayload)(body);
        if (!verification.passed) {
            await (0, activityLogger_1.logActivity)({
                caseReference: body.caseReference,
                userId: practitionerId,
                action: 'RELIABILITY_FAIL',
                details: {
                    reliabilityScore: verification.reliabilityScore,
                    threshold: verification.threshold,
                    reason: verification.rejectionReason,
                    zeroFeeEnforced: true,
                },
                ipAddress: clientIp,
            });
            return server_1.NextResponse.json({
                error: 'Payload rejected by reliability backstop.',
                details: verification.rejectionReason,
                reliabilityScore: verification.reliabilityScore,
                threshold: verification.threshold,
                feeCharged: 0,
            }, { status: 422 });
        }
        const reportFeeAUD = await (0, paypalService_1.getReportFeeAUD)();
        const authResult = await (0, paypalService_1.authorisePayment)(body.caseReference, reportFeeAUD);
        if (!authResult.success) {
            return server_1.NextResponse.json({
                error: 'PayPal payment authorisation failed.',
                details: authResult.error,
            }, { status: 400 });
        }
        let practitioner = await prisma_1.prisma.user.findUnique({
            where: { id: practitionerId },
        });
        if (!practitioner) {
            practitioner = await prisma_1.prisma.user.upsert({
                where: { email: 'practitioner@qeeg.com.au' },
                update: {},
                create: {
                    id: practitionerId,
                    email: 'practitioner@qeeg.com.au',
                    passwordHash: '$2b$10$demoHashForQeegPlatformBackend',
                    role: 'PRACTITIONER',
                },
            });
        }
        const report = await prisma_1.prisma.qeeqReport.create({
            data: {
                caseReference: body.caseReference,
                status: 'PAYMENT_AUTHORISED',
                reliabilityScore: verification.reliabilityScore,
                age: verification.age,
                gender: verification.gender,
                handedness: verification.handedness,
                tovaData: body.tovaData ? JSON.parse(JSON.stringify(body.tovaData)) : undefined,
                checklistData: body.checklistData ? JSON.parse(JSON.stringify(body.checklistData)) : undefined,
                paypalAuthorizationId: authResult.authorizationId,
                feeAmount: reportFeeAUD,
                paymentStatus: 'AUTHORISED',
                submittingPractitionerId: practitioner.id,
            },
        });
        await (0, activityLogger_1.logActivity)({
            reportId: report.id,
            caseReference: report.caseReference,
            userId: practitioner.id,
            action: 'SUBMISSION',
            details: { deidentified: true },
            ipAddress: clientIp,
        });
        await (0, activityLogger_1.logActivity)({
            reportId: report.id,
            caseReference: report.caseReference,
            userId: practitioner.id,
            action: 'RELIABILITY_VERIFICATION',
            details: {
                passed: true,
                reliabilityScore: verification.reliabilityScore,
                threshold: verification.threshold,
            },
            ipAddress: clientIp,
        });
        await (0, activityLogger_1.logActivity)({
            reportId: report.id,
            caseReference: report.caseReference,
            userId: practitioner.id,
            action: 'PAYMENT_AUTHORISED',
            details: {
                authorizationId: authResult.authorizationId,
                amount: reportFeeAUD,
                currency: 'AUD',
            },
            ipAddress: clientIp,
        });
        return server_1.NextResponse.json({
            message: 'De-identified payload ingested and payment authorised successfully.',
            reportId: report.id,
            caseReference: report.caseReference,
            reliabilityScore: verification.reliabilityScore,
            status: report.status,
            feeAmount: report.feeAmount,
            authorizationId: authResult.authorizationId,
        }, { status: 201 });
    }
    catch (error) {
        console.error('Ingestion endpoint error:', error);
        return server_1.NextResponse.json({ error: error instanceof Error ? error.message : 'Internal Server Error' }, { status: 500 });
    }
}
async function handleDownload(req, reportId) {
    try {
        const clientIp = req.headers.get('x-forwarded-for') || '127.0.0.1';
        const report = await prisma_1.prisma.qeeqReport.findUnique({
            where: { id: reportId },
        });
        if (!report) {
            return server_1.NextResponse.json({ error: 'Report not found or has already been downloaded and purged.' }, { status: 404 });
        }
        if (report.status !== 'COMPLETED') {
            return server_1.NextResponse.json({ error: 'Report is not ready for download yet.', status: report.status }, { status: 400 });
        }
        const requestingPractitionerId = req.headers.get('x-practitioner-id') || report.submittingPractitionerId;
        if (requestingPractitionerId !== report.submittingPractitionerId) {
            return server_1.NextResponse.json({ error: 'Unauthorized: Report belongs exclusively to the submitting practitioner.' }, { status: 403 });
        }
        await (0, activityLogger_1.logActivity)({
            reportId: report.id,
            caseReference: report.caseReference,
            userId: report.submittingPractitionerId,
            action: 'DOWNLOAD_INITIATED',
            ipAddress: clientIp,
        });
        const reportContent = JSON.stringify(report.findings || { caseReference: report.caseReference }, null, 2);
        const purgeResult = await (0, purgeService_1.executePurgeOnDownload)(report.id, report.submittingPractitionerId, clientIp);
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
async function handleGenerate(req, reportId) {
    try {
        const clientIp = req.headers.get('x-forwarded-for') || '127.0.0.1';
        const report = await prisma_1.prisma.qeeqReport.findUnique({
            where: { id: reportId },
        });
        if (!report) {
            return server_1.NextResponse.json({ error: 'Report not found.' }, { status: 404 });
        }
        if (report.status === 'COMPLETED') {
            return server_1.NextResponse.json({ message: 'Report has already been compiled.', reportId: report.id }, { status: 200 });
        }
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
        const compiledFindings = await (0, correlationEngine_1.compileCorrelationReport)(report.caseReference, report.age ?? undefined, report.gender ?? undefined, report.handedness ?? undefined, report.tovaData, report.checklistData, report.reliabilityScore ?? undefined);
        const reportsDir = path_1.default.join(process.cwd(), 'uploads', report.caseReference);
        await promises_1.default.mkdir(reportsDir, { recursive: true });
        const filePath = path_1.default.join(reportsDir, `QEEG_Report_${report.caseReference}.json`);
        await promises_1.default.writeFile(filePath, JSON.stringify(compiledFindings, null, 2), 'utf-8');
        let captureSuccess = false;
        let captureId;
        if (report.paypalAuthorizationId) {
            const captureResult = await (0, paypalService_1.capturePayment)(report.paypalAuthorizationId, report.feeAmount);
            captureSuccess = captureResult.success;
            captureId = captureResult.captureId;
            if (!captureSuccess) {
                await (0, paypalService_1.voidPayment)(report.paypalAuthorizationId);
                await prisma_1.prisma.qeeqReport.update({
                    where: { id: reportId },
                    data: { status: 'PENDING_RELIABILITY', paymentStatus: 'FAILED' },
                });
                return server_1.NextResponse.json({ error: 'Payment capture failed.', details: captureResult.error }, { status: 400 });
            }
        }
        else {
            captureSuccess = true;
            captureId = `CAP-MOCK-${reportId}`;
        }
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
