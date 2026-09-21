-- Recurring auto-reminder tracking (Spec: 3-day download reminders for pending
-- reports). Stores the timestamp of the most recent reminder email sent for a
-- report so the sweep can anchor the next 3-day recurrence instead of re-mailing
-- every run. NULL means no reminder has ever been sent (the sweep then anchors
-- on the report's createdAt).
ALTER TABLE "QeeqReport" ADD COLUMN "lastReminderSentAt" TIMESTAMP(3);