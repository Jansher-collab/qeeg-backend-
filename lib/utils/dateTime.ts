/**
 * Canonical local date & time formatting for outbound communications.
 *
 * Every date/time that is rendered into an outbound email, notification or
 * user-facing record must go through this module. The backend VPS runs with a
 * UTC system clock, so any bare `new Date().toLocaleString()` / `toISOString()`
 * leaks UTC into messages that practitioners read as local time — up to 11 hours
 * wrong, and wrong by a different amount depending on daylight saving.
 *
 * By default this module formats in Australia/Sydney (AEST/AEDT), the business'
 * primary operating region. Every function also accepts an optional IANA
 * `timeZone` argument so callers can render an event in the *recipient's* zone
 * (e.g. the browser timezone captured on login). An invalid or missing zone
 * always falls back to Australia/Sydney rather than throwing.
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

let SUPPORTED_ZONES: ReadonlySet<string> | null = (() => {
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      return new Set<string>(Intl.supportedValuesOf('timeZone'));
    }
  } catch {
    /* not supported */
  }
  return null;
})();

/**
 * Resolves an arbitrary caller-supplied timezone string to a usable IANA zone.
 * Returns the trimmed zone when it is a valid value the runtime's ICU knows
 * about; otherwise returns `APP_TIME_ZONE`. Never throws.
 */
export function normalizeTimeZone(timeZone?: string | null): string {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return APP_TIME_ZONE;
  const candidate = timeZone.trim();

  if (SUPPORTED_ZONES) {
    // Canonical IANA names only (e.g. "America/New_York"). Non-canonical casing
    // like "america/new_york" is rejected so displayed zones stay canonical.
    return SUPPORTED_ZONES.has(candidate) ? candidate : APP_TIME_ZONE;
  }

  // Older environments without supportedValuesOf: prove validity by
  // constructing a formatter (Intl then accepts the zone regardless of case,
  // but browser-generated values reaching this path are canonical anyway).
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: candidate });
    return candidate;
  } catch {
    return APP_TIME_ZONE;
  }
}

const DEFAULT_DATE_FMT = new Intl.DateTimeFormat('en-AU', {
  timeZone: APP_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const DEFAULT_TIME_FMT = new Intl.DateTimeFormat('en-AU', {
  timeZone: APP_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
  timeZoneName: 'short',
});

interface ZoneFormatters {
  date: Intl.DateTimeFormat;
  time: Intl.DateTimeFormat;
}

/** Lazily-built, per-zone formatter cache (default zone uses the constants). */
const ZONE_FORMATTER_CACHE = new Map<string, ZoneFormatters>();

function formattersFor(timeZone: string): ZoneFormatters {
  if (timeZone === APP_TIME_ZONE) {
    return { date: DEFAULT_DATE_FMT, time: DEFAULT_TIME_FMT };
  }
  let pair = ZONE_FORMATTER_CACHE.get(timeZone);
  if (!pair) {
    pair = {
      date: new Intl.DateTimeFormat('en-AU', {
        timeZone,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }),
      time: new Intl.DateTimeFormat('en-AU', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZoneName: 'short',
      }),
    };
    ZONE_FORMATTER_CACHE.set(timeZone, pair);
  }
  return pair;
}

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
 * The event's local calendar date in the given zone, e.g. "28/09/2026"
 * (DD/MM/YYYY). Defaults to Australia/Sydney when no timezone is supplied.
 */
export function formatLocalDate(
  value?: Date | string | number | null,
  timeZone?: string | null
): string {
  const { date } = formattersFor(normalizeTimeZone(timeZone));
  const parts = collectParts(date, toValidDate(value));
  // en-AU orders the parts day / month / year; re-join with plain "/" so the
  // shape is DD/MM/YYYY regardless of the locale's literal characters.
  return [parts.get('day'), parts.get('month'), parts.get('year')].filter(Boolean).join('/');
}

/**
 * The event's local 12-hour clock time in the given zone, e.g. "04:56 PM".
 *
 * Midnight is normalised to "12" so the well-known `hour12` → hour-24 ICU
 * quirk can never render "24:00".
 */
export function formatLocalTime(
  value?: Date | string | number | null,
  timeZone?: string | null
): string {
  return formatTime(value, timeZone, false, false);
}

/**
 * The event's local 12-hour time including the DST-aware zone abbreviation,
 * e.g. "04:56 PM AEST" / "04:56 PM AEDT". Used where proving the timezone
 * matters (security alerts), since it distinguishes the two Sydney offsets.
 */
export function formatLocalTimeWithZone(
  value?: Date | string | number | null,
  timeZone?: string | null
): string {
  return formatTime(value, timeZone, false, true);
}

function formatTime(
  value: Date | string | number | null | undefined,
  timeZone: string | null | undefined,
  withSeconds: boolean,
  withZone: boolean
): string {
  const { time } = formattersFor(normalizeTimeZone(timeZone));
  const parts = collectParts(time, toValidDate(value));
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
export function formatLocalDateTime(
  value?: Date | string | number | null,
  timeZone?: string | null
): string {
  return `${formatLocalDate(value, timeZone)} at ${formatLocalTime(value, timeZone)}`;
}

/**
 * Local date and time with the DST-aware zone, e.g.
 * "28/09/2026 at 04:56 PM AEDT".
 */
export function formatLocalDateTimeWithZone(
  value?: Date | string | number | null,
  timeZone?: string | null
): string {
  return `${formatLocalDate(value, timeZone)} at ${formatLocalTimeWithZone(value, timeZone)}`;
}

/**
 * The exact local moment an email was rendered, in the wording used by the
 * notification footers: e.g. "Sent 28/09/2026 at 04:56 PM AEDT
 * (Australia/Sydney)". Renders in the caller's timezone when supplied, with a
 * Australia/Sydney fallback.
 *
 * Callers that need to describe a *past* event rather than the send time should
 * use `formatLocalDateTime`/`formatLocalDateTimeWithZone` with that event's
 * timestamp instead of this helper.
 */
export function formatLocalTimestamp(
  value?: Date | string | number | null,
  timeZone?: string | null
): string {
  return `Sent ${formatLocalDateTimeWithZone(value, timeZone)} (${normalizeTimeZone(timeZone)})`;
}