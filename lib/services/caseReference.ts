import { randomInt } from 'crypto';

// Visually unambiguous alphabet (no 0/1/I/L/O), identical to the browser
// generator so client-supplied references validate without normalisation drift.
const CASE_REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CASE_REF_SUFFIX_LENGTH = 5;

export const CASE_REFERENCE_PATTERN = /^CASE-[A-Z2-9]{5}$/;

/**
 * Generates a unique, non-identifying Case Reference in the form `CASE-A73K9`.
 * Used as the server-side collision fallback when a client-supplied reference
 * is already taken.
 */
export function generateCaseReference(): string {
  let suffix = '';
  for (let i = 0; i < CASE_REF_SUFFIX_LENGTH; i++) {
    suffix += CASE_REF_ALPHABET[randomInt(CASE_REF_ALPHABET.length)];
  }
  return `CASE-${suffix}`;
}

/**
 * Validates and canonicalises a client-supplied Case Reference. Returns null
 * when the value is missing or malformed so the caller can generate one.
 */
export function normalizeCaseReference(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  return CASE_REFERENCE_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Detects a unique-constraint collision on QeeqReport.caseReference across
 * Prisma error shapes. Prisma 7 with the driver adapter reports the column
 * under meta.driverAdapterError.cause.constraint.fields rather than meta.target,
 * so both are inspected; QeeqReport currently has no other unique constraint.
 */
export function isCaseReferenceConflict(error: unknown): boolean {
  const err = error as any;
  if (err?.code !== 'P2002') return false;
  const meta = err.meta ?? {};
  const candidates: unknown[] = [];
  if (Array.isArray(meta.target)) candidates.push(...meta.target);
  else if (meta.target) candidates.push(meta.target);
  const fields = meta?.driverAdapterError?.cause?.constraint?.fields;
  if (Array.isArray(fields)) candidates.push(...fields);
  const originalMessage = meta?.driverAdapterError?.cause?.originalMessage;
  if (typeof originalMessage === 'string') candidates.push(originalMessage);
  if (candidates.some((c) => String(c).includes('caseReference'))) return true;
  return meta.modelName === 'QeeqReport';
}
