import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/backend/prisma';
import { getAuthenticatedUser } from '@/lib/backend/services/authService';
import { logActivity } from '@/lib/backend/services/activityLogger';
import { ReportStatus } from '@/generated/prisma/client';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user || (user.role !== 'NEUROSCIENTIST' && user.role !== 'ADMIN')) {
      return NextResponse.json(
        { error: 'Forbidden. Access restricted to Clinical Neuroscientists.' },
        { status: 403 }
      );
    }

    const { id } = await context.params;
    const body = await req.json();
    const { action, reviewerNotes, editedSummary, findings } = body;

    const report = await prisma.qeeqReport.findUnique({
      where: { id },
    });

    if (!report) {
      return NextResponse.json({ error: 'Report not found.' }, { status: 404 });
    }

    const newStatus = action === 'APPROVE' ? ReportStatus.COMPLETED : ReportStatus.RELIABILITY_REJECTED;

    const updatedReport = await prisma.qeeqReport.update({
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
    await logActivity({
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

    return NextResponse.json({
      message: `Report ${action === 'APPROVE' ? 'approved' : 'rejected'} successfully.`,
      report: updatedReport,
    });
  } catch (error: any) {
    console.error('Error reviewing report:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
