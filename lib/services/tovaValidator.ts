/**
 * Server-side validation for the mandatory TOVA supporting-test payload.
 *
 * TOVA metrics became a required part of the report request workflow (the
 * client blocks "Continue to Checklist" until a TOVA file is uploaded and
 * verified). This module re-validates that payload independently on the
 * server so the requirement cannot be bypassed by a crafted request.
 *
 * The accepted shape mirrors the browser-side `TovaSession` contract in
 * `frontend/lib/tovaParser.ts`; the raw TOVA file is never transmitted, only
 * these de-identified, parsed metrics.
 */

export type TovaValidationErrorCode = 'TOVA_REQUIRED' | 'TOVA_INVALID';

export interface TovaValidationResult {
  passed: boolean;
  errorCode?: TovaValidationErrorCode;
  rejectionReason?: string;
}

/** Numeric metrics the browser parser can emit, with their validation bounds. */
const NUMERIC_TOVA_KEYS = [
  'age',
  'dPrime',
  'adhdScore',
  'responseTimeMs',
  'variabilityMs',
  'commissionErrors',
  'omissionErrors',
] as const;

/** Optional free-text metadata emitted by the browser parser. */
const STRING_TOVA_KEYS = ['sessionLabel', 'testDate'] as const;

const ALLOWED_TOVA_KEYS: ReadonlySet<string> = new Set<string>([
  ...NUMERIC_TOVA_KEYS,
  ...STRING_TOVA_KEYS,
]);

/**
 * The set of metrics that qualify a session as a parsable TOVA record in the
 * browser parser (`frontend/lib/tovaParser.ts`, the session-acceptance test).
 * This MUST stay aligned with it: any session the client accepts as "verified"
 * satisfies this set, so the server never rejects a legitimately parsed file.
 * Requiring at least one ensures a "verified" payload carries real analytical
 * content rather than an empty object.
 */
const REQUIRED_METRIC_KEYS: ReadonlySet<string> = new Set<string>([
  'dPrime',
  'adhdScore',
  'responseTimeMs',
  'commissionErrors',
  'omissionErrors',
]);

/** Upper bound mirroring the browser parser's MAX_TOVA_VALUE guard. */
const MAX_TOVA_VALUE = 1_000_000;

const MAX_STRING_LENGTH = 200;

/** Keys that must never be stored, to avoid prototype pollution on merge. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set<string>([
  '__proto__',
  'constructor',
  'prototype',
]);

/** Numeric metrics that are non-negative by definition. */
const NON_NEGATIVE_TOVA_KEYS: ReadonlySet<string> = new Set<string>([
  'age',
  'responseTimeMs',
  'variabilityMs',
  'commissionErrors',
  'omissionErrors',
]);

/** C0/C1 control characters, which are never legitimate in parsed metrics. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

function fail(errorCode: TovaValidationErrorCode, rejectionReason: string): TovaValidationResult {
  return { passed: false, errorCode, rejectionReason };
}

/**
 * Validates that a submitted TOVA payload exists, is a well-formed plain
 * object, and contains at least one recognised metric with sane values.
 */
export function verifyTovaData(tovaData: unknown): TovaValidationResult {
  // 1. Presence — TOVA is mandatory, mirroring the client's gating rule.
  if (tovaData === undefined || tovaData === null) {
    return fail('TOVA_REQUIRED', 'TOVA supporting-test data is required for a report request.');
  }

  if (typeof tovaData !== 'object' || Array.isArray(tovaData)) {
    return fail('TOVA_INVALID', 'TOVA data must be a single de-identified metrics object.');
  }

  const entries = Object.entries(tovaData as Record<string, unknown>);
  if (entries.length === 0) {
    return fail('TOVA_INVALID', 'TOVA data must contain at least one recognised metric.');
  }

  // 2. Key allow-list, prototype-pollution guard, then per-type value checks.
  for (const [key, value] of entries) {
    if (FORBIDDEN_KEYS.has(key)) {
      return fail('TOVA_INVALID', `TOVA data contains a prohibited key (${key}).`);
    }
    if (!ALLOWED_TOVA_KEYS.has(key)) {
      return fail('TOVA_INVALID', `TOVA data contains an unrecognised field (${key}).`);
    }

    if ((NUMERIC_TOVA_KEYS as readonly string[]).includes(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fail('TOVA_INVALID', `TOVA metric "${key}" must be a finite number.`);
      }
      if (Math.abs(value) > MAX_TOVA_VALUE) {
        return fail('TOVA_INVALID', `TOVA metric "${key}" is outside the accepted range.`);
      }
      if (NON_NEGATIVE_TOVA_KEYS.has(key) && value < 0) {
        return fail('TOVA_INVALID', `TOVA metric "${key}" cannot be negative.`);
      }
    } else {
      if (typeof value !== 'string') {
        return fail('TOVA_INVALID', `TOVA field "${key}" must be a string.`);
      }
      if (value.length > MAX_STRING_LENGTH) {
        return fail('TOVA_INVALID', `TOVA field "${key}" exceeds the maximum permitted length.`);
      }
      if (CONTROL_CHARS.test(value)) {
        return fail('TOVA_INVALID', `TOVA field "${key}" contains prohibited control characters.`);
      }
    }
  }

  // 3. At least one analytically meaningful metric must be present, so a
  // "verified" TOVA payload can never be an empty or contentless object.
  const hasMetric = entries.some(
    ([key, value]) =>
      REQUIRED_METRIC_KEYS.has(key) && typeof value === 'number' && Number.isFinite(value)
  );
  if (!hasMetric) {
    return fail(
      'TOVA_INVALID',
      'TOVA data must include at least one verified metric (d-prime, ADHD index score, response time, or commission/omission errors).'
    );
  }

  return { passed: true };
}
