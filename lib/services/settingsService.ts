import { prisma } from '../prisma';

export const DEFAULT_REPORT_RETENTION_DAYS = 30;
export const MIN_REPORT_RETENTION_DAYS = 1;
export const MAX_REPORT_RETENTION_DAYS = 365;
const SETTING_KEY_RETENTION = 'REPORT_RETENTION_DAYS';

/**
 * Reads the admin-configurable GLOBAL retention period: the default number of
 * days a completed report may sit un-downloaded before the backstop purge
 * deletes it. Falls back to the hard default (30 days) when unset or invalid.
 *
 * SNAPSHOT SEMANTICS: the value is captured ONCE at submission time and copied
 * onto the new report's `customRetentionDays`. Later changes to this global
 * setting only affect newly created reports — existing cases keep whatever they
 * inherited (or their explicit per-case override) and are never overwritten.
 */
export async function getReportRetentionDays(): Promise<number> {
  try {
    const setting = await prisma.systemSettings.findUnique({
      where: { key: SETTING_KEY_RETENTION },
    });
    if (setting) {
      const parsed = parseInt(setting.value, 10);
      if (
        !Number.isNaN(parsed) &&
        parsed >= MIN_REPORT_RETENTION_DAYS &&
        parsed <= MAX_REPORT_RETENTION_DAYS
      ) {
        return parsed;
      }
    }
  } catch (error) {
    console.warn('Failed to read report retention from system settings, using default', error);
  }
  return DEFAULT_REPORT_RETENTION_DAYS;
}

/**
 * Persists the admin-configured global retention period. The caller validates
 * the range so the stored value is always sane. The value is snapshotted onto
 * each new report at submission time (see getReportRetentionDays).
 */
export async function setReportRetentionDays(days: number): Promise<number> {
  await prisma.systemSettings.upsert({
    where: { key: SETTING_KEY_RETENTION },
    update: { value: String(days), updatedAt: new Date() },
    create: {
      key: SETTING_KEY_RETENTION,
      value: String(days),
      description:
        'Global default retention in days, snapshotted onto each new report at submission time',
    },
  });
  return days;
}