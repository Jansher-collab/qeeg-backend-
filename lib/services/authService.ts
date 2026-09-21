import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { prisma } from '../prisma';
import { UserRole } from '@prisma/client';

const JWT_SECRET = process.env.JWT_SECRET || 'qeeg-sydney-secure-jwt-secret-2026-production';
const SESSION_COOKIE_NAME = 'qeeg_session_token';

export interface TokenPayload {
  userId: string;
  email: string;
  role: UserRole;
  tokenVersion: number;
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
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "24h" });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch (error) {
    return null;
  }
}

/**
 * Session revocation: increment the user's tokenVersion so all previously
 * issued JWTs become invalid at the next authenticated check. Called on
 * logout, password change, and 2FA disable (revoke-all-devices style).
 */
export async function revokeUserSessions(userId: string): Promise<number> {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
  });
  return updated.tokenVersion;
}

/**
 * Returns true if a token's embedded tokenVersion matches the live DB value.
 * A mismatch means the session has been revoked server-side.
 */
export async function isTokenVersionCurrent(
  payload: TokenPayload | null,
  userVersion: number
): Promise<boolean> {
  return !!payload && typeof payload.tokenVersion === 'number' && payload.tokenVersion === userVersion;
}

/**
 * Generates a signed, report-specific collection token for one-click,
 * authenticated access to a report download (used in practitioner emails).
 * The token is bound to a single report and expires after 24 hours.
 */
export function generateReportCollectionToken(reportId: string): string {
  return jwt.sign(
    { type: 'report_collection', reportId },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

/**
 * Validates a report collection token. Returns the bound reportId if valid,
 * otherwise null (expired, malformed, or wrong payload).
 */
export function verifyReportCollectionToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as {
      type?: string;
      reportId?: string;
    };
    if (payload.type === 'report_collection' && payload.reportId) {
      return payload.reportId;
    }
    return null;
  } catch (error) {
    return null;
  }
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE_NAME;
}

export function getSessionCookieOptions() {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    secure: isProduction, // Secure cookies in production (HTTPS only)
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours (Express expects milliseconds)
  };
}

// ----------------------------------------------------
// TOTP 2FA (Google Authenticator compatible)
// ----------------------------------------------------

const TOTP_ISSUER = 'QEEG.com.au';
const TOTP_TOLERANCE_SECONDS = 30; // ±1 time-step for clock drift

export function createTOTPSecret(): string {
  return generateSecret();
}

export function generateTOTPAuthURL(email: string, secret: string): string {
  return generateURI({ issuer: TOTP_ISSUER, label: email, secret });
}

export function verifyTOTPCode(secret: string, code: string): boolean {
  if (!/^\d{6}$/.test(code.trim())) return false;
  try {
    const result = verifySync({
      secret,
      token: code.trim(),
      epochTolerance: TOTP_TOLERANCE_SECONDS,
    });
    return result.valid;
  } catch {
    return false;
  }
}

/**
 * Generates 10 single-use backup codes, hashed with bcrypt before storage.
 * Returns the plaintext codes exactly once for display.
 */
export async function generateBackupCodes(userId: string): Promise<string[]> {
  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    codes.push(crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})(.{5})/, '$1-$2'));
  }
  const hashed = await Promise.all(codes.map((c) => hashPassword(c.replace(/-/g, ''))));

  // Replace any existing codes for this user.
  await prisma.twoFactorBackupCode.deleteMany({ where: { userId } });
  await prisma.twoFactorBackupCode.createMany({
    data: hashed.map((codeHash) => ({ userId, codeHash })),
  });

  return codes;
}

/**
 * Validates a backup code, marking it used on success. Returns true if valid.
 */
export async function verifyAndConsumeBackupCode(userId: string, code: string): Promise<boolean> {
  const normalized = code.replace(/-/g, '').trim().toUpperCase();
  const candidates = await prisma.twoFactorBackupCode.findMany({
    where: { userId, used: false },
  });
  for (const candidate of candidates) {
    if (await verifyPassword(normalized, candidate.codeHash)) {
      await prisma.twoFactorBackupCode.update({
        where: { id: candidate.id },
        data: { used: true, usedAt: new Date() },
      });
      return true;
    }
  }
  return false;
}

export async function countUnusedBackupCodes(userId: string): Promise<number> {
  return prisma.twoFactorBackupCode.count({ where: { userId, used: false } });
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
