/**
 * Canonical Australia/Sydney (AEST/AEDT) date & time formatting.
 *
 * Every date/time that is rendered into an outbound email, notification or
 * user-facing record must go through this module. The backend VPS runs with a
 * UTC system clock, so any bare `new Date().toLocaleString()` / `toISOString()`
 * leaks UTC into messages that practitioners read as local time — up to 11 hours
 * wrong, and wrong by a different amount depending on daylight saving.
 *
 * Format is assembled from `Intl.DateTimeFormat#formatToParts` rather than
 * `format()` so the output is deterministic across Node/ICU versions. This is
 * deliberate: `en-AU` currently renders "04:56 pm" and separates the meridiem
 * with U+202F (narrow no-break space), but the literal and casing are ICU
 * details that vary by version and render inconsistently in mail clients. The
 * reconstruction below pins "04:56 PM" with plain ASCII spaces.
 */

/** IANA zone for the business' primary operating region (ap-southeast-2). */
export const APP_TIME_ZONE = 'Australia/Sydney';

function toValidDate(value?: Date | string | number | null): Date {
  if (value === undefined || value === null) return new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(
      `formatLocal*: expected a valid date, received ${JSON.stringify(String(value))}`
    );
  }
  return date;
}

const DATE_PARTS_FMT = new Intl.DateTimeFormat('en-AU', {
  timeZone: APP_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const TIME_PARTS_FMT = new Intl.DateTimeFormat('en-AU', {
  timeZone: APP_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
  timeZoneName: 'short',
});

function collectParts(formatter: Intl.DateTimeFormat, value: Date): Map<string, string> {
  const parts = new Map<string, string>();
  for (const part of formatter.formatToParts(value)) {
    if (part.type !== 'literal' && !parts.has(part.type)) {
      parts.set(part.type, part.value);
    }
  }
  return parts;
}

/**
 * The event's local calendar date, e.g. "28/09/2026" (DD/MM/YYYY).
 */
export function formatLocalDate(value?: Date | string | number | null): string {
  const parts = collectParts(DATE_PARTS_FMT, toValidDate(value));
  // en-AU orders the parts day / month / year; re-join with plain "/" so the
  // shape is DD/MM/YYYY regardless of the locale's literal characters.
  return [parts.get('day'), parts.get('month'), parts.get('year')].filter(Boolean).join('/');
}

/**
 * The event's local 12-hour clock time, e.g. "04:56 PM".
 *
 * Midnight is normalised to "12" so the well-known `hour12` → hour-24 ICU
 * quirk can never render "24:00".
 */
export function formatLocalTime(value?: Date | string | number | null): string {
  return formatTime(value, false, false);
}

/**
 * The event's local 12-hour time including the DST-aware zone abbreviation,
 * e.g. "04:56 PM AEST" / "04:56 PM AEDT". Used where proving the timezone
 * matters (security alerts), since it distinguishes the two Sydney offsets.
 */
export function formatLocalTimeWithZone(value?: Date | string | number | null): string {
  return formatTime(value, false, true);
}

function formatTime(
  value: Date | string | number | null | undefined,
  withSeconds: boolean,
  withZone: boolean
): string {
  const parts = collectParts(TIME_PARTS_FMT, toValidDate(value));
  const rawHour = parts.get('hour') || '00';
  const hour = rawHour === '24' ? '12' : rawHour;
  const meridiem = (parts.get('dayPeriod') || '').toUpperCase();

  let out = `${hour}:${parts.get('minute') || '00'}`;
  if (withSeconds) out += `:${parts.get('second') || '00'}`;
  if (meridiem) out += ` ${meridiem}`;
  if (withZone) {
    const zone = parts.get('timeZoneName');
    if (zone) out += ` ${zone}`;
  }
  return out;
}

/**
 * Local date and time together, e.g. "28/09/2026 at 04:56 PM".
 */
export function formatLocalDateTime(value?: Date | string | number | null): string {
  return `${formatLocalDate(value)} at ${formatLocalTime(value)}`;
}

/**
 * Local date and time with the DST-aware zone, e.g.
 * "28/09/2026 at 04:56 PM AEDT".
 */
export function formatLocalDateTimeWithZone(
  value?: Date | string | number | null
): string {
  return `${formatLocalDate(value)} at ${formatLocalTimeWithZone(value)}`;
}

/**
 * The exact local moment an email was rendered, in the wording used by the
 * notification footers: e.g. "Sent 28/09/2026 at 04:56 PM AEDT (Australia/Sydney)".
 *
 * Callers that need to describe a *past* event rather than the send time should
 * use `formatLocalDateTime`/`formatLocalDateTimeWithZone` with that event's
 * timestamp instead of this helper.
 */
export function formatLocalTimestamp(value?: Date | string | number | null): string {
  return `Sent ${formatLocalDateTimeWithZone(value)} (${APP_TIME_ZONE})`;
}
