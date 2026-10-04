/**
 * Server-side mandatory-field validation for the practitioner report request.
 *
 * Why this exists: the browser already refuses to submit an incomplete
 * checklist, but the browser is untrusted. Every field the clinical report
 * depends on is nullable in the database (`schema.prisma`: age, gender,
 * handedness, checklistData, ...), so a crafted or replayed request could
 * otherwise persist a report with holes in it and still walk through the
 * payment + generation pipeline.
 *
 * Design notes:
 *  - Errors are returned as a FLAT, ordered list of { field, label, message }
 *    so the UI can show every missing item at once rather than one per
 *    submission attempt.
 *  - `isBlank` treats whitespace-only strings as missing. A field containing
 *    "   " is not data.
 *  - This module is deliberately PURE (no I/O, no Prisma, no PayPal) so it can
 *    be unit tested exhaustively. The caller decides what to do on failure,
 *    including releasing any payment authorisation already taken.
 */

import { getChecklistSections, loadChecklistDefinition } from './checklistDefinition';

export interface FieldError {
  /** Machine-readable field key, e.g. `age` or `practitioner_full_name`. */
  field: string;
  /** Human label for the UI, e.g. "Client Age (Years)". */
  label: string;
  /** Human-readable reason this field is unacceptable. */
  message: string;
}

export interface ValidationResult {
  passed: boolean;
  errors: FieldError[];
}

const ok = (): ValidationResult => ({ passed: true, errors: [] });

/** True for undefined, null, non-strings, or whitespace-only strings. */
function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

/** Case-insensitive membership test for an enum-constrained field. */
function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  if (typeof value !== 'string') return false;
  const needle = value.trim().toUpperCase();
  return allowed.some((a) => a.trim().toUpperCase() === needle);
}

function push(errors: FieldError[], field: string, label: string, message: string): void {
  errors.push({ field, label, message });
}

/* ------------------------------------------------------------------------ */
/* Practitioner profile (signup + Account Settings)                          */
/* ------------------------------------------------------------------------ */

/**
 * Fields copied into the generated report header. `professionalTitle` is
 * listed here deliberately: it is required by checklist-definition.json but
 * was historically optional at signup, which could permanently block a
 * practitioner from ever submitting a case.
 */
export const REQUIRED_PROFILE_FIELDS: { key: string; label: string }[] = [
  { key: 'fullName', label: 'Full Name & Post-Nominals' },
  { key: 'professionalTitle', label: 'Professional Title / Credentials' },
  { key: 'profession', label: 'Profession / Registration Type' },
  { key: 'providerNumber', label: 'Registration / Provider Number' },
  { key: 'clinicName', label: 'Practice / Clinic Name' },
  { key: 'practiceAddress', label: 'Practice Address' },
  { key: 'phone', label: 'Practice Contact Phone' },
];

/**
 * Validates the practitioner profile carried on a signup or profile update.
 * Email and password are validated separately by `stagePendingRegistration`
 * (they have format rules and duplicate-detection beyond mere presence).
 */
export function validateProfileFields(input: Record<string, unknown>): ValidationResult {
  const errors: FieldError[] = [];

  for (const field of REQUIRED_PROFILE_FIELDS) {
    if (isBlank(input[field.key])) {
      push(errors, field.key, field.label, `${field.label} is required.`);
    }
  }

  // Digit-count sanity check. This lives on the shared profile validator
  // (so it applies at signup AND on profile update); the stricter
  // character-class rules are signup-only, in validateSignupFieldFormats.
  const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
  if (!isBlank(phone) && phone.replace(/\D/g, '').length < 7) {
    push(errors, 'phone', 'Practice Contact Phone', 'Practice Contact Phone must contain at least 7 digits.');
  }

  return { passed: errors.length === 0, errors };
}

/* ------------------------------------------------------------------------ */
/* Signup / Register form - field FORMAT rules                               */
/* ------------------------------------------------------------------------ */

/**
 * SCOPE: called by `stagePendingRegistration` ONLY. This is intentionally NOT
 * folded into `validateProfileFields`, because that function also backs
 * `PUT /api/practitioner/profile` and these stricter character rules are
 * specified for the signup form alone. Keeping them separate guarantees the
 * portal profile form, the report checklist, and the payment/billing path are
 * unaffected.
 *
 * Mirrored by `frontend/lib/signupValidation.ts`. The two repositories cannot
 * import from each other, so these must be kept in sync - `formValidation.test.ts`
 * locks the server-side copy.
 */

/** Phone accepts digits, spaces, +, - and parentheses. Letters are rejected. */
const PHONE_ALLOWED = /^[0-9+()\-\s]+$/;
const PHONE_HAS_LETTER = /[A-Za-z]/;

/**
 * Provider number accepts letters AND digits (e.g. AHPRA "MED0001234567", or
 * "PR-88921-VIC / PSY000123"). Only stray symbols are rejected.
 */
const PROVIDER_NUMBER_ALLOWED = /^[A-Za-z0-9\s\-\/]+$/;

/** Stricter than a bare shape check: a doubled or edge dot is always a typo. */
const EMAIL_SHAPE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const EMAIL_BAD_LOCAL_DOTS = /^\.|\.$|\.\./;

/** Minimum acceptable password length. */
export const MIN_PASSWORD_LENGTH = 8;

/** Minimum number of digits a plausible phone number must contain. */
const MIN_PHONE_DIGITS = 7;

/**
 * Applies the signup form's field-level format rules.
 *
 * Presence is handled by `validateProfileFields`, so this only formats fields
 * that actually have a value - a blank field must not report both "required"
 * and a format complaint.
 */
export function validateSignupFieldFormats(input: Record<string, unknown>): ValidationResult {
  const errors: FieldError[] = [];

  const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
  if (!isBlank(phone)) {
    if (PHONE_HAS_LETTER.test(phone)) {
      push(errors, 'phone', 'Practice Contact Phone', 'Please enter a valid phone number without letters.');
    } else if (!PHONE_ALLOWED.test(phone)) {
      push(
        errors,
        'phone',
        'Practice Contact Phone',
        'Please enter a valid phone number (digits, spaces, +, - and parentheses only).'
      );
    } else if (phone.replace(/\D/g, '').length < MIN_PHONE_DIGITS) {
      push(
        errors,
        'phone',
        'Practice Contact Phone',
        `Practice Contact Phone must contain at least ${MIN_PHONE_DIGITS} digits.`
      );
    }
  }

  const providerNumber =
    typeof input.providerNumber === 'string' ? input.providerNumber.trim() : '';
  if (!isBlank(providerNumber) && !PROVIDER_NUMBER_ALLOWED.test(providerNumber)) {
    push(
      errors,
      'providerNumber',
      'Registration / Provider Number',
      'Please use letters, numbers, spaces, hyphens or slashes only (e.g. MED0001234567).'
    );
  }

  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (!isBlank(email)) {
    const local = email.split('@')[0] ?? '';
    if (EMAIL_BAD_LOCAL_DOTS.test(local) || !EMAIL_SHAPE.test(email)) {
      push(
        errors,
        'email',
        'Login & Notification Email',
        'Please enter a valid email address (e.g. practitioner@clinic.com.au).'
      );
    }
  }

  const password = typeof input.password === 'string' ? input.password : '';
  if (!isBlank(password) && password.length < MIN_PASSWORD_LENGTH) {
    push(
      errors,
      'password',
      'Password',
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`
    );
  }

  return { passed: errors.length === 0, errors };
}

/* ------------------------------------------------------------------------ */
/* Report request payload                                                     */
/* ------------------------------------------------------------------------ */

/** Minimum plausible human age; guards against NaN/negative/absurd values. */
const MIN_CLIENT_AGE = 1;
const MAX_CLIENT_AGE = 120;

/**
 * Validates the de-identified report submission payload.
 *
 * Runs BEFORE any payment is authorised so an incomplete request can never
 * reach the money path.
 */
export function validateReportRequestPayload(payload: Record<string, unknown>): ValidationResult {
  const errors: FieldError[] = [];

  /* --- Case reference ---------------------------------------------------- */
  if (isBlank(payload.caseReference)) {
    push(errors, 'caseReference', 'Case Reference', 'Case Reference is required.');
  }

  /* --- Client demographics (zero-PII policy) ----------------------------- */
  const ageRaw = payload.age;
  if (isBlank(ageRaw)) {
    push(errors, 'age', 'Client Age (Years)', 'Client Age (Years) is required.');
  } else {
    const age = typeof ageRaw === 'number' ? ageRaw : Number(String(ageRaw).trim());
    if (!Number.isFinite(age) || age < MIN_CLIENT_AGE || age > MAX_CLIENT_AGE) {
      push(
        errors,
        'age',
        'Client Age (Years)',
        `Client Age (Years) must be a number between ${MIN_CLIENT_AGE} and ${MAX_CLIENT_AGE}.`
      );
    }
  }

  if (!isOneOf(payload.gender, ['MALE', 'FEMALE', 'OTHER'])) {
    push(errors, 'gender', 'Biological Gender', 'Biological Gender is required (MALE, FEMALE or OTHER).');
  }

  if (!isOneOf(payload.handedness, ['RIGHT', 'LEFT', 'AMBIDEXTROUS'])) {
    push(errors, 'handedness', 'Dominant Handedness', 'Dominant Handedness is required (RIGHT, LEFT or AMBIDEXTROUS).');
  }

  /* --- QEEG reliability --------------------------------------------------- */
  const scoreRaw = payload.reliabilityScore;
  if (isBlank(scoreRaw)) {
    push(errors, 'reliabilityScore', 'QEEG Reliability Score', 'QEEG Reliability Score is required.');
  } else {
    const score = typeof scoreRaw === 'number' ? scoreRaw : Number(String(scoreRaw).trim());
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      push(errors, 'reliabilityScore', 'QEEG Reliability Score', 'QEEG Reliability Score must be between 0 and 1.');
    }
  }

  /* --- TDT payload ------------------------------------------------------- */
  if (isBlank(payload.tdtContent)) {
    push(errors, 'tdtContent', 'QEEG Recording (.tdt)', 'A QEEG recording is required.');
  }

  /* --- TOVA -------------------------------------------------------------- */
  if (isBlank(payload.tovaData) || payload.tovaData === null || typeof payload.tovaData !== 'object') {
    push(errors, 'tovaData', 'TOVA Report', 'TOVA supporting-test data is required.');
  }

  /* --- Symptom checklist -------------------------------------------------- */
  const checklist = payload.checklistData;
  if (isBlank(checklist) || checklist === null || typeof checklist !== 'object' || Array.isArray(checklist)) {
    push(errors, 'checklistData', 'Symptom Checklist', 'The Symptom Checklist must be completed.');
  } else {
    validateChecklist(checklist as Record<string, unknown>, errors);
  }

  return { passed: errors.length === 0, errors };
}

/**
 * Validates the checklist body against the LIVE definition, so adding a
 * required field to checklist-definition.json automatically starts enforcing
 * it here with no second place to update.
 */
function validateChecklist(checklist: Record<string, unknown>, errors: FieldError[]): void {
  /* Every symptom domain must be rated 0-4. */
  const definition = loadChecklistDefinition();
  const domains = Array.isArray(checklist.domains) ? (checklist.domains as Record<string, unknown>[]) : [];
  const scoredKeys = new Set<string>();

  for (const domain of domains) {
    if (typeof domain?.key !== 'string') continue;
    const score = domain.score;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 4) {
      // Collect the human title/number when available for a clearer message.
      const label =
        typeof domain.title === 'string' && domain.title.trim() !== ''
          ? domain.title
          : `Domain ${typeof domain.num === 'number' ? domain.num : '?'}`;
      push(errors, `domain:${domain.key}`, label, `${label} must be rated on the 0-4 scale.`);
      continue;
    }
    scoredKeys.add(domain.key);
  }

  const missingDomains = definition.domains.filter((d) => !scoredKeys.has(d.key));
  for (const domain of missingDomains) {
    push(
      errors,
      `domain:${domain.key}`,
      domain.title,
      `${domain.title} has not been rated.`
    );
  }

  /* Required select fields. */
  if (!isOneOf(checklist.recordingCondition, ['EC', 'EO', 'TOVA'])) {
    push(
      errors,
      'recording_condition',
      'QEEG Recording Condition',
      'QEEG Recording Condition is required (EC, EO or TOVA).'
    );
  }

  /* Statutory acknowledgements - these must be affirmatively true. */
  if (checklist.serviceAgreementAcknowledged !== true) {
    push(
      errors,
      'service_agreement_ack',
      'Statutory Service Agreement Acknowledgement',
      'The Statutory Service Agreement must be acknowledged.'
    );
  }
  if (checklist.paymentAuthorisationAcknowledged !== true) {
    push(
      errors,
      'payment_auth_ack',
      'PayPal Fee Authorisation Acknowledgement',
      'The PayPal fee authorisation must be acknowledged.'
    );
  }

  /* Sign-off. */
  if (isBlank(checklist.signature)) {
    push(
      errors,
      'signature',
      'Practitioner Digital Signature',
      'The practitioner digital signature (typed name) is required.'
    );
  }
  if (isBlank(checklist.dateSigned)) {
    push(errors, 'date_signed', 'Date Signed', 'Date Signed is required.');
  }

  /* Cross-check required fields that live INSIDE the checklist body.
     Fields with a `source` binding (`profile.*` / `case.*`) are resolved from
     the top-level payload instead - they are not copied into the checklist, so
     probing them here would report every one of them as missing. */
  for (const section of getChecklistSections()) {
    if (section.required === false || section.kind !== 'fields') continue;
    for (const field of section.fields ?? []) {
      if (!field.required || field.type === 'checkbox') continue;
      if (field.source) continue;
      const value = readChecklistField(checklist, field.key);
      if (isBlank(value)) {
        push(errors, field.key, field.label, `${field.label} is required.`);
      }
    }
  }
}

/**
 * Reads a field's value out of the submitted checklist body. Field keys are
 * snake_case (`professional_title`); the submitted body uses camelCase for a
 * handful of them, so both spellings are probed.
 */
function readChecklistField(checklist: Record<string, unknown>, key: string): unknown {
  const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return checklist[key] ?? checklist[camel];
}
