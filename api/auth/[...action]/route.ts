import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/backend/prisma';
import {
  verifyPassword,
  generateToken,
  getSessionCookieName,
  getSessionCookieOptions,
  hashPassword,
  getAuthenticatedUser,
  createPasswordResetToken,
  validatePasswordResetToken,
} from '@/lib/backend/services/authService';
import { logActivity } from '@/lib/backend/services/activityLogger';
import { UserRole } from '@/generated/prisma/client';

export async function GET(req: NextRequest, { params }: { params: { action: string[] } }) {
  const action = params.action?.[0];

  if (action === 'me') {
    return handleMe(req);
  }

  return NextResponse.json({ error: 'Not Found' }, { status: 404 });
}

export async function POST(req: NextRequest, { params }: { params: { action: string[] } }) {
  const action = params.action?.[0];

  switch (action) {
    case 'login':
      return handleLogin(req);
    case 'logout':
      return handleLogout(req);
    case 'signup':
      return handleSignup(req);
    case 'forgot-password':
      return handleForgotPassword(req);
    case 'reset-password':
      return handleResetPassword(req);
    default:
      return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }
}

async function handleMe(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json({ authenticated: false, user: null }, { status: 401 });
    }

    return NextResponse.json({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        practitionerProfile: user.practitionerProfile,
      },
    });
  } catch (error: any) {
    console.error('Error verifying auth session:', error);
    return NextResponse.json({ authenticated: false, user: null }, { status: 500 });
  }
}

async function handleLogin(req: NextRequest) {
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

async function handleLogout(req: NextRequest) {
  const response = NextResponse.json({ message: 'Logged out successfully.' });
  const cookieName = getSessionCookieName();

  response.cookies.set(cookieName, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  return response;
}

async function handleSignup(req: NextRequest) {
  try {
    const body = (await req.json()) as any;
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

    const token = generateToken({
      userId: newUser.id,
      email: newUser.email,
      role: newUser.role,
    });

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

async function handleForgotPassword(req: NextRequest) {
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
      resetUrl,
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

async function handleResetPassword(req: NextRequest) {
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
