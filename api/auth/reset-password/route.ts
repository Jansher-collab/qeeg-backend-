import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/backend/prisma';
import { hashPassword, validatePasswordResetToken } from '@/lib/backend/services/authService';
import { logActivity } from '@/lib/backend/services/activityLogger';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as any;
    const { token, newPassword } = body;

    if (!token || !newPassword) {
      return NextResponse.json(
        { error: 'Token and new password are required.' },
        { status: 400 }
      );
    }

    if (newPassword.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters long.' },
        { status: 400 }
      );
    }

    // Validate the reset token
    const tokenRecord = await validatePasswordResetToken(token);
    if (!tokenRecord) {
      return NextResponse.json(
        { error: 'This password reset link is invalid or has expired.' },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { email: tokenRecord.email },
    });

    if (!user) {
      return NextResponse.json(
        { error: 'User account associated with this token was not found.' },
        { status: 404 }
      );
    }

    const passwordHash = await hashPassword(newPassword);

    // Update password and mark token as used in a transaction
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      }),
      prisma.passwordResetToken.update({
        where: { id: tokenRecord.id },
        data: { used: true },
      }),
    ]);

    const clientIp = req.headers.get('x-forwarded-for') || '127.0.0.1';
    await logActivity({
      userId: user.id,
      action: 'PASSWORD_RESET_COMPLETED',
      details: { email: tokenRecord.email },
      ipAddress: clientIp,
    });

    return NextResponse.json({
      message: 'Password reset successfully. You may now log in with your new password.',
    });
  } catch (error: any) {
    console.error('Error resetting password:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to reset password.' },
      { status: 500 }
    );
  }
}
