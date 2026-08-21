import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/backend/prisma';
import { verifyPassword, generateToken, getSessionCookieOptions } from '@/lib/backend/services/authService';
import { logActivity } from '@/lib/backend/services/activityLogger';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as any;
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required.' },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: {
        practitionerProfile: true,
      },
    });

    if (!user) {
      return NextResponse.json(
        { error: 'Invalid email or password.' },
        { status: 401 }
      );
    }

    const isValidPassword = await verifyPassword(password, user.passwordHash);
    if (!isValidPassword) {
      return NextResponse.json(
        { error: 'Invalid email or password.' },
        { status: 401 }
      );
    }

    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    // Log Activity
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    await logActivity({
      userId: user.id,
      action: 'USER_LOGIN',
      details: { role: user.role },
      ipAddress: ip,
    });

    const response = NextResponse.json({
      message: 'Login successful.',
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        practitionerProfile: user.practitionerProfile,
      },
    });

    // Set secure session cookie
    const cookieOptions = getSessionCookieOptions();
    response.cookies.set(cookieOptions.name, token, cookieOptions);

    return response;
  } catch (error: any) {
    console.error('Error during login:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to login.' },
      { status: 500 }
    );
  }
}
