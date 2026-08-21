import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/backend/prisma';
import { verifyIngestionPayload, IngestionPayload } from '@/lib/backend/services/reliabilityParser';
import { authorisePayment, getReportFeeAUD } from '@/lib/backend/services/paypalService';
import { logActivity } from '@/lib/backend/services/activityLogger';
import { getAuthenticatedUser } from '@/lib/backend/services/authService';

export async function POST(req: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(req);
    const body: IngestionPayload & { submittingPractitionerId?: string } = await req.json();

    if (!body.caseReference) {
      return NextResponse.json(
        { error: 'Case reference is required.' },
        { status: 400 }
      )
    }

    const practitionerId = authUser?.id || body.submittingPractitionerId || 'default-practitioner-id';
    const clientIp = req.headers.get('x-forwarded-for') || '127.0.0.1';

    // 1. Server-side Reliability Verification & De-identification Backstop
    const verification = verifyIngestionPayload(body);

    if (!verification.passed) {
      // Rejection event: Record activity log, zero fees charged, return 422
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

    // 2. Query dynamic report fee from database settings (default AU$65.00)
    const reportFeeAUD = await getReportFeeAUD();

    // 3. Authorise payment via PayPal API (Funds are NOT captured yet)
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

    // 4. Ensure practitioner exists in DB (or create fallback demo practitioner)
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

    // 5. Create QeeqReport in PostgreSQL tied exclusively to submitting practitioner
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

    // 6. Log submission, verification pass, and payment authorisation steps
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
