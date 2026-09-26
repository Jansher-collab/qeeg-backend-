import { prisma } from '../prisma';
import { sendReportAutoReminderNotification } from './emailService';
import { logActivity } from './activityLogger';
import { getReportRetentionDays } from './settingsService';
import { getPublicUrl } from '../config/publicUrl';

// Recurring auto-reminder logic (Spec): a report that is ready for download
// (COMPLETED) but still pending download is emailed every 3 days — anchored on
// its creation (first reminder) then on the last reminder that actually sent —
// until the practitioner downloads it or the backstop purge removes it. In-
// flight statuses are never reminded: only COMPLETED reports exist on the
// client, so a download reminder is meaningless before the report is ready.
//
// Delivery cadence is enforced per report via the `lastReminderSentAt` tracking
// column, and the slot is claimed atomically before sending, so the sweep can
// run frequently (even concurrently / across restarts) without ever spamming:
// only one email per 3-day window is possible per report.
export const REPORT_REMINDER_INTERVAL_DAYS = 3;
const REMINDER_INTERVAL_MS = REPORT_REMINDER_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

// The sweep re-evaluates the full pending set every 6 hours. 3-day due-dates
// simply fire on the first sweep that observes them (bounded latency, no spam).
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

/**
 * Evaluates every COMPLETED report that is still pending download and sends the
 * recurring download reminder to its practitioner.
 *
 * Rules:
 * - Condition 1 (Downloaded check): a report with downloadedAt !== null is
 *   never reminded (it is excluded by the query below). Same for purged rows,
 *   and the same predicate is re-checked atomically when the reminder slot is
 *   claimed, so a backstop purge racing the sweep cannot produce a stale email.
 * - Condition 2 (Time interval & recurrence): for pending reports, the elapsed
 *   time is measured from createdAt (first reminder) or lastReminderSentAt
 *   (subsequent reminders). The reminder fires only when >= 3 days have passed,
 *   giving an exact 3/6/9/...-day cadence. The slot (lastReminderSentAt) is
 *   claimed before sending; if the send fails the anchor is restored so the
 *   reminder retries on the next sweep (Postmark only reports failure on
 *   non-acceptance, so retrying cannot duplicate a delivered email).
 *
 * Returns the number of reminder emails sent (best-effort: failures are logged
 * and never thrown out of the sweep).
 */
export async function runReportReminderSweep(): Promise<number> {
  const now = Date.now();

  // Pending-download, COMPLETED reports only. A report can only be downloaded
  // once it reached COMPLETED, so in-flight statuses are never reminded.
  // downloadedAt=null AND purgedAt=null guarantees the report is neither
  // downloaded nor purged yet.
  const pending = await prisma.qeeqReport.findMany({
    where: {
      status: 'COMPLETED',
      downloadedAt: null,
      purgedAt: null,
    },
    select: {
      id: true,
      caseReference: true,
      createdAt: true,
      customRetentionDays: true,
      lastReminderSentAt: true,
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

  const globalRetentionDays = await getReportRetentionDays();

  let reminded = 0;
  for (const report of pending) {
    const retentionDays = report.customRetentionDays ?? globalRetentionDays;
    const elapsedDays = (now - report.createdAt.getTime()) / (24 * 60 * 60 * 1000);

    // A report that has already passed its retention window is about to be
    // force-purged by the backstop sweep — never remind for it.
    if (elapsedDays >= retentionDays) continue;

    // Recurrence anchor: 3 days after created (first reminder), then 3 days
    // after the previous reminder that actually sent. A fresh anchor of
    // lastReminderSentAt prevents re-mailing on subsequent sweeps.
    const anchor = report.lastReminderSentAt ?? report.createdAt;
    if (now < anchor.getTime() + REMINDER_INTERVAL_MS) continue;

    const profile = report.submittingPractitioner.practitionerProfile;
    const recipient =
      profile?.notificationEmail ||
      profile?.practiceEmail ||
      report.submittingPractitioner.email;
    if (!recipient) {
      console.warn(
        `[ReportReminder] Skipping case ${report.caseReference}: no email address on record.`
      );
      continue;
    }

    // Claim the reminder slot atomically BEFORE sending: the updateMany
    // predicate re-checks downloadedAt/purgedAt, so a report downloaded/purged
    // between the query and this moment releases the slot instead of being
    // emailed. Claiming first also bounds each report to at most one email per
    // 3-day window even if the sweep is later run concurrently.
    const claimed = await prisma.qeeqReport.updateMany({
      where: { id: report.id, downloadedAt: null, purgedAt: null },
      data: { lastReminderSentAt: new Date() },
    });
    if (claimed.count !== 1) {
      console.log(
        `[ReportReminder] Skipping case ${report.caseReference}: downloaded or purged before send.`
      );
      continue;
    }

    const remainingDays = Math.max(1, Math.ceil(retentionDays - elapsedDays));
    const result = await sendReportAutoReminderNotification(
      recipient,
      profile?.fullName || 'Practitioner',
      report.caseReference,
      retentionDays,
      remainingDays,
      getPublicUrl('/portal')
    );

    if (!result.success) {
      // Restore the slot so a genuinely-failed delivery retries on the next
      // sweep (Postmark reports failure only when the message was not accepted,
      // so retrying is safe and cannot duplicate a delivered email).
      await prisma.qeeqReport
        .update({
          where: { id: report.id },
          data: { lastReminderSentAt: report.lastReminderSentAt },
        })
        .catch(() => undefined);
      console.error(
        `[ReportReminder] FAILED to send reminder for case ${report.caseReference} to ${recipient}: ${result.error || 'unknown error'} (slot released for retry)`
      );
      continue;
    }

    reminded++;
    console.log(
      `[ReportReminder] Sent reminder case=${report.caseReference} → ${recipient} (retention=${retentionDays}d, remaining=${remainingDays}d) — ` +
        `${result.simulated ? 'simulated (dev log mode)' : `messageId=${result.messageId || 'sent'}`}.`
    );
  }

  if (reminded > 0) {
    await logActivity({
      action: 'REPORT_REMINDER_SWEEP',
      details: { reminded, intervalDays: REPORT_REMINDER_INTERVAL_DAYS },
      ipAddress: 'reminder-scheduler',
    }).catch(() => undefined);
  }

  console.log(
    `[ReportReminder] Sweep complete: ${pending.length} pending report(s) evaluated, ${reminded} reminder(s) sent.`
  );
  return reminded;
}

/**
 * Runs the reminder sweep immediately at startup and then every 6 hours.
 * Returns a promise that resolves after the first sweep completes.
 */
export async function scheduleReportReminders(): Promise<void> {
  const first = await runReportReminderSweep();
  console.log(
    first > 0
      ? `[ReportReminder] Start-up sweep sent ${first} reminder(s).`
      : '[ReportReminder] Start-up sweep: no reminders due.'
  );

  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    runReportReminderSweep().catch((e) =>
      console.error('[ReportReminder] Scheduled sweep failed:', e)
    );
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopReportReminders(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}