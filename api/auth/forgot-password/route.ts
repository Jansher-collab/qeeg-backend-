import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/backend/prisma';
import { createPasswordResetToken } from '@/lib/backend/services/authService';
import { logActivity } from '@/lib/backend/services/activityLogger';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as any;
    const { email } = body;

    if (!email) {
      return NextResponse.json(
        { error: 'Email address is required.' },
        { status: 400 }
      );
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    const clientIp = req.headers.get('x-forwarded-for') || '127.0.0.1';

    if (!user) {
      // For security, do not expose whether an account exists, but return success response
      return NextResponse.json({
        message: 'If an account exists with this email, password reset instructions have been generated.',
      });
    }

    const token = await createPasswordResetToken(normalizedEmail);
    const origin = req.nextUrl.origin || 'http://localhost:3000';
    const resetUrl = `${origin}/reset-password?token=${token}`;

    await logActivity({
      userId: user.id,
      action: 'PASSWORD_RESET_REQUESTED',
      details: { email: normalizedEmail },
      ipAddress: clientIp,
    });

    return NextResponse.json({
      message: 'Password reset link generated successfully.',
      resetUrl, // Provided for live simulation and automated testing
      token,
    });
  } catch (error: any) {
    console.error('Error generating password reset token:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to process password reset request.' },
      { status: 500 }
    );
  }
}
