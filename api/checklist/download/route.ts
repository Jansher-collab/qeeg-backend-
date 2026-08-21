import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getAuthenticatedUser } from '@/lib/services/authService';
import { generatePreFilledChecklistPDF } from '@/lib/services/pdfService';

export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(req);
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const userWithProfile = await prisma.user.findUnique({
      where: { id: authUser.id },
      include: { practitionerProfile: true },
    });

    const profile = userWithProfile?.practitionerProfile;

    const pdfBuffer = await generatePreFilledChecklistPDF({
      fullName: profile?.fullName || authUser.email.split('@')[0],
      professionalTitle: profile?.professionalTitle || undefined,
      profession: profile?.profession || undefined,
      providerNumber: profile?.providerNumber || undefined,
      clinicName: profile?.clinicName || undefined,
      practiceAddress: profile?.practiceAddress || undefined,
      phone: profile?.phone || undefined,
      practiceEmail: profile?.practiceEmail || authUser.email,
    });

    return new NextResponse(Buffer.from(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="QEEG_Symptom_Checklist.pdf"',
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error: any) {
    console.error('[Checklist PDF Download Error]', error);
    return NextResponse.json(
      { error: error.message || 'Failed to generate symptom checklist PDF.' },
      { status: 500 }
    );
  }
}
