import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { prisma } from '@/lib/backend/prisma';
import { verifyIngestionPayload, IngestionPayload } from '@/lib/backend/services/reliabilityParser';
import { authorisePayment, getReportFeeAUD, capturePayment, voidPayment } from '@/lib/backend/services/paypalService';
import { logActivity } from '@/lib/backend/services/activityLogger';
import { getAuthenticatedUser } from '@/lib/backend/services/authService';
import { executePurgeOnDownload } from '@/lib/backend/services/purgeService';
import { compileCorrelationReport } from '@/lib/backend/services/correlationEngine';
import { sendReportReadyNotification } from '@/lib/backend/services/emailService';

export async function GET(req: NextRequest, { params }: { params: { action: string[] } }) {
  const action = params.action;

  // Pattern: GET /api/reports/[id]/download
  if (action?.length === 2 && action[1] === 'download') {
    return handleDownload(req, action[0]);
  }

  return NextResponse.json({ error: 'Not Found' }, { status: 404 });
}

export async function POST(req: NextRequest, { params }: { params: { action: string[] } }) {
  const action = params.action;

  // Pattern: POST /api/reports/submit
  if (action?.length === 1 && action[0] === 'submit') {
    return handleSubmit(req);
  }

  // Pattern: POST /api/reports/[id]/generate
  if (action?.length === 2 && action[1] === 'generate') {
    return handleGenerate(req, action[0]);
  }

  return NextResponse.json({ error: 'Not Found' }, { status: 404 });
}

async function handleSubmit(req: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(req);
    const body = (await req.json()) as IngestionPayload & { submittingPractitionerId?: string };

    if (!body.caseReference) {
      return NextResponse.json(
        { error: 'Case reference is required.' },
        { status: 400 }
      )
    }

    const practitionerId = authUser?.id || body.submittingPractitionerId || 'default-practitioner-id';
    const clientIp = req.headers.get('x-forwarded-for') || '127.0.0.1';

    const verification = verifyIngestionPayload(body);

    if (!verification.passed) {
      await logActivity({
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

      return NextResponse.json(
        {
          error: 'Payload rejected by reliability backstop.',
          details: verification.rejectionReason,
          reliabilityScore: verification.reliabilityScore,
          threshold: verification.threshold,
          feeCharged: 0,
        },
        { status: 422 }
      );
    }

    const reportFeeAUD = await getReportFeeAUD();
    const authResult = await authorisePayment(body.caseReference, reportFeeAUD);

    if (!authResult.success) {
      return NextResponse.json(
        {
          error: 'PayPal payment authorisation failed.',
          details: authResult.error,
        },
        { status: 400 }
      );
    }

    let practitioner = await prisma.user.findUnique({
      where: { id: practitionerId },
    });

    if (!practitioner) {
      practitioner = await prisma.user.upsert({
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

    const report = await prisma.qeeqReport.create({
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

    await logActivity({
      reportId: report.id,
      caseReference: report.caseReference,
      userId: practitioner.id,
      action: 'SUBMISSION',
      details: { deidentified: true },
      ipAddress: clientIp,
    });

    await logActivity({
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

    await logActivity({
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

    return NextResponse.json(
      {
        message: 'De-identified payload ingested and payment authorised successfully.',
        reportId: report.id,
        caseReference: report.caseReference,
        reliabilityScore: verification.reliabilityScore,
        status: report.status,
        feeAmount: report.feeAmount,
        authorizationId: authResult.authorizationId,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Ingestion endpoint error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}

async function handleDownload(req: NextRequest, reportId: string) {
  try {
    const clientIp = req.headers.get('x-forwarded-for') || '127.0.0.1';

    const report = await prisma.qeeqReport.findUnique({
      where: { id: reportId },
    });

    if (!report) {
      return NextResponse.json(
        { error: 'Report not found or has already been downloaded and purged.' },
        { status: 404 }
      );
    }

    if (report.status !== 'COMPLETED') {
      return NextResponse.json(
        { error: 'Report is not ready for download yet.', status: report.status },
        { status: 400 }
      );
    }

    const requestingPractitionerId = req.headers.get('x-practitioner-id') || report.submittingPractitionerId;
    if (requestingPractitionerId !== report.submittingPractitionerId) {
      return NextResponse.json(
        { error: 'Unauthorized: Report belongs exclusively to the submitting practitioner.' },
        { status: 403 }
      );
    }

    await logActivity({
      reportId: report.id,
      caseReference: report.caseReference,
      userId: report.submittingPractitionerId,
      action: 'DOWNLOAD_INITIATED',
      ipAddress: clientIp,
    });

    const reportContent = JSON.stringify(report.findings || { caseReference: report.caseReference }, null, 2);
    const purgeResult = await executePurgeOnDownload(report.id, report.submittingPractitionerId, clientIp);

    return new NextResponse(reportContent, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="QEEG_Report_${report.caseReference}.json"`,
        'X-QEEG-Purge-Status': purgeResult.success ? 'PURGED_SUCCESSFULLY' : 'PURGE_WARNING',
      },
    });
  } catch (error) {
    console.error('Download & Purge endpoint error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}

async function handleGenerate(req: NextRequest, reportId: string) {
  try {
    const clientIp = req.headers.get('x-forwarded-for') || '127.0.0.1';

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

    const compiledFindings = await compileCorrelationReport(
      report.caseReference,
      report.age ?? undefined,
      report.gender ?? undefined,
      report.handedness ?? undefined,
      report.tovaData as Record<string, unknown> | undefined,
      report.checklistData as Record<string, unknown> | undefined,
      report.reliabilityScore ?? undefined
    );

    const reportsDir = path.join(process.cwd(), 'uploads', report.caseReference);
    await fs.mkdir(reportsDir, { recursive: true });
    const filePath = path.join(reportsDir, `QEEG_Report_${report.caseReference}.json`);
    await fs.writeFile(filePath, JSON.stringify(compiledFindings, null, 2), 'utf-8');

    let captureSuccess = false;
    let captureId: string | undefined;

    if (report.paypalAuthorizationId) {
      const captureResult = await capturePayment(report.paypalAuthorizationId, report.feeAmount);
      captureSuccess = captureResult.success;
      captureId = captureResult.captureId;

      if (!captureSuccess) {
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
      captureSuccess = true;
      captureId = `CAP-MOCK-${reportId}`;
    }

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
