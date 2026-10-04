import crypto from 'crypto';
import { prisma } from '../prisma';
import { UserRole } from '@prisma/client';
import {
  hashPassword,
  createTOTPSecret,
  generateTOTPAuthURL,
  verifyTOTPCode,
  generateBackupCodes,
} from './authService';
import { validateProfileFields, validateSignupFieldFormats, type FieldError } from './formValidation';

/**
 * Deferred (pending) practitioner registration.
 *
 * Two-factor authentication is mandatory at signup, so the account must not
 * exist until the practitioner has proved they can actually use an
 * authenticator app. This module holds a registration *in memory only* — nothing
 * is written to PostgreSQL until the TOTP code is verified:
 *
 *   1. stagePendingRegistration()   -> validates, hashes the password, mints a
 *                                      TOTP secret, returns the otpauth URL/QR.
 *   2. completePendingRegistration() -> verifies the TOTP code, and only then
 *                                      creates the user + profile + legal
 *                                      acceptances in a single transaction and
 *                                      issues the 10 backup codes.
 *
 * If the browser is closed, the QR step is abandoned, the code is wrong too
 * many times, or the server restarts, the staged entry simply expires or is
 * dropped. No account was ever created, so the user restarts cleanly and can
 * never end up in a half-registered state (an account with 2FA disabled).
 *
 * Entries live in process memory by design: the password hash and TOTP secret
 * never leave the server, and a restart safely invalidates all pending
 * registrations.
 */

// How long a staged registration stays valid (the user has to scan a QR code
// and type a 6-digit code within this window).
const PENDING_TTL_MS = 15 * 60 * 1000;
// Wrong TOTP codes tolerated before the staged registration is discarded and
// the user is forced back to the form.
const MAX_VERIFY_ATTEMPTS = 6;
// Hard cap so an unauthenticated flood of signups cannot grow the map without
// bound. Oldest entries are evicted first.
const MAX_PENDING_ENTRIES = 500;
// Background sweep interval for expired entries.
const SWEEP_INTERVAL_MS = 60 * 1000;

export interface StagedRegistration {
  email: string;
  passwordHash: string;
  role: UserRole;
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
  legalAcceptances: { type: string; version: string }[];
  totpSecret: string;
  createdAt: number;
  expiresAt: number;
  verifyAttempts: number;
}

const pending = new Map<string, StagedRegistration>();

function isExpired(entry: StagedRegistration, now = Date.now()): boolean {
  return entry.expiresAt <= now;
}

function sweep(now = Date.now()): void {
  for (const [id, entry] of pending) {
    if (isExpired(entry, now)) pending.delete(id);
  }
}

function evictOldestIfNeeded(): void {
  // Map preserves insertion order, so the first key is the oldest entry.
  while (pending.size >= MAX_PENDING_ENTRIES) {
    const oldest = pending.keys().next();
    if (oldest.done) break;
    pending.delete(oldest.value);
  }
}

const sweeper = setInterval(() => sweep(), SWEEP_INTERVAL_MS);
// Never hold the event loop open just for the sweeper.
if (typeof sweeper.unref === 'function') sweeper.unref();

export interface StagedRegistrationInput {
  email: string;
  password: string;
  role?: string;
  fullName?: string | null;
  professionalTitle?: string | null;
  professionType?: string | null;
  profession?: string | null;
  providerNumber?: string | null;
  practiceName?: string | null;
  clinicName?: string | null;
  practiceAddress?: string | null;
  practicePhone?: string | null;
  phone?: string | null;
  practiceEmail?: string | null;
  notificationEmail?: string | null;
  legalAcceptances?: unknown;
}

export interface StagedRegistrationResult {
  ok: true;
  pendingId: string;
  otpauthUrl: string;
  secret: string;
  email: string;
  expiresInSeconds: number;
}

export type StageResult =
  | StagedRegistrationResult
  | { ok: false; status: number; error: string; fieldErrors?: FieldError[] };

function normaliseLegalAcceptances(input: unknown): { type: string; version: string }[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: { type: string; version: string }[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const acc = raw as Record<string, unknown>;
    if (typeof acc.type !== 'string' || acc.type.trim() === '') continue;
    const type = acc.type.trim();
    if (seen.has(type)) continue;
    seen.add(type);
    result.push({ type, version: typeof acc.version === 'string' ? acc.version : String(acc.version ?? '') });
  }
  return result;
}

/**
 * Validates the submitted details and stages them in memory alongside a fresh
 * TOTP secret. Performs NO database writes beyond a read-only availability
 * check on the email address.
 */
export async function stagePendingRegistration(
  input: StagedRegistrationInput
): Promise<StageResult> {
  const email = (input.email || '').toLowerCase().trim();
  const password = input.password || '';

  // NOTE: email and password are NOT in REQUIRED_PROFILE_FIELDS, because that
  // list is shared with PUT /api/practitioner/profile. Their presence is
  // therefore asserted here and surfaced as 422 field-level errors below, so
  // the signup form can highlight the specific inputs. This block is a
  // defensive backstop only - it guarantees `email`/`password` are usable
  // strings before any hashing or database access; the user-facing message
  // always comes from the fieldErrors path.

  // Mandatory practitioner fields. Every one of these lands in the generated
  // report header, and `professionalTitle` is specifically required by
  // checklist-definition.json - accepting a blank there would create a
  // practitioner who can never satisfy the checklist at submission time.
  // Reported as 422 with a per-field breakdown so the form can highlight the
  // specific inputs rather than showing one opaque message.
  const profileCheck = validateProfileFields(input as unknown as Record<string, unknown>);

  // Signup-only field FORMAT rules (phone character set, provider-number
  // character set, email shape, password length). Kept separate from the
  // presence check above so a blank field reports only "required", never both
  // a missing-value and a format complaint.
  const formatCheck = validateSignupFieldFormats(input as unknown as Record<string, unknown>);

  // Presence for the two auth fields owned by this function, matching the
  // wording the frontend uses so the same value never produces two messages.
  const authPresenceErrors: FieldError[] = [];
  if (!email) {
    authPresenceErrors.push({
      field: 'email',
      label: 'Login & Notification Email',
      message: 'Login & Notification Email is required.',
    });
  }
  if (!password) {
    authPresenceErrors.push({
      field: 'password',
      label: 'Password',
      message: 'Password is required.',
    });
  }

  const fieldErrors = [...profileCheck.errors, ...formatCheck.errors, ...authPresenceErrors];
  if (fieldErrors.length > 0) {
    return {
      ok: false,
      status: 422,
      error: 'Please correct the highlighted fields.',
      fieldErrors,
    };
  }

  // Defensive: unreachable while the checks above hold, but guarantees the
  // values are safe for bcrypt and the unique-email lookup regardless.
  if (!email || !password) {
    return { ok: false, status: 400, error: 'Email and password are required.' };
  }

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    return { ok: false, status: 409, error: 'An account with this email already exists.' };
  }

  const now = Date.now();
  sweep(now);
  evictOldestIfNeeded();

  // Hash now so the verification step stays fast and the plaintext password is
  // never retained.
  const passwordHash = await hashPassword(password);
  const totpSecret = createTOTPSecret();

  const pendingId = crypto.randomBytes(32).toString('hex');
  const role = input.role === 'NEUROSCIENTIST' ? UserRole.NEUROSCIENTIST : UserRole.PRACTITIONER;

  const entry: StagedRegistration = {
    email,
    passwordHash,
    role,
    fullName: input.fullName?.trim() || null,
    professionalTitle: input.professionalTitle?.trim() || null,
    professionType: input.professionType?.trim() || null,
    profession: input.profession?.trim() || null,
    providerNumber: input.providerNumber?.trim() || null,
    practiceName: input.practiceName?.trim() || null,
    clinicName: input.clinicName?.trim() || null,
    practiceAddress: input.practiceAddress?.trim() || null,
    practicePhone: input.practicePhone?.trim() || null,
    phone: input.phone?.trim() || null,
    practiceEmail: input.practiceEmail?.trim() || email,
    notificationEmail: input.notificationEmail?.trim() || email,
    legalAcceptances: normaliseLegalAcceptances(input.legalAcceptances),
    totpSecret,
    createdAt: now,
    expiresAt: now + PENDING_TTL_MS,
    verifyAttempts: 0,
  };

  pending.set(pendingId, entry);

  return {
    ok: true,
    pendingId,
    secret: totpSecret,
    otpauthUrl: generateTOTPAuthURL(email, totpSecret),
    email,
    expiresInSeconds: Math.floor(PENDING_TTL_MS / 1000),
  };
}

export interface CreateAccountParams {
  email: string;
  passwordHash: string;
  role: UserRole;
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
  legalAcceptances: { type: string; version: string }[];
  totpSecret?: string | null;
  totpEnabled?: boolean;
}

/**
 * Creates the user, practitioner profile and legal acceptances atomically.
 * Shared by the deferred-completion path and the legacy immediate-signup path
 * so both produce an identical account shape.
 */
export async function createPractitionerAccount(params: CreateAccountParams) {
  // Field aliases: the form may submit either the "practice*" or the shorter
  // field name. Both columns are populated from the single resolved value.
  const resolvedProfession = params.professionType?.trim() || params.profession?.trim() || null;
  const resolvedClinic = params.practiceName?.trim() || params.clinicName?.trim() || null;
  const resolvedPhone = params.practicePhone?.trim() || params.phone?.trim() || null;
  const resolvedPracticeEmail = params.practiceEmail?.trim() || params.email;
  const resolvedNotificationEmail = params.notificationEmail?.trim() || params.email;

  return prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        email: params.email,
        passwordHash: params.passwordHash,
        role: params.role,
        totpSecret: params.totpSecret ?? null,
        totpEnabled: params.totpEnabled ?? false,
        practitionerProfile: {
          create: {
            fullName: params.fullName?.trim() || null,
            professionalTitle: params.professionalTitle?.trim() || null,
            professionType: resolvedProfession,
            profession: resolvedProfession,
            providerNumber: params.providerNumber?.trim() || null,
            practiceName: resolvedClinic,
            clinicName: resolvedClinic,
            practiceAddress: params.practiceAddress?.trim() || null,
            practicePhone: resolvedPhone,
            phone: resolvedPhone,
            practiceEmail: resolvedPracticeEmail,
            notificationEmail: resolvedNotificationEmail,
          },
        },
      },
      include: { practitionerProfile: true },
    });

    for (const acc of params.legalAcceptances) {
      await tx.legalAcceptance.create({
        data: {
          userId: newUser.id,
          acceptanceType: acc.type,
          version: acc.version,
          acceptedAt: new Date(),
        },
      });
    }

    return newUser;
  });
}

export type CompleteResult =
  | { ok: true; user: Awaited<ReturnType<typeof createPractitionerAccount>>; backupCodes: string[] }
  | { ok: false; status: number; error: string; discard: boolean };

/**
 * Verifies the TOTP code and — only on success — commits the account together
 * with the 2FA secret, the enabled flag and the 10 backup codes.
 *
 * Returns a discriminated result so the route handler stays thin and this logic
 * is testable without HTTP.
 */
export async function completePendingRegistration(params: {
  pendingId: string;
  totpCode: string;
}): Promise<CompleteResult> {
  const { pendingId, totpCode } = params;

  if (!pendingId || typeof pendingId !== 'string') {
    return { ok: false, status: 400, error: 'Registration session is missing.', discard: true };
  }

  const entry = pending.get(pendingId);
  if (!entry) {
    return {
      ok: false,
      status: 400,
      error: 'Your registration session has expired. Please enter your details again.',
      discard: true,
    };
  }
  if (isExpired(entry)) {
    pending.delete(pendingId);
    return {
      ok: false,
      status: 400,
      error: 'Your registration session has expired. Please enter your details again.',
      discard: true,
    };
  }

  const code = typeof totpCode === 'string' ? totpCode.trim() : '';
  if (!code) {
    return { ok: false, status: 400, error: 'Verification code is required.', discard: false };
  }

  if (!verifyTOTPCode(entry.totpSecret, code)) {
    entry.verifyAttempts += 1;
    const exhausted = entry.verifyAttempts >= MAX_VERIFY_ATTEMPTS;
    if (exhausted) pending.delete(pendingId);
    return {
      ok: false,
      // 400 (not 401): a mistyped code is a form error, and the frontend auth
      // proxy treats 401 as "session invalid" and clears the cookie.
      status: 400,
      error: exhausted
        ? 'Too many incorrect verification codes. No account was created — please start again.'
        : 'Invalid verification code.',
      discard: exhausted,
    };
  }

  // The TOTP code is valid. The account may now be created, atomically.
  // Re-check the email: it could have been registered in the interim.
  const clash = await prisma.user.findUnique({ where: { email: entry.email } });
  if (clash) {
    pending.delete(pendingId);
    return {
      ok: false,
      status: 409,
      error: 'An account with this email already exists.',
      discard: true,
    };
  }

  // Single-use regardless of outcome from here on.
  pending.delete(pendingId);

  const user = await createPractitionerAccount({
    email: entry.email,
    passwordHash: entry.passwordHash,
    role: entry.role,
    fullName: entry.fullName,
    professionalTitle: entry.professionalTitle,
    professionType: entry.professionType,
    profession: entry.profession,
    providerNumber: entry.providerNumber,
    practiceName: entry.practiceName,
    clinicName: entry.clinicName,
    practiceAddress: entry.practiceAddress,
    practicePhone: entry.practicePhone,
    phone: entry.phone,
    practiceEmail: entry.practiceEmail,
    notificationEmail: entry.notificationEmail,
    legalAcceptances: entry.legalAcceptances,
    // 2FA is enabled at creation time, so the account is never momentarily
    // stored without it.
    totpSecret: entry.totpSecret,
    totpEnabled: true,
  });

  const backupCodes = await generateBackupCodes(user.id);

  return { ok: true, user, backupCodes };
}

/** Test/diagnostic helper: number of live staged registrations. */
export function pendingRegistrationCount(): number {
  sweep();
  return pending.size;
}
