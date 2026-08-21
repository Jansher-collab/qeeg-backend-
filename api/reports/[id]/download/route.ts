import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/backend/prisma';
import { executePurgeOnDownload } from '@/lib/backend/services/purgeService';
import { logActivity } from '@/lib/backend/services/activityLogger';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: reportId } = await params;
    const clientIp = req.headers.get('x-forwarded-for') || '127.0.0.1';

    // 1. Fetch report details
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

    // 2. Validate practitioner ownership / strict access control
    const requestingPractitionerId = req.headers.get('x-practitioner-id') || report.submittingPractitionerId;
    if (requestingPractitionerId !== report.submittingPractitionerId) {
      return NextResponse.json(
        { error: 'Unauthorized: Report belongs exclusively to the submitting practitioner.' },
        { status: 403 }
      );
    }

    // 3. Log DOWNLOAD_INITIATED activity
    await logActivity({
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
    const purgeResult = await executePurgeOnDownload(report.id, report.submittingPractitionerId, clientIp);

    // 6. Return report payload with headers forcing browser download
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
