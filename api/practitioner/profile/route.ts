import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/backend/prisma';
import { getAuthenticatedUser } from '@/lib/backend/services/authService';

export async function GET(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const profile = await prisma.practitionerProfile.findUnique({
      where: { userId: user.id },
    });

    return NextResponse.json({ profile });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const body = (await req.json()) as {
      fullName?: string;
      professionalTitle?: string;
      profession?: string;
      providerNumber?: string;
      clinicName?: string;
      practiceAddress?: string;
      phone?: string;
      practiceEmail?: string;
      notificationEmail?: string;
    };
    const {
      fullName,
      professionalTitle,
      profession,
      providerNumber,
      clinicName,
      practiceAddress,
      phone,
      practiceEmail,
      notificationEmail,
    } = body;

    const updatedProfile = await prisma.practitionerProfile.upsert({
      where: { userId: user.id },
      update: {
        fullName: fullName?.trim() || null,
        professionalTitle: professionalTitle?.trim() || null,
        profession: profession?.trim() || null,
        providerNumber: providerNumber?.trim() || null,
        clinicName: clinicName?.trim() || null,
        practiceAddress: practiceAddress?.trim() || null,
        phone: phone?.trim() || null,
        practiceEmail: practiceEmail?.trim() || null,
        notificationEmail: notificationEmail?.trim() || null,
      },
      create: {
        userId: user.id,
        fullName: fullName?.trim() || null,
        professionalTitle: professionalTitle?.trim() || null,
        profession: profession?.trim() || null,
        providerNumber: providerNumber?.trim() || null,
        clinicName: clinicName?.trim() || null,
        practiceAddress: practiceAddress?.trim() || null,
        phone: phone?.trim() || null,
        practiceEmail: practiceEmail?.trim() || null,
        notificationEmail: notificationEmail?.trim() || user.email,
      },
    });

    return NextResponse.json({
      message: 'Profile updated successfully.',
      profile: updatedProfile,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
