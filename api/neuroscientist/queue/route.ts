import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/backend/prisma';
import { getAuthenticatedUser } from '@/lib/backend/services/authService';

export async function GET(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user || (user.role !== 'NEUROSCIENTIST' && user.role !== 'ADMIN')) {
      return NextResponse.json(
        { error: 'Forbidden. Access restricted to Clinical Neuroscientists and Administrators.' },
        { status: 403 }
      );
    }

    // Fetch reports awaiting review or in processing
    const queue = await prisma.qeeqReport.findMany({
      where: {
        status: {
          in: ['IN_NEUROSCIENTIST_REVIEW', 'GENERATING', 'PENDING_RELIABILITY', 'COMPLETED'],
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        submittingPractitioner: {
          select: {
            email: true,
            practitionerProfile: {
              select: {
                fullName: true,
                clinicName: true,
                profession: true,
              },
            },
          },
        },
      },
    });

    return NextResponse.json({
      queue,
      count: queue.length,
    });
  } catch (error: any) {
    console.error('Error fetching review queue:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
