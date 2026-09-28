import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import fs from 'fs/promises';
import { prisma } from './lib/prisma';
import {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  createPasswordResetToken,
  validatePasswordResetToken,
  getSessionCookieName,
  getSessionCookieOptions,
  verifyReportCollectionToken,
  revokeUserSessions,
  isTokenVersionCurrent,
  createTOTPSecret,
  generateTOTPAuthURL,
  verifyTOTPCode,
  generateBackupCodes,
  verifyAndConsumeBackupCode,
  countUnusedBackupCodes,
} from './lib/services/authService';
import {
  stagePendingRegistration,
  completePendingRegistration,
  createPractitionerAccount,
} from './lib/services/pendingRegistration';
import { authRateLimit, sensitiveAuthRateLimit, submitRateLimit } from './lib/services/rateLimit';
import { verifyIngestionPayload } from './lib/services/reliabilityParser';
import { verifyTovaData } from './lib/services/tovaValidator';
import { generateCaseReference, normalizeCaseReference, isCaseReferenceConflict } from './lib/services/caseReference';
import { validateEnvironment, reportEnvironmentIssues } from './lib/config/env';
import { getPublicBaseUrl, getPublicUrl } from './lib/config/publicUrl';
import {
  authorisePayment,
  authorizePayPalOrder,
  createPayPalOrder,
  voidPayment,
  getReportFeeAUD,
  setReportFeeAUD,
  logPayPalCredentialSource,
} from './lib/services/paypalService';
import { executePurgeOnDownload } from './lib/services/purgeService';
import {
  sendPasswordResetEmail,
  sendPasswordResetConfirmationEmail,
  sendLoginAlertEmail,
  sendAdminRejectionNotification,
  sendAdminApprovalNotification,
  sendRetentionUpdateNotification,
  sendWelcomeEmail,
  checkEmailConnectivity,
} from './lib/services/emailService';
import { generatePreFilledChecklistPDF } from './lib/services/pdfService';
import { loadChecklistDefinition } from './lib/services/checklistDefinition';
import { scheduleBackstopPurge } from './lib/services/backstopPurge';
import { scheduleReportReminders } from './lib/services/reportReminderService';
import { logActivity } from './lib/services/activityLogger';
import { enqueueJob, JOB_TYPES } from './lib/services/jobQueue';
import { processReportGeneration, processReportVoid } from './lib/services/reportProcessor';
import { withTimeout } from './lib/services/timeout';
import {
  LEGAL_DOCUMENT_TYPES,
  getCurrentLegalDocuments,
  listLegalDocuments,
  findLegalDocumentPdf,
  replaceLegalDocument,
  MAX_LEGAL_DOCUMENT_BYTES,
} from './lib/services/legalDocumentService';
import {
  getReportRetentionDays,
  setReportRetentionDays,
  MIN_REPORT_RETENTION_DAYS,
  MAX_REPORT_RETENTION_DAYS,
} from './lib/services/settingsService';
import {
  MAX_KNOWLEDGE_PDF_BYTES,
  MAX_KNOWLEDGE_PDF_BATCH,
  createSourcePdfFromUpload,
  ingestSourcePdf,
  listKnowledgeSourcePdfs,
  findKnowledgeSourcePdfPdf,
  listLiteratureEntries,
  retractKnowledgeSourcePdf,
} from './lib/services/knowledgeIngestionService';
import { UserRole } from '@prisma/client';

const app = express();
// Fixed-hop trust proxy: `true` is rejected by express-rate-limit v8 as
// permissive (ERR_ERL_PERMISSIVE_TRUST_PROXY). A single reverse-proxy hop
// (e.g. nginx on the Sydney VPS) is the supported deployment shape.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// 1. Core Middlewares
app.use(
  cors({
    origin: [
      FRONTEND_URL,
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:3001',
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
  })
);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

// 2. Session Configuration (Australian Data Sovereignty: Local Session State)
// Note: express-session is retained for connect-pg-simple compatibility, but
// application auth uses the HttpOnly JWT cookie set via getSessionCookieOptions.
// The `secure` flag is production-gated to require HTTPS.
app.use(
  session({
    secret: process.env.JWT_SECRET || 'qeeg-sydney-secure-jwt-secret-2026-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// 3. Auth Helper Middleware
async function authenticateUser(req: Request, res: Response, next: NextFunction) {
  try {
    const token =
      req.cookies[getSessionCookieName()] ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.substring(7)
        : undefined);

    if (!token) {
      return res.status(401).json({ error: 'Authentication required. Please log in.' });
    }

    const payload = verifyToken(token);
    if (!payload?.userId) {
      return res.status(401).json({ error: 'Invalid or expired session token.' });
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { practitionerProfile: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'User account not found.' });
    }

    // Server-side session revocation: if the token's embedded tokenVersion
    // does not match the live DB value, the session was revoked (logout,
    // password change, 2FA disable) and must be rejected.
    if (!(await isTokenVersionCurrent(payload, user.tokenVersion))) {
      return res.status(401).json({
        error: 'Session has expired. Please log in again.',
        code: 'SESSION_REVOKED',
      });
    }

    (req as any).user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Authentication failed.' });
  }
}

async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;
  if (!user || user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Forbidden. Admin access required.' });
  }
  next();
}

// Destroys the session by expiring the HttpOnly cookie using the same
// attributes it was issued with (path, secure, sameSite) so it is reliably
// cleared in both development and production.
function clearSessionCookie(res: Response) {
  const opts = getSessionCookieOptions();
  res.clearCookie(opts.name, {
    path: '/',
    secure: opts.secure,
    sameSite: opts.sameSite,
    httpOnly: opts.httpOnly,
  });
}

// ----------------------------------------------------
// Health Check & Root
// ----------------------------------------------------
app.get('/health', async (req: Request, res: Response) => {
  try {
    let dbStatus = 'connected';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'disconnected';
    }

    res.json({
      status: 'healthy',
      server: 'QEEG.com.au Backend VPS',
      region: 'ap-southeast-2 (Sydney)',
      timestamp: new Date().toISOString(),
      database: dbStatus,
      port: PORT,
    });
  } catch (err: any) {
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

app.get('/', (req: Request, res: Response) => {
  res.json({
    name: 'QEEG.com.au Sovereign Backend API',
    region: 'ap-southeast-2 (Sydney, Australia)',
    version: '1.0.0',
    documentation: 'https://qeeg.com.au/the-science',
  });
});

// ----------------------------------------------------
// 1. Authentication Routes
// ----------------------------------------------------
app.post('/api/auth/signup', authRateLimit, async (req: Request, res: Response) => {
  try {
    const {
      email,
      password,
      fullName,
      professionalTitle,
      professionType,
      profession,
      providerNumber,
      practiceName,
      clinicName,
      practiceAddress,
      practicePhone,
      phone,
      practiceEmail,
      notificationEmail,
      role = 'PRACTITIONER',
      legalAcceptances,
      timeZone,
    } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    if (existingUser) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await hashPassword(password);
    const assignedRole = role === 'NEUROSCIENTIST' ? UserRole.NEUROSCIENTIST : UserRole.PRACTITIONER;

    const newUser = await createPractitionerAccount({
      email: email.toLowerCase().trim(),
      passwordHash,
      role: assignedRole,
      fullName,
      professionalTitle,
      professionType,
      profession,
      providerNumber,
      practiceName,
      clinicName,
      practiceAddress,
      practicePhone,
      phone,
      practiceEmail,
      notificationEmail,
      legalAcceptances: Array.isArray(legalAcceptances) ? legalAcceptances : [],
    });

    await logActivity({
      userId: newUser.id,
      action: 'PRACTITIONER_REGISTERED',
      details: { role: newUser.role, clinicName: newUser.practitionerProfile?.clinicName },
      ipAddress: req.ip || '127.0.0.1',
    });

    console.log('\n======================================================');
    console.log(`[PostgreSQL DB] 👤 User Registered: ${newUser.email} (ID: ${newUser.id})`);
    console.log(`[PostgreSQL DB] 🏥 Profile Linked: ${newUser.practitionerProfile?.fullName || 'N/A'} - ${newUser.practitionerProfile?.clinicName || 'N/A'}`);
    console.log('======================================================\n');

    // Send Welcome Email best-effort: an SMTP failure/timeout must never
    // block or fail the signup response, but the failure is logged clearly.
    sendWelcomeEmail(
      newUser.email,
      newUser.practitionerProfile?.fullName || newUser.email,
      req.ip || '127.0.0.1',
      req.body.timeZone
    )
      .then((emailResult) => {
        if (!emailResult.success) {
          console.error(
            `[AuthEmail] Welcome email FAILED for ${newUser.email}: ${emailResult.error || 'unknown SMTP error'}`
          );
        }
      })
      .catch((e) => console.error('Failed to send welcome email:', e));

    res.status(201).json({
      message: 'Account created successfully. Please log in.',
      user: {
        id: newUser.id,
        email: newUser.email,
        role: newUser.role,
        twoFactorEnabled: newUser.totpEnabled,
        practitionerProfile: newUser.practitionerProfile,
      },
    });
  } catch (error: any) {
    console.error('[PostgreSQL DB ERROR] Signup error:', error);
    res.status(500).json({ error: error.message || 'Failed to create account.' });
  }
});

// Alias for /api/auth/register
app.post('/api/auth/register', async (req: Request, res: Response) => {
  // Re-route to signup handler
  const signupHandler = app._router.stack.find((layer: any) => layer.route?.path === '/api/auth/signup');
  if (signupHandler) {
    return signupHandler.handle(req, res);
  }
  res.status(404).json({ error: 'Endpoint not found.' });
});

// ----------------------------------------------------
// Deferred signup (mandatory 2FA before an account exists)
// ----------------------------------------------------

/**
 * Step 1 of practitioner registration.
 *
 * Validates the submitted details, hashes the password and mints a TOTP
 * secret, but deliberately does NOT create any database record. The caller
 * receives an otpauth URL (rendered as a QR code) plus an opaque pendingId.
 */
app.post('/api/auth/signup/pending', authRateLimit, async (req: Request, res: Response) => {
  try {
    const result = await stagePendingRegistration(req.body || {});

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    res.status(200).json({
      message:
        'Details received. Scan the QR code with your authenticator app to finish creating your account.',
      pendingId: result.pendingId,
      otpauthUrl: result.otpauthUrl,
      email: result.email,
      expiresInSeconds: result.expiresInSeconds,
    });
  } catch (error: any) {
    console.error('[Auth] Failed to stage pending registration:', error);
    res.status(500).json({ error: 'Could not start registration. Please try again.' });
  }
});

/**
 * Step 2 of practitioner registration.
 *
 * Verifies the TOTP code and — only on success — atomically creates the user,
 * practitioner profile, legal acceptances, the enabled 2FA secret and the 10
 * backup codes, then issues a session so the practitioner lands straight in
 * the portal. A wrong/expired code creates nothing.
 */
app.post('/api/auth/signup/complete', sensitiveAuthRateLimit, async (req: Request, res: Response) => {
  try {
    const { pendingId, totpCode, timeZone } = req.body || {};

    const result = await completePendingRegistration({ pendingId, totpCode });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, restartRequired: result.discard });
    }

    const newUser = result.user;

    await logActivity({
      userId: newUser.id,
      action: 'PRACTITIONER_REGISTERED',
      details: { role: newUser.role, clinicName: newUser.practitionerProfile?.clinicName },
      ipAddress: req.ip || '127.0.0.1',
    });

    console.log('\n======================================================');
    console.log(`[PostgreSQL DB] 👤 User Registered (2FA verified): ${newUser.email} (ID: ${newUser.id})`);
    console.log(`[PostgreSQL DB] 🏥 Profile Linked: ${newUser.practitionerProfile?.fullName || 'N/A'} - ${newUser.practitionerProfile?.clinicName || 'N/A'}`);
    console.log(`[PostgreSQL DB] 🔐 2FA enabled, ${result.backupCodes.length} backup codes issued`);
    console.log('======================================================\n');

    // Send Welcome Email best-effort: an SMTP failure/timeout must never
    // block or fail the signup response, but the failure is logged clearly.
    sendWelcomeEmail(
      newUser.email,
      newUser.practitionerProfile?.fullName || newUser.email,
      req.ip || '127.0.0.1',
      req.body.timeZone
    )
      .then((emailResult) => {
        if (!emailResult.success) {
          console.error(
            `[AuthEmail] Welcome email FAILED for ${newUser.email}: ${emailResult.error || 'unknown SMTP error'}`
          );
        }
      })
      .catch((e) => console.error('Failed to send welcome email:', e));

    // 2FA is already active, so no challenge code is needed here: issue the
    // session directly and hand the user their one-time backup codes.
    const token = generateToken({
      userId: newUser.id,
      email: newUser.email,
      role: newUser.role,
      tokenVersion: newUser.tokenVersion,
    });

    const cookieOpts = getSessionCookieOptions();
    res.cookie(cookieOpts.name, token, cookieOpts);

    res.status(201).json({
      message: 'Account created. Two-factor authentication is active.',
      user: {
        id: newUser.id,
        email: newUser.email,
        role: newUser.role,
        twoFactorEnabled: true,
        practitionerProfile: newUser.practitionerProfile,
      },
      backupCodes: result.backupCodes,
    });
  } catch (error: any) {
    console.error('[PostgreSQL DB ERROR] Signup completion error:', error);
    res.status(500).json({ error: error.message || 'Failed to create account.' });
  }
});

app.post('/api/auth/login', authRateLimit, async (req: Request, res: Response) => {
  try {
    const { email, password, totpCode, timeZone } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: { practitionerProfile: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // TOTP 2FA challenge: if the account has 2FA enabled, require a valid
    // one-time code (or backup code) before issuing a session token.
    if (user.totpEnabled) {
      if (!totpCode) {
        return res.status(428).json({
          error: 'Two-factor authentication is required for this account.',
          code: 'TOTP_REQUIRED',
        });
      }
      const submittedCode = String(totpCode).trim();
      // TOTP codes are exactly 6 digits; backup codes are alphanumeric and
      // hyphenated (e.g. F699A-53903). Try TOTP first when the input looks
      // like a TOTP code, then always fall back to a single-use backup code
      // so both code types can authenticate the user.
      const looksLikeTotpCode = /^\d{6}$/.test(submittedCode);
      let codeOk = false;
      if (user.totpSecret && looksLikeTotpCode) {
        codeOk = verifyTOTPCode(user.totpSecret, submittedCode);
      }
      if (!codeOk) {
        codeOk = await verifyAndConsumeBackupCode(user.id, submittedCode);
      }
      if (!codeOk) {
        return res.status(401).json({ error: 'Invalid two-factor authentication code.' });
      }
    }

    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });

    const cookieOpts = getSessionCookieOptions();
    res.cookie(cookieOpts.name, token, cookieOpts);

    await logActivity({
      userId: user.id,
      action: 'USER_LOGGED_IN',
      details: { role: user.role, twoFactorEnabled: user.totpEnabled },
      ipAddress: req.ip || '127.0.0.1',
    });

    // Login alert email is best-effort and must never block the auth response;
    // delivery failures are logged but the session proceeds regardless.
    // The login instant is captured here so the email reports when the login
    // actually occurred rather than whenever Postmark managed to deliver.
    const loginOccurredAt = new Date();
    sendLoginAlertEmail(
      user.email,
      user.practitionerProfile?.fullName || user.email,
      req.ip || '127.0.0.1',
      loginOccurredAt,
      timeZone
    )
      .then((emailResult) => {
        if (!emailResult.success) {
          console.error(
            `[AuthEmail] Login alert email FAILED for ${user.email}: ${emailResult.error || 'unknown SMTP error'}`
          );
        }
      })
      .catch((e) => console.error('Failed to send login alert email:', e));

    res.json({
      message: 'Logged in successfully.',
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        twoFactorEnabled: user.totpEnabled,
        practitionerProfile: user.practitionerProfile,
      },
    });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message || 'Login failed.' });
  }
});

app.get('/api/auth/me', authenticateUser, (req: Request, res: Response) => {
  const user = (req as any).user;
  res.json({
    authenticated: true,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      twoFactorEnabled: user.totpEnabled,
      practitionerProfile: user.practitionerProfile,
    },
  });
});

app.post('/api/auth/logout', authenticateUser, async (req: Request, res: Response) => {
  try {
    // Revoke all sessions server-side: increment tokenVersion so every
    // previously issued JWT for this user is immediately invalidated.
    const user = (req as any).user;
    await revokeUserSessions(user.id);

    await logActivity({
      userId: user.id,
      action: 'USER_LOGOUT',
      details: { revokedServerSide: true },
      ipAddress: req.ip || '127.0.0.1',
    });

    clearSessionCookie(res);
    res.json({ message: 'Logged out successfully.' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Logout failed.' });
  }
});

app.post('/api/auth/logout-all', authenticateUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    await revokeUserSessions(user.id);
    clearSessionCookie(res);
    res.json({ message: 'All sessions revoked successfully.' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Logout failed.' });
  }
});

// ----------------------------------------------------
// TOTP Two-Factor Authentication (Google Authenticator)
// ----------------------------------------------------

// 1. Start enrollment: generate a secret + otpauth URL to scan.
app.post('/api/auth/2fa/setup', authenticateUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (user.totpEnabled) {
      return res.status(400).json({ error: 'Two-factor authentication is already enabled.' });
    }
    const secret = createTOTPSecret();
    // Persist the pending secret so the confirm step can validate against it.
    await prisma.user.update({ where: { id: user.id }, data: { totpSecret: secret } });

    res.json({
      secret,
      otpauthUrl: generateTOTPAuthURL(user.email, secret),
      issuer: 'QEEG.com.au',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to start 2FA setup.' });
  }
});

// 2. Confirm enrollment with a valid TOTP code; issue backup codes.
app.post('/api/auth/2fa/confirm', authenticateUser, sensitiveAuthRateLimit, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { totpCode } = req.body;
    if (!totpCode) {
      return res.status(400).json({ error: 'Verification code is required.' });
    }
    if (!user.totpSecret) {
      return res.status(400).json({ error: 'No pending 2FA enrollment found.' });
    }
    if (!verifyTOTPCode(user.totpSecret, String(totpCode))) {
      return res.status(401).json({ error: 'Invalid verification code.' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { totpEnabled: true },
    });

    const backupCodes = await generateBackupCodes(user.id);

    await logActivity({
      userId: user.id,
      action: 'TWO_FACTOR_ENABLED',
      ipAddress: req.ip || '127.0.0.1',
    });

    res.json({
      message: 'Two-factor authentication enabled.',
      backupCodes, // shown exactly once
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to enable 2FA.' });
  }
});

// 3. Disable 2FA (requires password + current TOTP/backup code).
app.post('/api/auth/2fa/disable', authenticateUser, sensitiveAuthRateLimit, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { password, totpCode } = req.body;
    if (!user.totpEnabled) {
      return res.status(400).json({ error: 'Two-factor authentication is not enabled.' });
    }
    if (!password) {
      return res.status(400).json({ error: 'Password is required to disable 2FA.' });
    }
    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid password.' });
    }
    if (user.totpSecret) {
      if (!totpCode || !verifyTOTPCode(user.totpSecret, String(totpCode))) {
        return res.status(401).json({ error: 'Invalid two-factor authentication code.' });
      }
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { totpEnabled: false, totpSecret: null },
    });
    await prisma.twoFactorBackupCode.deleteMany({ where: { userId: user.id } });
    // Invalidates all outstanding sessions for this user.
    await revokeUserSessions(user.id);

    await logActivity({
      userId: user.id,
      action: 'TWO_FACTOR_DISABLED',
      ipAddress: req.ip || '127.0.0.1',
    });

    clearSessionCookie(res);
    res.json({ message: 'Two-factor authentication disabled.' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to disable 2FA.' });
  }
});

// 4. Regenerate backup codes (requires current TOTP code).
app.post('/api/auth/2fa/backup-codes', authenticateUser, sensitiveAuthRateLimit, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { totpCode } = req.body;
    if (!user.totpEnabled) {
      return res.status(400).json({ error: 'Two-factor authentication is not enabled.' });
    }
    if (!user.totpSecret || !verifyTOTPCode(user.totpSecret, String(totpCode || ''))) {
      return res.status(401).json({ error: 'Invalid two-factor authentication code.' });
    }
    const backupCodes = await generateBackupCodes(user.id);
    res.json({ backupCodes });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to regenerate backup codes.' });
  }
});

// 5. Status check for the account page.
app.get('/api/auth/2fa/status', authenticateUser, async (req: Request, res: Response) => {
  const user = (req as any).user;
  const backupCodesRemaining = await countUnusedBackupCodes(user.id);
  res.json({
    twoFactorEnabled: user.totpEnabled,
    backupCodesRemaining,
  });
});

app.post('/api/auth/forgot-password', sensitiveAuthRateLimit, async (req: Request, res: Response) => {
  try {
    const { email, timeZone } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!user) {
      // Return success even if user not found to prevent email enumeration
      return res.json({ message: 'If an account exists, a reset link has been sent.' });
    }

    const token = await createPasswordResetToken(user.email);
    // Emailed to the user, so use the public HTTPS domain rather than the
    // CORS origin in FRONTEND_URL (localhost:3000 / VPS :3000 in production).
    const resetUrl = getPublicUrl(`/reset-password?token=${token}`);

    // Send the reset link best-effort: never await SMTP (a slow/hung mail
    // server must not delay the auth response) and never fail the request on
    // a send error. Failures are logged clearly for ops follow-up and the
    // generic anti-enumeration message is always returned.
    sendPasswordResetEmail(user.email, resetUrl, timeZone)
      .then((emailResult) => {
        if (!emailResult.success) {
          console.error(
            `[AuthEmail] Password-reset email FAILED for ${user.email}: ${emailResult.error || 'unknown SMTP error'}`
          );
        }
      })
      .catch((e) => console.error('Failed to send password reset email:', e));

    res.json({ message: 'If an account exists, a reset link has been sent.' });
  } catch (error: any) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

app.post('/api/auth/reset-password', sensitiveAuthRateLimit, async (req: Request, res: Response) => {
  try {
    const { token, newPassword, timeZone } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }

    const record = await validatePasswordResetToken(token);
    if (!record) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const passwordHash = await hashPassword(newPassword);

    await prisma.user.update({
      where: { email: record.email },
      data: { passwordHash, tokenVersion: { increment: 1 } }, // revoke all sessions
    });

    await prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { used: true },
    });

    const user = await prisma.user.findUnique({
      where: { email: record.email },
      include: { practitionerProfile: true },
    });

    if (user) {
      // Confirm best-effort and non-blocking: the reset has already been
      // applied above; a confirmation-email failure must not fail the request.
sendPasswordResetConfirmationEmail(
  user.email,
  user.practitionerProfile?.fullName || user.email,
  timeZone
  )
        .then((emailResult) => {
          if (!emailResult.success) {
            console.error(
              `[AuthEmail] Password-change confirmation email FAILED for ${user.email}: ${emailResult.error || 'unknown SMTP error'}`
            );
          }
        })
        .catch((e) => console.error('Failed to send reset confirmation email:', e));
    }

    res.json({ message: 'Password has been successfully reset.' });
  } catch (error: any) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ----------------------------------------------------
// 2. Checklist Download Route (Personalized AcroForm PDF)
// ----------------------------------------------------
app.get('/api/checklist/download', authenticateUser, async (req: Request, res: Response) => {
  try {
    let practitioner = {
      fullName: 'Registered Referring Practitioner',
      professionalTitle: '',
      profession: 'Clinical Practitioner',
      providerNumber: 'N/A',
      clinicName: 'Clinical Practice',
      practiceAddress: 'Australia',
      phone: '',
      practiceEmail: '',
    };

    // Resolve authenticated practitioner from session token or latest database record
    const token =
      req.cookies[getSessionCookieName()] ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.substring(7)
        : undefined);

    let user = null;
    if (token) {
      const payload = verifyToken(token);
      if (payload?.userId) {
        user = await prisma.user.findUnique({
          where: { id: payload.userId },
          include: { practitionerProfile: true },
        });
      }
    }

    if (user?.practitionerProfile) {
      const prof = user.practitionerProfile;
      practitioner = {
        fullName: prof.fullName || 'Registered Referring Practitioner',
        professionalTitle: prof.professionalTitle || '',
        profession: prof.profession || 'Clinical Practitioner',
        providerNumber: prof.providerNumber || 'N/A',
        clinicName: prof.clinicName || 'Clinical Practice',
        practiceAddress: prof.practiceAddress || 'Australia',
        phone: prof.phone || '',
        practiceEmail: user.email,
      };
    }

    console.log(`[Checklist PDF] Generating pre-filled PDF for practitioner: ${practitioner.fullName} (${practitioner.clinicName})`);
    const pdfBuffer = await generatePreFilledChecklistPDF(practitioner);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="QEEG_Symptom_Checklist.pdf"');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.send(Buffer.from(pdfBuffer));
  } catch (error: any) {
    console.error('Checklist PDF generation error:', error);
    res.status(500).json({ error: 'Failed to generate symptom checklist PDF.' });
  }
});

// Config-driven Symptom Checklist definition (the single source of truth for
// BOTH the printable AcroForm PDF and the portal's live submission form).
// Section 3.2a: the portal renders its form straight from this config so the
// two always stay in sync without a frontend redeploy.
app.get('/api/checklist-config', authenticateUser, (req: Request, res: Response) => {
  try {
    res.json({ config: loadChecklistDefinition() });
  } catch (error: any) {
    console.error('Checklist config error:', error);
    res.status(500).json({ error: error.message || 'Failed to load checklist config.' });
  }
});

// ----------------------------------------------------
// 2a. Legal Acceptance (DPA / EULA) - Spec 3.1c & 3.1d
// ----------------------------------------------------
const LEGAL_ACCEPTANCE_TYPES = LEGAL_DOCUMENT_TYPES;

app.get('/api/legal/status', authenticateUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const accepted = await prisma.legalAcceptance.findMany({
      where: { userId: user.id },
      select: { acceptanceType: true, version: true, acceptedAt: true },
      orderBy: { acceptedAt: 'desc' },
    });
    const acceptedTypes = new Set(accepted.map((a) => a.acceptanceType));
    res.json({
      pending: LEGAL_ACCEPTANCE_TYPES.filter((t) => !acceptedTypes.has(t)),
      accepted,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load legal acceptance status.' });
  }
});

app.post('/api/legal/accept', authenticateUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { acceptanceType, version } = req.body;

    if (!acceptanceType || !(LEGAL_ACCEPTANCE_TYPES as readonly string[]).includes(String(acceptanceType))) {
      return res.status(400).json({
        error: `acceptanceType must be one of: ${LEGAL_ACCEPTANCE_TYPES.join(', ')}.`,
      });
    }
    if (!version) {
      return res.status(400).json({ error: 'A document version is required.' });
    }

    const record = await prisma.legalAcceptance.upsert({
      where: {
        userId_acceptanceType: {
          userId: user.id,
          acceptanceType: String(acceptanceType),
        },
      },
      update: { version: String(version), acceptedAt: new Date() },
      create: {
        userId: user.id,
        acceptanceType: String(acceptanceType),
        version: String(version),
        acceptedAt: new Date(),
      },
    });

    await logActivity({
      userId: user.id,
      action: `LEGAL_ACCEPTED_${record.acceptanceType}`,
      details: { version: record.version },
      ipAddress: req.ip || '127.0.0.1',
    });

    res.json({ message: 'Acceptance recorded.', acceptanceType: record.acceptanceType, version: record.version });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to record acceptance.' });
  }
});

// ----------------------------------------------------
// 2b. Dynamic Legal Documents (Admin-managed DPA / EULA)
// ----------------------------------------------------
// Public endpoints: the signup page (pre-authentication) renders the current
// document metadata and embeds the active PDF so new practitioners always see
// whatever version the admin panel currently has published — no code change.
app.get('/api/legal/current', async (req: Request, res: Response) => {
  try {
    const documents = await getCurrentLegalDocuments();
    res.json({ documents });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load legal documents.' });
  }
});

// Streams the active (or, via ?v=, a specific) legal PDF directly from disk.
app.get('/api/legal/documents/pdf/:type', async (req: Request, res: Response) => {
  try {
    const { type } = req.params;
    const version = typeof req.query.v === 'string' ? req.query.v : undefined;
    const doc = await findLegalDocumentPdf({ documentType: String(type), version });
    if (!doc) {
      return res.status(404).json({ error: 'Legal document not found.' });
    }
    const data = await fs.readFile(doc.filePath);
    res.setHeader('Content-Type', doc.contentType || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.fileName}"`);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Legal-Document-Version', doc.version);
    res.send(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to serve legal document.' });
  }
});

// ----------------------------------------------------
// 3. Practitioner Reports & Profile
// ----------------------------------------------------
app.get('/api/practitioner/reports', authenticateUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const reports = await prisma.qeeqReport.findMany({
      where: { submittingPractitionerId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ reports });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch reports.' });
  }
});
  // Dedicated billing history endpoint: returns all reports with payment activity
  // for the authenticated practitioner, ensuring financial records are visible
  // even after clinical data purge (DOWNLOADED_AND_PURGED).
  app.get('/api/practitioner/billing', authenticateUser, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const reports = await prisma.qeeqReport.findMany({
        where: {
          submittingPractitionerId: user.id,
          paymentStatus: { not: 'NOT_STARTED' },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          caseReference: true,
          status: true,
          feeAmount: true,
          paymentStatus: true,
          paypalAuthorizationId: true,
          paypalCaptureId: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      res.json({ reports });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to fetch billing history.' });
    }
  });

  app.get('/api/practitioner/profile', authenticateUser, (req: Request, res: Response) => {
    const user = (req as any).user;
    res.json({ profile: user.practitionerProfile });
  });

app.put('/api/practitioner/profile', authenticateUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const body = req.body;

    const updatedProfile = await prisma.practitionerProfile.upsert({
      where: { userId: user.id },
      update: {
        fullName: body.fullName,
        professionalTitle: body.professionalTitle,
        profession: body.profession,
        providerNumber: body.providerNumber,
        clinicName: body.clinicName,
        practiceAddress: body.practiceAddress,
        phone: body.phone,
        practiceEmail: body.practiceEmail,
        notificationEmail: body.notificationEmail,
      },
      create: {
        userId: user.id,
        fullName: body.fullName,
        professionalTitle: body.professionalTitle,
        profession: body.profession,
        providerNumber: body.providerNumber,
        clinicName: body.clinicName,
        practiceAddress: body.practiceAddress,
        phone: body.phone,
        practiceEmail: body.practiceEmail,
        notificationEmail: body.notificationEmail,
      },
    });

    res.json({ message: 'Profile updated successfully.', profile: updatedProfile });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update profile.' });
  }
});

// ----------------------------------------------------
// 4a. PayPal Order Creation — server-side source of truth
// ----------------------------------------------------
// The frontend's PayPalButtons.createOrder calls this endpoint to obtain a
// BRAND-NEW order on every payment attempt/retry. Keeping order creation on the
// backend guarantees a stale/expired order id is never reused — re-authorising
// a used order yields PayPal INVALID_RESOURCE_ID. The approve flow in
// /api/reports/submit then authorizes the freshly-created order the caller
// just received.
app.post('/api/payments/orders', authenticateUser, submitRateLimit, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const caseReference =
      typeof req.body?.caseReference === 'string' && req.body.caseReference.trim()
        ? req.body.caseReference.trim()
        : undefined;

    if (!caseReference) {
      return res.status(400).json({ error: 'A caseReference is required to create a payment order.' });
    }

    const reportFee = await getReportFeeAUD();
    const created = await createPayPalOrder(caseReference, reportFee);

    if (!created.success || !created.orderId) {
      return res.status(400).json({
        error: `PayPal order creation failed: ${created.error || 'Unknown error.'}`,
        errorCode: 'PAYMENT_FAILED',
      });
    }

    console.info(
      `[payments/orders] Issued fresh PayPal order ${created.orderId} for case ${caseReference} (${created.amount} ${created.currency}, user ${user.id}).`
    );

    await logActivity({
      userId: user.id,
      caseReference,
      action: 'PAYPAL_ORDER_CREATED',
      details: { orderId: created.orderId, amount: created.amount },
      ipAddress: req.ip || '127.0.0.1',
    });

    res.json({ orderId: created.orderId, amount: created.amount, currency: created.currency });
  } catch (error: any) {
    console.error('Create PayPal order error:', error);
    res.status(500).json({ error: error.message || 'Failed to create payment order.' });
  }
});

// ----------------------------------------------------
// 4. Report Submission & Correlation Pipeline
// ----------------------------------------------------
app.post('/api/reports/submit', authenticateUser, submitRateLimit, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const payload = req.body;

    const reportFee = await getReportFeeAUD();
    let authId = payload.paypalAuthorizationId;

    // Preferred flow: the frontend hands over the approved (but not yet
    // authorised) order id so the SDK popup is never held open across our
    // backend round-trip. The authorize call happens server-side, before we
    // respond, so the frontend only closes the modal after authorisation is
    // confirmed at PayPal.
    if (!authId && payload.paypalOrderId) {
      const orderId: string =
        typeof payload.paypalOrderId === 'string' ? payload.paypalOrderId.trim() : '';
      console.info(
        `[submit] Authorising PayPal order ${orderId || '(empty)'} for case ${payload.caseReference ?? '(malformed)'} (user ${user.id}).`
      );
      if (!orderId) {
        return res.status(400).json({
          error: 'A valid PayPal order id is required to authorise payment.',
          errorCode: 'PAYMENT_FAILED',
        });
      }
      const authResult = await authorizePayPalOrder(orderId, {
        caseReference: typeof payload.caseReference === 'string' ? payload.caseReference.trim() : undefined,
      });
      if (!authResult.success) {
        console.error(`[submit] PayPal authorisation failed for order ${orderId}:`, authResult.error);
        return res.status(400).json({
          error: `PayPal authorisation failed: ${authResult.error || 'Unknown error.'}`,
          errorCode: 'PAYMENT_FAILED',
        });
      }
      if (authResult.idempotent) {
        console.info(
          `[submit] Idempotent authorisation for order ${orderId} → auth ${authResult.authorizationId} (case ${payload.caseReference ?? 'unknown'}).`
        );
      } else {
        console.info(
          `[submit] Authorisation succeeded for order ${orderId} → auth ${authResult.authorizationId}.`
        );
      }
      authId = authResult.authorizationId;
    }

    // Legacy fallback: fully server-side authorisation (dev/mock or order-less
    // path). Any real authorisation failure must block submission — it is
    // never silently replaced with a mock id.
    if (!authId) {
      const authResult = await authorisePayment(payload.caseReference, reportFee);
      if (!authResult.success || !authResult.authorizationId) {
        return res.status(400).json({
          error: `PayPal authorisation failed: ${authResult.error || 'Unable to authorise payment.'}`,
          errorCode: 'PAYMENT_FAILED',
        });
      }
      authId = authResult.authorizationId;
    }

    // 2. Server-Side Reliability & De-Identification Quality Gate
    const verification = verifyIngestionPayload(payload);
    if (!verification.passed) {
      // Trigger PayPal void/release if reliability gate fails
      if (authId && !authId.startsWith('AUTH-MOCK-')) {
        await voidPayment(authId);
      }
      return res.status(400).json({
        error: verification.rejectionReason || 'Reliability score below mandatory 0.80 threshold.',
        reliabilityScore: verification.reliabilityScore,
        threshold: 0.80,
      });
    }

    // 3. Server-Side TOVA Quality Gate. TOVA supporting-test data is a
    // mandatory part of the request (the client blocks the checklist step until
    // a TOVA file is uploaded and verified), so it is re-validated here
    // independently of the client. A missing or malformed payload is rejected
    // and the authorised payment is voided, exactly as for a reliability
    // failure, so an invalid submission can never be persisted.
    const tovaVerification = verifyTovaData(payload.tovaData);
    if (!tovaVerification.passed) {
      console.warn(
        `[Submit] Rejected case ${payload.caseReference ?? '(malformed)'} (user ${user.id}): ${tovaVerification.rejectionReason}`
      );
      if (authId && !authId.startsWith('AUTH-MOCK-')) {
        await voidPayment(authId);
      }
      return res.status(400).json({
        error: tovaVerification.rejectionReason || 'TOVA supporting-test data is required.',
        errorCode: tovaVerification.errorCode || 'TOVA_REQUIRED',
      });
    }

    // 4. Create Report in Database, then run the automated post-payment
    // pipeline (formerly the manual PENDING_ADMIN_APPROVAL gate). The report is
    // placed in PAYMENT_AUTHORISED (funds held at PayPal) and generation is
    // kicked off immediately — no admin intervention is required.
    //
    // The Case Reference is globally unique (it keys the per-case upload
    // directory). Prefer the client-generated reference; if it is malformed or
    // already taken, regenerate server-side and return the authoritative value.
    type CreatedReport = Awaited<ReturnType<typeof prisma.qeeqReport.create>>;
    let caseReference = normalizeCaseReference(payload.caseReference);
    let newReport: CreatedReport | undefined;
    // Snapshot the admin-configured global retention period onto this report at
    // creation time. Later global changes only affect newly created cases.
    const globalRetentionDays = await getReportRetentionDays();
    const MAX_CASE_REF_ATTEMPTS = 6;
    for (let attempt = 1; attempt <= MAX_CASE_REF_ATTEMPTS; attempt++) {
      if (!caseReference) caseReference = generateCaseReference();
      try {
        newReport = await prisma.qeeqReport.create({
          data: {
            caseReference,
            submittingPractitionerId: user.id,
            status: 'PAYMENT_AUTHORISED',
            customRetentionDays: globalRetentionDays,
            reliabilityScore: verification.reliabilityScore,
            age: payload.age ?? verification.age ?? null,
            gender: payload.gender ?? verification.gender ?? null,
            handedness: payload.handedness ?? verification.handedness ?? null,
            // TOVA is mandatory and already validated above, so it is always
            // persisted (deep-cloned to strip any prototype chain) rather than
            // being conditionally attached as optional data.
            tovaData: JSON.parse(JSON.stringify(payload.tovaData)),
            checklistData: payload.checklistData ? JSON.parse(JSON.stringify(payload.checklistData)) : undefined,
            feeAmount: reportFee,
            paypalAuthorizationId: authId,
            paymentStatus: 'AUTHORISED',
          },
        });
        break;
      } catch (error: any) {
        if (isCaseReferenceConflict(error) && attempt < MAX_CASE_REF_ATTEMPTS) {
          console.warn(
            `[Submit] Case reference ${caseReference} already in use; regenerating (attempt ${attempt}/${MAX_CASE_REF_ATTEMPTS}).`
          );
          caseReference = generateCaseReference();
          continue;
        }
        throw error;
      }
    }
    if (!newReport) {
      throw new Error('Failed to allocate a unique Case Reference after multiple attempts.');
    }

    await logActivity({
      reportId: newReport.id,
      caseReference: newReport.caseReference,
      userId: user.id,
      action: 'PAYMENT_AUTHORISED',
      details: {
        amount: reportFee,
        authorizationId: newReport.paypalAuthorizationId,
        customRetentionDays: globalRetentionDays,
      },
      ipAddress: req.ip || '127.0.0.1',
    });

    await logActivity({
      reportId: newReport.id,
      caseReference: newReport.caseReference,
      userId: user.id,
      action: 'AUTO_PIPELINE_STARTED',
      details: { status: 'PAYMENT_AUTHORISED', autoApproved: true },
      ipAddress: req.ip || '127.0.0.1',
    });

    // Automatic processing: capture + generate in-band (and via the durable
    // worker job) — the manual admin approval gate has been removed.
    const pipeline = await startReportProduction(newReport.id, user.id, globalRetentionDays);

    res.status(201).json({
      message:
        pipeline.status === 'COMPLETED'
          ? 'Payment authorised, funds held, and report generated automatically.'
          : 'Payment authorised and funds held; report generation is running.',
      reportId: newReport.id,
      caseReference: newReport.caseReference,
      status: pipeline.status,
      feeAmount: newReport.feeAmount,
      customRetentionDays: globalRetentionDays,
    });
  } catch (error: any) {
    console.error('Submit report error:', error);
    res.status(500).json({ error: error.message || 'Submission failed.' });
  }
});

// ----------------------------------------------------
// Shared automated post-payment pipeline. Replaces the manual admin approval
// step: enqueues the durable correlation/capture job, emails the practitioner
// that their payment holds are active, and runs generation in-band so a report
// is produced even when no separate worker process is deployed. Used by the
// auto-approved submit path and kept as the legacy admin-approve path.
// ----------------------------------------------------
async function startReportProduction(
  reportId: string,
  byUserId: string,
  retentionDays?: number | null
): Promise<{ status: string; jobId: string; reportFinal: Awaited<ReturnType<typeof prisma.qeeqReport.findUnique>> }> {
  const report = await prisma.qeeqReport.findUnique({ where: { id: reportId } });
  if (!report) throw new Error('Report not found.');

  const jobId = await enqueueJob(reportId, JOB_TYPES.CORRELATE_AND_CAPTURE);

  await logActivity({
    reportId,
    caseReference: report.caseReference,
    userId: byUserId,
    action: 'REPORT_GENERATION_QUEUED',
    details: { jobId, customRetentionDays: retentionDays ?? report.customRetentionDays ?? null },
    ipAddress: 'automation',
  });

  // Practitioner notification: funds are held and automatic generation began.
  try {
    const practitioner = await prisma.user.findUnique({
      where: { id: report.submittingPractitionerId },
      include: { practitionerProfile: true },
    });
    const recipient =
      practitioner?.practitionerProfile?.notificationEmail ||
      practitioner?.practitionerProfile?.practiceEmail ||
      practitioner?.email;
    if (recipient) {
      const approvalEmail = await sendAdminApprovalNotification(
        recipient,
        practitioner?.practitionerProfile?.fullName || 'Practitioner',
        report.caseReference,
        getPublicUrl('/portal')
      );
      if (approvalEmail.success) {
        console.log(
          `[Pipeline] Approval email sent for case ${report.caseReference} to ${recipient} (${approvalEmail.simulated ? 'simulated' : approvalEmail.messageId || 'sent'}).`
        );
      }
    }
  } catch (emailError) {
    console.error('Failed to send auto-pipeline notification email:', emailError);
  }

  let status: string;
  try {
    const completed = await processReportGeneration(reportId);
    status = completed ? 'COMPLETED' : 'PAYMENT_AUTHORISED';
  } catch (genError: any) {
    console.error('In-band report generation failed; durable worker job remains queued:', genError);
    status = 'PAYMENT_AUTHORISED';
  }

  let reportFinal: Awaited<ReturnType<typeof prisma.qeeqReport.findUnique>> = null;
  try {
    reportFinal = await prisma.qeeqReport.findUnique({ where: { id: reportId } });
  } catch {
    reportFinal = null;
  }
  if (reportFinal?.status && reportFinal.status !== 'GENERATING') {
    status = reportFinal.status;
  }

  return { status, jobId, reportFinal };
}

app.post('/api/reports/:id/generate', authenticateUser, async (req: Request, res: Response) => {
  try {
    const reportId = req.params.id as string;
    const report = await prisma.qeeqReport.findUnique({ where: { id: reportId } });

    if (!report) {
      return res.status(404).json({ error: 'Report not found.' });
    }

    // Ownership check: admins or the submitting practitioner may generate.
    const actor = (req as any).user;
    if (actor && actor.role !== 'ADMIN' && report.submittingPractitionerId !== actor.id) {
      return res.status(403).json({ error: 'Forbidden. You do not have access to this report.' });
    }

    if (report.status === 'COMPLETED') {
      return res.json({ message: 'Report is already compiled.', reportId: report.id });
    }

    if (report.status === 'GENERATING') {
      return res.status(202).json({
        message: 'Report generation is already in progress.',
        reportId: report.id,
        status: report.status,
      });
    }

    // Legacy-pending cases (created before automation) must route through the
    // admin approve endpoint; auto-approved (PAYMENT_AUTHORISED) cases pass
    // through so the durable job can always be (re-)queued.
    if (report.status === 'PENDING_ADMIN_APPROVAL') {
      return res.status(403).json({
        error: 'Report is awaiting admin approval and cannot be generated yet.',
        reportId: report.id,
        status: report.status,
      });
    }

    // Queue the heavy correlation + payment-capture work for the background
    // worker rather than blocking this request for the full pipeline.
    await prisma.qeeqReport.update({
      where: { id: reportId },
      data: { status: 'GENERATING' },
    });
    const jobId = await enqueueJob(reportId, JOB_TYPES.CORRELATE_AND_CAPTURE);

    await logActivity({
      reportId,
      caseReference: report.caseReference,
      userId: actor.id,
      action: 'REPORT_GENERATION_QUEUED',
      details: { jobId },
      ipAddress: req.ip || '127.0.0.1',
    });

    res.status(202).json({
      message: 'Report generation queued.',
      reportId,
      jobId,
      status: 'GENERATING',
    });
  } catch (error: any) {
    console.error('Generate report error:', error);
    res.status(500).json({ error: error.message || 'Report generation failed.' });
  }
});

app.get('/api/reports/:id/download', async (req: Request, res: Response) => {
  try {
    const reportId = req.params.id as string;
    const token = (req.query.token as string) || undefined;

    // Resolve the authenticated user from the session cookie / bearer token
    // (collection links may alternatively be accessed anonymously via a token).
    const sessionToken =
      req.cookies[getSessionCookieName()] ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.substring(7)
        : undefined);

    let user: any = null;
    if (sessionToken) {
      const payload = verifyToken(sessionToken);
      if (payload?.userId) {
        user = await prisma.user.findUnique({
          where: { id: payload.userId },
          include: { practitionerProfile: true },
        });
      }
    }

    // If no authenticated session, fall back to a signed collection token.
    const tokenReportId = token ? verifyReportCollectionToken(token) : null;
    if (!user && (!tokenReportId || tokenReportId !== reportId)) {
      return res.status(401).json({
        error: 'Authentication required. Please log in or use a valid collection link.',
      });
    }

    const report = await prisma.qeeqReport.findUnique({ where: { id: reportId } });

    if (!report) {
      return res.status(404).json({ error: 'Report not found.' });
    }

    // Ownership check: admins or the submitting practitioner may download.
    if (user && user.role !== 'ADMIN' && report.submittingPractitionerId !== user.id) {
      return res.status(403).json({ error: 'Forbidden. You do not have access to this report.' });
    }

    if (report.status === 'DOWNLOADED_AND_PURGED') {
      return res.status(410).json({
        error: 'In accordance with our zero-retention policy, this report was permanently purged upon initial download.',
      });
    }

    // Strict one-time download rule: only reports that reached COMPLETED may be
    // downloaded (funds captured, output generated) — for every caller,
    // including admins. Downloading triggers an immediate server purge of the
    // report content, so allowing an in-flight state through would destroy
    // unreleasable data. (No admin-download UI exists; admins oversee in-flight
    // state read-only through the pipeline and history views.)
    if (report.status !== 'COMPLETED') {
      return res.status(409).json({
        error: 'Report is not ready for download yet.',
      });
    }

    // Capture the report content in memory to return to the client.
    const findings = report.findings || { caseReference: report.caseReference };

    // Trigger the full purge-on-download: wipe database fields (findings,
    // tovaData, checklistData, reportSummary, filePaths) and delete all files.
    await executePurgeOnDownload(reportId, user?.id, req.ip);

    res.json(findings);
  } catch (error: any) {
    console.error('Download error:', error);
    res.status(500).json({ error: error.message || 'Download failed.' });
  }
});

// ----------------------------------------------------
// 5. Admin & Activity Logs
// ----------------------------------------------------
app.get('/api/admin/reports', authenticateUser, requireAdmin, async (req: Request, res: Response) => {
  try {
    // Live pipeline monitoring (Spec 6.3): instead of a mandatory approval
    // queue, admins see in-flight and recently completed cases for oversight.
    const reports = await prisma.qeeqReport.findMany({
      where: {
        status: {
          in: ['PAYMENT_AUTHORISED', 'GENERATING', 'PENDING_ADMIN_APPROVAL', 'COMPLETED', 'DOWNLOADED_AND_PURGED', 'RELIABILITY_REJECTED'],
        },
      },
      orderBy: { createdAt: 'desc' },
      include: { submittingPractitioner: { include: { practitionerProfile: true } } },
    });
    res.json({ reports });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch active reports.' });
  }
});

// Billing / History view: comprehensive list of ALL cases regardless of status,
// with PayPal transaction references, authorized/captured amounts, timestamps and status.
app.get('/api/admin/reports/history', authenticateUser, requireAdmin, async (req: Request, res: Response) => {
  try {
    const reports = await prisma.qeeqReport.findMany({
      orderBy: { createdAt: 'desc' },
      include: { submittingPractitioner: { include: { practitionerProfile: true } } },
    });
    res.json({ reports });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch report history.' });
  }
});

app.post('/api/admin/reports/:id/decline', authenticateUser, requireAdmin, async (req: Request, res: Response) => {
  try {
    const reportId = req.params.id as string;
    const report = await prisma.qeeqReport.findUnique({ where: { id: reportId } });

    if (!report) {
      return res.status(404).json({ error: 'Report not found.' });
    }

    if (report.status !== 'PENDING_ADMIN_APPROVAL') {
      return res.status(400).json({ error: 'Report is not pending admin approval.' });
    }

    const actor = (req as any).user;

    const updatedReport = await prisma.qeeqReport.update({
      where: { id: reportId },
      data: {
        status: 'RELIABILITY_REJECTED', // Using existing rejection status mapping
        paymentStatus: 'VOIDED',
      },
    });

    // Release the PayPal hold. Try in-band first so the void is executed even
    // when no worker process is deployed/running; only enqueue a VOID_PAYMENT
    // job for a background retry if the in-band attempt fails.
    if (report.paypalAuthorizationId) {
      try {
        await withTimeout(processReportVoid(reportId), 20_000, 'PayPal void');
        console.log(
          `[AdminDecline] PayPal void executed in-band for report ${reportId} (case=${report.caseReference}).`
        );
      } catch (voidError: any) {
        const jobId = await enqueueJob(reportId, JOB_TYPES.VOID_PAYMENT);
        await logActivity({
          reportId,
          caseReference: report.caseReference,
          userId: actor.id,
          action: 'PAYMENT_VOID_QUEUED',
          details: { jobId, authorizationId: report.paypalAuthorizationId },
          ipAddress: req.ip || '127.0.0.1',
        });
        console.error(
          `[AdminDecline] In-band PayPal void failed for report ${reportId}; enqueued job ${jobId} for retry.`,
          voidError?.message || voidError
        );
      }
    }

    // Send Rejection Email
    try {
      const practitioner = await prisma.user.findUnique({
        where: { id: updatedReport.submittingPractitionerId },
        include: { practitionerProfile: true },
      });

      const recipient =
        practitioner?.practitionerProfile?.notificationEmail ||
        practitioner?.practitionerProfile?.practiceEmail ||
        practitioner?.email;

      if (recipient) {
        await sendAdminRejectionNotification(
          recipient,
          practitioner?.practitionerProfile?.fullName || 'Practitioner',
          updatedReport.caseReference
        );
      }
    } catch (e) {
      console.warn('SES email notification issue:', e);
    }

    res.json({
      message: 'Report declined and payment voided.',
      reportId: updatedReport.id,
      caseReference: updatedReport.caseReference,
      status: updatedReport.status,
    });
  } catch (error: any) {
    console.error('Decline report error:', error);
    res.status(500).json({ error: error.message || 'Report decline failed.' });
  }
});

// Admin: legal document registry (current + history) and upload/replace.
app.get('/api/admin/legal/documents', authenticateUser, requireAdmin, async (req: Request, res: Response) => {
  try {
    const [documents, current] = await Promise.all([listLegalDocuments(), getCurrentLegalDocuments()]);
    res.json({ documents, current });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load legal documents.' });
  }
});

app.post('/api/admin/legal/documents', authenticateUser, requireAdmin, async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    const { documentType, fileName, contentType, base64 } = req.body || {};

    if (!documentType) {
      return res.status(400).json({ error: `documentType is required; must be one of: ${LEGAL_DOCUMENT_TYPES.join(', ')}.` });
    }
    if (!base64 || typeof base64 !== 'string' || base64.trim() === '') {
      return res.status(400).json({ error: 'A base64-encoded PDF is required.' });
    }
    if (Buffer.byteLength(base64, 'base64') > MAX_LEGAL_DOCUMENT_BYTES) {
      return res.status(400).json({
        error: `The uploaded PDF exceeds the ${Math.round(MAX_LEGAL_DOCUMENT_BYTES / 1024 / 1024)} MB limit.`,
      });
    }

    const document = await replaceLegalDocument({
      documentType,
      fileName,
      contentType,
      base64,
      uploadedByUserId: actor.id,
      ipAddress: req.ip || '127.0.0.1',
    });

    res.json({ message: 'Legal document updated.', document });
  } catch (error: any) {
    const isValidation = /not a valid PDF|exceeds|must be one of|empty/i.test(error.message || '');
    res.status(isValidation ? 400 : 500).json({ error: error.message || 'Failed to update legal document.' });
  }
});

// ----------------------------------------------------
// Admin: Knowledge Base — uploaded source PDFs and the
// structured research entries extracted from them.
// ----------------------------------------------------
app.get('/api/admin/knowledge/source-pdfs', authenticateUser, requireAdmin, async (req: Request, res: Response) => {
  try {
    const sourcePdfs = await listKnowledgeSourcePdfs();
    res.json({ sourcePdfs });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load knowledge source PDFs.' });
  }
});

// Accepts either a single `{ fileName, contentType, base64 }` payload (legacy
// clients) or a batch payload `{ files: [{ fileName, contentType, base64 }] }`
// for the admin multi-upload flow. Each PDF is processed independently and the
// response reports per-file outcomes so a failed file never blocks the rest.
app.post('/api/admin/knowledge/source-pdfs', authenticateUser, requireAdmin, async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    const body = req.body || {};
    const files = Array.isArray(body.files) && body.files.length > 0
      ? body.files
      : body.base64
      ? [{ fileName: body.fileName, contentType: body.contentType, base64: body.base64 }]
      : [];

    if (files.length === 0) {
      return res.status(400).json({ error: 'A base64-encoded PDF is required.' });
    }
    if (files.length > MAX_KNOWLEDGE_PDF_BATCH) {
      return res.status(400).json({
        error: `Please upload at most ${MAX_KNOWLEDGE_PDF_BATCH} PDFs at once.`,
      });
    }

    const results: { fileName?: string; ok: boolean; sourcePdf?: any; ingested?: number; error?: string }[] = [];
    for (const file of files) {
      const base64 = file?.base64;
      const fileName = file?.fileName;
      if (!base64 || typeof base64 !== 'string' || base64.trim() === '') {
        results.push({ fileName, ok: false, error: 'A base64-encoded PDF is required.' });
        continue;
      }
      if (Buffer.byteLength(base64, 'base64') > MAX_KNOWLEDGE_PDF_BYTES) {
        results.push({
          fileName,
          ok: false,
          error: `The uploaded PDF exceeds the ${Math.round(MAX_KNOWLEDGE_PDF_BYTES / 1024 / 1024)} MB limit.`,
        });
        continue;
      }
      try {
        const sourcePdf = await createSourcePdfFromUpload({
          fileName,
          contentType: file?.contentType,
          base64,
          uploadedByUserId: actor.id,
          ipAddress: req.ip || '127.0.0.1',
        });
        const result = await ingestSourcePdf(sourcePdf.id);
        const updated = await prisma.knowledgeSourcePdf.findUnique({
          where: { id: sourcePdf.id },
          include: {
            entries: { orderBy: { createdAt: 'asc' } },
            uploadedBy: { select: { email: true } },
          },
        });
        results.push({ fileName, ok: true, sourcePdf: updated, ingested: result.count });
      } catch (error: any) {
        results.push({ fileName, ok: false, error: error.message || 'Failed to upload knowledge source PDF.' });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    res.status(okCount > 0 ? 200 : 400).json({
      message: `${okCount} of ${results.length} PDF(s) uploaded and ingested.`,
      results,
    });
  } catch (error: any) {
    console.error('Knowledge source PDF upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload knowledge source PDFs.' });
  }
});

// Streams an uploaded source PDF so the admin can review the original document
// behind the extracted entries (and so curated URLs resolve to something real).
app.get('/api/admin/knowledge/source-pdfs/:id/pdf', authenticateUser, requireAdmin, async (req: Request, res: Response) => {
  try {
    const found = await findKnowledgeSourcePdfPdf(String(req.params.id));
    if (!found) {
      return res.status(404).json({ error: 'Source PDF not found.' });
    }
    res.setHeader('Content-Type', found.sourcePdf.contentType || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${found.sourcePdf.originalFileName}"`);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(found.buffer);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to serve source PDF.' });
  }
});

// Re-runs ingestion for a previously failed (or superseded) source PDF.
app.post('/api/admin/knowledge/source-pdfs/:id/ingest', authenticateUser, requireAdmin, async (req: Request, res: Response) => {
  try {
    const result = await ingestSourcePdf(String(req.params.id));
    const updated = await prisma.knowledgeSourcePdf.findUnique({
      where: { id: String(req.params.id) },
      include: { entries: { orderBy: { createdAt: 'asc' } } },
    });
    res.json({ message: 'Ingestion re-run complete.', sourcePdf: updated, ingested: result.count });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to re-run ingestion.' });
  }
});

// Removes a source PDF, its derived entries, and the physical file (retraction).
app.delete('/api/admin/knowledge/source-pdfs/:id', authenticateUser, requireAdmin, async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    await retractKnowledgeSourcePdf(String(req.params.id), { id: actor.id, email: actor.email });
    res.json({ message: 'Source PDF and its extracted entries have been removed.' });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to remove source PDF.' });
  }
});

// Lists the extracted structured entries (optionally for one source PDF).
app.get('/api/admin/knowledge/entries', authenticateUser, requireAdmin, async (req: Request, res: Response) => {
  try {
    const sourcePdfId = typeof req.query.sourcePdfId === 'string' ? req.query.sourcePdfId : undefined;
    const entries = await listLiteratureEntries(sourcePdfId ? { sourcePdfId } : undefined);
    res.json({ entries });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load knowledge entries.' });
  }
});

// Best-effort notification fan-out whenever the admin changes the GLOBAL
// retention window. Every practitioner holding an active/completed case that
// has not yet been downloaded is emailed the newly configured day count so they
// know how long their un-downloaded reports will remain retrievable before the
// auto-purge deletes them.
//
// CHANGE GATE: the e-mail only fires when the newly saved value actually differs
// from the previously stored one. Both inputs are plain `number` returns from
// getReportRetentionDays()/setReportRetentionDays(), so the comparison is a
// strict numeric check that can never silently skip on a type/state mismatch.
// Re-saving the same value logs "unchanged" and sends nothing.
//
// Deliveries never fail the settings save: every send outcome is logged per
// recipient, and the route responds with the settings update regardless.
async function notifyPractitionersOfRetentionUpdate(
  previousRetentionDays: number,
  newRetentionDays: number
): Promise<void> {
  try {
    if (newRetentionDays === previousRetentionDays) {
      console.log(
        `[Settings] Retention re-save with NO change (old=${previousRetentionDays}d → new=${newRetentionDays}d) — retention-notification emails skipped.`
      );
      return;
    }
    console.log(
      `[Settings] Retention changed: old=${previousRetentionDays}d → new=${newRetentionDays}d. Scanning for pending-download reports...`
    );

    const pending = await prisma.qeeqReport.findMany({
      where: {
        status: {
          in: [
            'PAYMENT_AUTHORISED',
            'PENDING_ADMIN_APPROVAL',
            'GENERATING',
            'IN_NEUROSCIENTIST_REVIEW',
            'COMPLETED',
          ],
        },
        downloadedAt: null,
        purgedAt: null,
      },
      select: {
        caseReference: true,
        submittingPractitionerId: true,
        submittingPractitioner: {
          select: {
            email: true,
            practitionerProfile: {
              select: { fullName: true, notificationEmail: true, practiceEmail: true },
            },
          },
        },
      },
    });
    console.log(
      `[Settings] Retention query: ${pending.length} report(s) pending download matched ` +
        `(status in PAYMENT_AUTHORISED/PENDING_ADMIN_APPROVAL/GENERATING/IN_NEUROSCIENTIST_REVIEW/COMPLETED, downloadedAt=null, purgedAt=null).`
    );

    // Deduplicate by practitioner: one retention e-mail per practitioner, but
    // include how many of their reports are currently pending download.
    const unique = new Map<string, { email: string; name: string; caseCount: number }>();
    for (const report of pending) {
      const profile = report.submittingPractitioner.practitionerProfile;
      const email =
        profile?.notificationEmail ||
        profile?.practiceEmail ||
        report.submittingPractitioner.email;
      if (!email) {
        console.warn(
          `[Settings] Skipping practitioner ${report.submittingPractitionerId} (case ${report.caseReference}): no email address on record.`
        );
        continue;
      }
      const existing = unique.get(report.submittingPractitionerId);
      if (existing) {
        existing.caseCount += 1;
        continue;
      }
      unique.set(report.submittingPractitionerId, {
        email,
        name: profile?.fullName || 'Practitioner',
        caseCount: 1,
      });
    }

    if (unique.size === 0) {
      console.log(
        `[Settings] No practitioners with a pending-download report to notify for the new ${newRetentionDays}d window — nothing to send.`
      );
      return;
    }

    const entries = [...unique.values()];
    console.log(
      `[Settings] Dispatching retention-notification emails to ${entries.length} practitioner(s) for the new ${newRetentionDays}d window.`
    );
    const results = await Promise.allSettled(
      entries.map((entry) =>
        sendRetentionUpdateNotification(entry.email, entry.name, newRetentionDays, entry.caseCount)
      )
    );

    let sent = 0;
    let failed = 0;
    results.forEach((result, i) => {
      const entry = entries[i];
      if (result.status === 'fulfilled' && result.value.success) {
        sent += 1;
        console.log(
          `[Settings] Retention notification SENT to ${entry.email} (${entry.name}, ${entry.caseCount} pending report(s)) — ` +
            `${result.value.simulated ? 'simulated (dev log mode)' : `messageId=${result.value.messageId || 'unknown'}`}.`
        );
      } else {
        failed += 1;
        const reason =
          result.status === 'rejected'
            ? result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
            : result.value.error || 'unknown error';
        console.error(
          `[Settings] Retention notification FAILED for ${entry.email} (${entry.name}, ${entry.caseCount} pending report(s)) — ${reason}.`
        );
      }
    });
    console.log(
      `[Settings] Retention fan-out complete: sent=${sent} failed=${failed} ` +
        `practitioners=${entries.length} matchingReports=${pending.length}.`
    );
  } catch (error: any) {
    console.error('[Settings] Retention-notification email fan-out failed:', error?.message || error);
  }
}

app.get('/api/admin/settings', authenticateUser, requireAdmin, async (req: Request, res: Response) => {
  try {
    const reportFeeAUD = await getReportFeeAUD();
    const reportRetentionDays = await getReportRetentionDays();
    res.json({
      settings: {
        reportFeeAUD,
        reportRetentionDays,
        minReliabilityThreshold: 0.8,
        currency: 'AUD',
        hostingRegion: 'ap-southeast-2 (Sydney)',
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch settings.' });
  }
});

app.put('/api/admin/settings', authenticateUser, requireAdmin, async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    const body = req.body;

    let reportFeeAUD: number | undefined;
    if (typeof body.reportFeeAUD === 'number') {
      if (body.reportFeeAUD < 10 || body.reportFeeAUD > 500) {
        return res.status(400).json({ error: 'reportFeeAUD must be between 10 and 500 AUD.' });
      }
      reportFeeAUD = await setReportFeeAUD(body.reportFeeAUD);
    } else {
      reportFeeAUD = await getReportFeeAUD();
    }

    let reportRetentionDays: number | undefined;
    if (typeof body.reportRetentionDays === 'number') {
      if (
        !Number.isInteger(body.reportRetentionDays) ||
        body.reportRetentionDays < MIN_REPORT_RETENTION_DAYS ||
        body.reportRetentionDays > MAX_REPORT_RETENTION_DAYS
      ) {
        return res.status(400).json({
          error: `reportRetentionDays must be a whole number between ${MIN_REPORT_RETENTION_DAYS} and ${MAX_REPORT_RETENTION_DAYS}.`,
        });
      }
      const previousRetention = await getReportRetentionDays();
      reportRetentionDays = await setReportRetentionDays(body.reportRetentionDays);
      // Change detection now lives inside the helper so the old/new comparison
      // and its outcome are always logged together. A re-save with the same
      // value logs "NO change" and sends nothing.
      await notifyPractitionersOfRetentionUpdate(previousRetention, reportRetentionDays);
    } else {
      reportRetentionDays = await getReportRetentionDays();
    }

    await logActivity({
      userId: actor.id,
      action: 'SETTINGS_UPDATED',
      details: { reportFeeAUD, reportRetentionDays },
      ipAddress: req.ip || '127.0.0.1',
    });

    res.json({
      message: 'Settings updated.',
      settings: {
        reportFeeAUD,
        reportRetentionDays,
        minReliabilityThreshold: 0.8,
        currency: 'AUD',
        hostingRegion: 'ap-southeast-2 (Sydney)',
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update settings.' });
  }
});

// 404 Handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.path}` });
});

// Global JSON Error Handler: Express's built-in default error handler renders
// an HTML error page (e.g. `express.json()` SyntaxError on a malformed/empty
// JSON body, or any synchronous throw in the middleware stack) whenever an
// error reaches the error chain. That HTML leaks through to API clients and
// breaks `res.json()` on the frontend. Convert every error into JSON instead.
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  const status = err?.status || err?.statusCode || 500;
  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.path}:`, err?.message || err);
  }
  if (res.headersSent) {
    return next(err);
  }
  res.status(status).json({ error: err?.message || 'Internal server error.' });
});

// Validate configuration before accepting traffic. In production any error
// aborts startup; in development issues are printed as warnings so the app
// still boots with sensible fallbacks.
const envCheck = reportEnvironmentIssues(validateEnvironment());
if (envCheck.errors > 0) {
  console.error(
    `[env] Aborting startup: ${envCheck.errors} configuration error(s) must be resolved before running in production.`
  );
  process.exit(1);
}

// Start Server
app.listen(PORT, () => {
  console.log('====================================================');
  console.log(`[QEEG.com.au Backend] Server listening on port ${PORT}`);
  console.log(`[Region] ap-southeast-2 (Sydney, Australia Sovereign)`);
  console.log(`[CORS Allowed Origin] ${FRONTEND_URL}`);
  console.log(`[Public Link Base URL] ${getPublicBaseUrl()} (used for all emailed links)`);
  console.log(`[Healthcheck URL] http://localhost:${PORT}/health`);
  console.log('====================================================');

  // Report the resolved PayPal mode + credential pair at boot so a
  // sandbox/live mismatch is visible before the first checkout attempt.
  logPayPalCredentialSource();

  // Data-lifecycle backstop (Spec 4.3g): purge any completed report that has
  // not been purged within the admin-configurable retention window (default 30
  // days, key REPORT_RETENTION_DAYS in SystemSettings), then sweep daily. The
  // window is re-read from the DB on every sweep so admin changes apply live.
  scheduleBackstopPurge().catch((e) =>
    console.error('[BackstopPurge] Start-up sweep failed:', e)
  );

  // Recurring auto-reminder sweep: pending-download reports are emailed every
  // 3 days (anchored on their createdAt / lastReminderSentAt) until they are
  // downloaded or purged. The sweep re-runs every 6 hours, with an exact 3-day
  // recurrence guaranteed per report via the lastReminderSentAt tracking column.
  scheduleReportReminders().catch((e) =>
    console.error('[ReportReminder] Start-up sweep failed:', e)
  );

  // Postmark connectivity self-test (non-blocking): verify DNS/TLS reachability
  // and token validity up-front so a dead email path is reported loudly instead
  // of failing silently on every welcome/login/approval email afterwards.
  void checkEmailConnectivity().catch(() => undefined);
});
