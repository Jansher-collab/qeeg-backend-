import { NextRequest, NextResponse } from 'next/server';
import { getActivityLogs } from '@/lib/backend/services/activityLogger';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const caseReference = searchParams.get('caseReference') || undefined;
    const reportId = searchParams.get('reportId') || undefined;
    const userId = searchParams.get('userId') || undefined;
    const limitStr = searchParams.get('limit');
    const limit = limitStr ? parseInt(limitStr, 10) : 50;

    const logs = await getActivityLogs({
      caseReference,
      reportId,
      userId,
      limit,
    });

    return NextResponse.json({
      count: logs.length,
      logs,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}
