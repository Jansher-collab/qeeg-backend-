import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../prisma';
import { UserRole } from '@prisma/client';

const JWT_SECRET = process.env.JWT_SECRET || 'qeeg-sydney-secure-jwt-secret-2026-production';
const SESSION_COOKIE_NAME = 'qeeg_session_token';
const TOKEN_EXPIRY = '24h';

export interface TokenPayload {
  userId: string;
  email: string;
  role: UserRole;
  name?: string;
  profession?: string;
  clinicName?: string;
  providerNumber?: string;
  phone?: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  practitionerProfile?: {
    id: string;
    fullName: string | null;
    professionalTitle: string | null;
    professionType: string | null;
    profession: string | null;
    providerNumber: string | null;
    practiceName: string | null;
    clinicName: string | null;
    practiceAddress: string | null;
    practicePhone: string | null;
    phone: string | null;
    practiceEmail: string | null;
    notificationEmail: string | null;
  } | null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch (error) {
    return null;
  }
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE_NAME;
}

export function getSessionCookieOptions() {
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 60 * 60 * 24, // 24 hours
  };
}

/**
 * Creates a secure password reset token valid for 1 hour
 */
export async function createPasswordResetToken(email: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  // Invalidate any existing unused reset tokens for this email
  await prisma.passwordResetToken.updateMany({
    where: { email: email.toLowerCase().trim(), used: false },
    data: { used: true },
  });

  await prisma.passwordResetToken.create({
    data: {
      email: email.toLowerCase().trim(),
      token,
      expiresAt,
      used: false,
    },
  });

  return token;
}

/**
 * Validates a password reset token
 */
export async function validatePasswordResetToken(token: string) {
  const record = await prisma.passwordResetToken.findUnique({
    where: { token },
  });

  if (!record || record.used || record.expiresAt < new Date()) {
    return null;
  }

  return record;
}

/**
 * Extracts and validates the authenticated user from a Next.js Request or Next.js Cookies
 */
export async function getAuthenticatedUser(request?: Request): Promise<AuthenticatedUser | null> {
  try {
    let token: string | undefined;

    if (request) {
      // 1. Check Cookie header
      const cookieHeader = request.headers.get('cookie');
      if (cookieHeader) {
        const cookies = Object.fromEntries(
          cookieHeader.split(';').map((c) => {
            const [k, ...v] = c.trim().split('=');
            return [k, decodeURIComponent(v.join('='))];
          })
        );
        token = cookies[SESSION_COOKIE_NAME];
      }

      // 2. Check Authorization header
      if (!token) {
        const authHeader = request.headers.get('authorization');
        if (authHeader?.startsWith('Bearer ')) {
          token = authHeader.substring(7);
        }
      }
    }

    if (!token) {
      return null;
    }

    const payload = verifyToken(token);
    if (!payload?.userId) {
      return null;
    }

    // Fetch user with practitioner profile
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: {
        practitionerProfile: true,
      },
    });

    if (!user) {
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      practitionerProfile: user.practitionerProfile,
    };
  } catch (error) {
    console.error('Error authenticating user:', error);
    return null;
  }
}
