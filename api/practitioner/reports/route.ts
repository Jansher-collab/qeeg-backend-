import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/backend/prisma';
import { getAuthenticatedUser } from '@/lib/backend/services/authService';

export async function GET(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized. Please log in to access your reports.' },
        { status: 401 }
      );
    }

    // Fetch reports for this practitioner
    const reports = await prisma.qeeqReport.findMany({
      where: {
        submittingPractitionerId: user.id,
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        caseReference: true,
        status: true,
        confidenceScore: true,
        reliabilityScore: true,
        age: true,
        gender: true,
        handedness: true,
        reportSummary: true,
        reviewerNotes: true,
        reviewedBy: true,
        reviewedAt: true,
        feeAmount: true,
        paymentStatus: true,
        createdAt: true,
        updatedAt: true,
        downloadedAt: true,
        purgedAt: true,
      },
    });

    return NextResponse.json({
      reports,
      count: reports.length,
    });
  } catch (error: any) {
    console.error('Error fetching practitioner reports:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch reports.' },
      { status: 500 }
    );
  }
}
