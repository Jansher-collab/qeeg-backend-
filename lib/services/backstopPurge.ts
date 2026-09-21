import { prisma } from '../prisma';
import { logActivity } from './activityLogger';
import { executePurgeOnDownload } from './purgeService';
import {
  DEFAULT_REPORT_RETENTION_DAYS,
  MIN_REPORT_RETENTION_DAYS,
} from './settingsService';

// Legacy default window (days). The sweep applies each report's own custom
// retention value from its approval, falling back to this hard default when a
// report has no explicit customRetentionDays set.
export const BACKSTOP_RETENTION_DAYS = DEFAULT_REPORT_RETENTION_DAYS;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

let timer: NodeJS.Timeout | null = null;

/**
 * Zero-retention backstop (Spec 4.3g): any report that reached COMPLETED and
 * was never downloaded (and therefore never purge-on-downloaded) is force
 * purged after its retention window. The window is the per-report custom
 * value chosen at approval, or the hardcoded default (30 days) when none was
 * set. Reviews the whole completed set rather than tracking per-report timers
 * so crashes/restarts cannot leak data.
 */
export async function runBackstopPurgeSweep(): Promise<number> {
  // Find reports that may be eligible for purge:
  // - COMPLETED status
  // - Not yet purged (purgedAt is null)
  // - Created at least a full day ago (a safety floor: the shortest possible
  //   retention window is 1 day, so nothing younger can ever be expired)
  // We'll then check each report's own retention window individually.
  const staleReports = await prisma.qeeqReport.findMany({
    where: {
      status: 'COMPLETED',
      purgedAt: null,
      createdAt: { lt: new Date(Date.now() - MIN_REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000) },
    },
    take: 100,
  });

  let purged = 0;
  for (const report of staleReports) {
    // Effective retention days for this report: its own custom value when one
    // was set during approval, otherwise the hardcoded default (30 days).
    const effectiveRetentionDays = report.customRetentionDays ?? DEFAULT_REPORT_RETENTION_DAYS;
    const reportCutoff = new Date(Date.now() - effectiveRetentionDays * 24 * 60 * 60 * 1000);

    // Check if this specific report has exceeded its retention window
    if (report.createdAt >= reportCutoff) {
      // Not yet expired for its retention period
      continue;
    }

    try {
      await executePurgeOnDownload(report.id, report.submittingPractitionerId, 'backstop-scheduler');
      purged++;
      console.log(
        `[BackstopPurge] Forced purge of stale report ${report.id} (case=${report.caseReference}, retention=${effectiveRetentionDays}d).`
      );
    } catch (error: any) {
      console.error(`[BackstopPurge] Failed to purge report ${report.id}:`, error?.message || error);
    }
  }

  if (purged > 0) {
    await logActivity({
      action: 'BACKSTOP_PURGE_SWEEP',
      details: { purged },
      ipAddress: 'backstop-scheduler',
    }).catch(() => undefined);
  }

  return purged;
}

/**
 * Runs the backstop sweep immediately at startup and then every 24 hours.
 * Returns a promise that resolves after the first sweep completes.
 */
export async function scheduleBackstopPurge(): Promise<void> {
  const first = await runBackstopPurgeSweep();
  if (first > 0) {
    console.log(`[BackstopPurge] Start-up sweep purged ${first} stale report(s).`);
  } else {
    console.log('[BackstopPurge] Start-up sweep: no stale reports to purge.');
  }

  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    runBackstopPurgeSweep().catch((e) =>
      console.error('[BackstopPurge] Scheduled sweep failed:', e)
    );
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopBackstopPurge(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}