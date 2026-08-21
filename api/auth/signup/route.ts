import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/backend/prisma';
import { hashPassword, generateToken, getSessionCookieName, getSessionCookieOptions } from '@/lib/backend/services/authService';
import { logActivity } from '@/lib/backend/services/activityLogger';
import { UserRole } from '@/generated/prisma/client';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      email,
      password,
      role = 'PRACTITIONER',
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

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required.' },
        { status: 400 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters long.' },
        { status: 400 }
      );
    }

    // Check if user with this email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: 'An account with this email address already exists.' },
        { status: 409 }
      );
    }

    const passwordHash = await hashPassword(password);
    const assignedRole = role === 'NEUROSCIENTIST' ? UserRole.NEUROSCIENTIST : UserRole.PRACTITIONER;

    // Create User and PractitionerProfile in transaction
    const newUser = await prisma.user.create({
      data: {
        email: email.toLowerCase().trim(),
        passwordHash,
        role: assignedRole,
        practitionerProfile: {
          create: {
            fullName: fullName?.trim() || null,
            professionalTitle: professionalTitle?.trim() || null,
            profession: profession?.trim() || null,
            providerNumber: providerNumber?.trim() || null,
            clinicName: clinicName?.trim() || null,
            practiceAddress: practiceAddress?.trim() || null,
            phone: phone?.trim() || null,
            practiceEmail: practiceEmail?.trim() || null,
            notificationEmail: notificationEmail?.trim() || email.toLowerCase().trim(),
          },
        },
      },
      include: {
        practitionerProfile: true,
      },
    });

    // Generate JWT token
    const token = generateToken({
      userId: newUser.id,
      email: newUser.email,
      role: newUser.role,
    });

    // Log Activity
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    await logActivity({
      userId: newUser.id,
      action: 'PRACTITIONER_REGISTERED',
      details: {
        role: newUser.role,
        profession: newUser.practitionerProfile?.profession,
        clinicName: newUser.practitionerProfile?.clinicName,
      },
      ipAddress: ip,
    });

    const response = NextResponse.json(
      {
        message: 'Account created successfully.',
        user: {
          id: newUser.id,
          email: newUser.email,
          role: newUser.role,
          practitionerProfile: newUser.practitionerProfile,
        },
      },
      { status: 201 }
    );

    // Set secure session cookie
    const cookieOptions = getSessionCookieOptions();
    response.cookies.set(cookieOptions.name, token, cookieOptions);

    return response;
  } catch (error: any) {
    console.error('Error during signup:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to create account.' },
      { status: 500 }
    );
  }
}
