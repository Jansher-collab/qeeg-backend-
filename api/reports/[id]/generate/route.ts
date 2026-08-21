import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { prisma } from '@/lib/backend/prisma';
import { compileCorrelationReport } from '@/lib/backend/services/correlationEngine';
import { capturePayment, voidPayment } from '@/lib/backend/services/paypalService';
import { logActivity } from '@/lib/backend/services/activityLogger';
import { sendReportReadyNotification } from '@/lib/backend/services/emailService';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: reportId } = await params;
    const clientIp = req.headers.get('x-forwarded-for') || '127.0.0.1';

    // 1. Fetch report from database
    const report = await prisma.qeeqReport.findUnique({
      where: { id: reportId },
    });

    if (!report) {
      return NextResponse.json({ error: 'Report not found.' }, { status: 404 });
    }

    if (report.status === 'COMPLETED') {
      return NextResponse.json(
        { message: 'Report has already been compiled.', reportId: report.id },
        { status: 200 }
      );
    }

    // Update status to GENERATING
    await prisma.qeeqReport.update({
      where: { id: reportId },
      data: { status: 'GENERATING' },
    });

    await logActivity({
      reportId: report.id,
      caseReference: report.caseReference,
      userId: report.submittingPractitionerId,
      action: 'REPORT_GENERATING',
      ipAddress: clientIp,
    });

    // 2. Execute Correlation Engine & Live Literature Pipeline
    const compiledFindings = await compileCorrelationReport(
      report.caseReference,
      report.age ?? undefined,
      report.gender ?? undefined,
      report.handedness ?? undefined,
      report.tovaData as Record<string, unknown> | undefined,
      report.checklistData as Record<string, unknown> | undefined,
      report.reliabilityScore ?? undefined
    );

    // Save report artifact file to server disk
    const reportsDir = path.join(process.cwd(), 'uploads', report.caseReference);
    await fs.mkdir(reportsDir, { recursive: true });
    const filePath = path.join(reportsDir, `QEEG_Report_${report.caseReference}.json`);
    await fs.writeFile(filePath, JSON.stringify(compiledFindings, null, 2), 'utf-8');

    // 3. CAPTURE payment via PayPal ONLY after correlation engine successfully completes
    let captureSuccess = false;
    let captureId: string | undefined;

    if (report.paypalAuthorizationId) {
      const captureResult = await capturePayment(report.paypalAuthorizationId, report.feeAmount);
      captureSuccess = captureResult.success;
      captureId = captureResult.captureId;

      if (!captureSuccess) {
        // Void authorization if capture fails
        await voidPayment(report.paypalAuthorizationId);
        await prisma.qeeqReport.update({
          where: { id: reportId },
          data: { status: 'PENDING_RELIABILITY', paymentStatus: 'FAILED' },
        });

        return NextResponse.json(
          { error: 'Payment capture failed.', details: captureResult.error },
          { status: 400 }
        );
      }
    } else {
      // Mock mode fallback
      captureSuccess = true;
      captureId = `CAP-MOCK-${reportId}`;
    }

    // 4. Update database report status to COMPLETED & paymentStatus to CAPTURED
    const updatedReport = await prisma.qeeqReport.update({
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
    await logActivity({
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

    await logActivity({
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
      const practitioner = await prisma.user.findUnique({
        where: { id: updatedReport.submittingPractitionerId },
        include: { practitionerProfile: true },
      });

      const recipientEmail =
        practitioner?.practitionerProfile?.notificationEmail ||
        practitioner?.practitionerProfile?.practiceEmail ||
        practitioner?.email;

      if (recipientEmail) {
        const downloadUrl = `${process.env.APP_BASE_URL || 'https://qeeg.com.au'}/portal`;
        const practitionerName =
          practitioner.practitionerProfile?.fullName || 'Practitioner';

        const emailResult = await sendReportReadyNotification(
          recipientEmail,
          practitionerName,
          updatedReport.caseReference,
          downloadUrl
        );

        if (emailResult.success) {
          await logActivity({
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
    } catch (emailErr) {
      console.warn('[SES Notification Warning] Non-blocking email dispatch issue:', emailErr);
    }

    return NextResponse.json({
      message: 'Report generated and payment captured successfully.',
      reportId: updatedReport.id,
      caseReference: updatedReport.caseReference,
      confidenceScore: compiledFindings.confidenceScore,
      status: updatedReport.status,
      paymentStatus: updatedReport.paymentStatus,
      reportData: compiledFindings,
    });
  } catch (error) {
    console.error('Report generation error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}
