import { prisma } from '../prisma';

export const JOB_TYPES = {
  CORRELATE_AND_CAPTURE: 'CORRELATE_AND_CAPTURE',
  VOID_PAYMENT: 'VOID_PAYMENT',
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

export const JOB_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface ClaimedJob {
  id: string;
  reportId: string;
  type: string;
  attempts: number;
}

/**
 * Enqueues a ProcessingJob, de-duplicating against any job that is still
 * pending, currently claimed, or awaiting a not-yet-expired lock for the
 * same report + type combination.
 */
export async function enqueueJob(reportId: string, type: JobType): Promise<string> {
  const active = await prisma.processingJob.findFirst({
    where: {
      reportId,
      type,
      status: { in: ['PENDING', 'CLAIMED'] },
      OR: [{ lockExpiresAt: null }, { lockExpiresAt: { gt: new Date() } }],
    },
  });
  if (active) return active.id;

  const job = await prisma.processingJob.create({
    data: { reportId, type },
  });
  return job.id;
}

/**
 * Concurrency-safe claim of the next eligible job using `FOR UPDATE SKIP
 * LOCKED` inside a common-table-expression so multiple worker processes can
 * claim jobs without contention. Also reclaims jobs left in CLAIMED state by
 * a worker whose lock has expired (crashed / restarted).
 */
export async function claimNextJob(workerName: string): Promise<ClaimedJob | null> {
  const rows: ClaimedJob[] = await prisma.$queryRaw`
    WITH candidate AS (
      SELECT "id"
      FROM "ProcessingJob"
      WHERE ("status" = 'PENDING' AND "availableAt" <= NOW())
         OR ("status" = 'CLAIMED' AND "lockExpiresAt" < NOW())
      ORDER BY "availableAt" ASC, "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "ProcessingJob"
    SET "status" = 'CLAIMED',
        "claimedBy" = ${workerName},
        "attempts" = "attempts" + 1,
        "lockExpiresAt" = NOW() + (${JOB_LOCK_TTL_MS} * interval '1 millisecond')
    WHERE "id" IN (SELECT "id" FROM candidate)
    RETURNING "id", "reportId", "type", "attempts";
  `;

  return rows[0] ?? null;
}

export async function completeJob(jobId: string): Promise<void> {
  await prisma.processingJob.update({
    where: { id: jobId },
    data: { status: 'COMPLETED', lockExpiresAt: null },
  });
}

export async function failJob(jobId: string, error: unknown): Promise<void> {
  await prisma.processingJob.update({
    where: { id: jobId },
    data: {
      status: 'FAILED',
      error: String((error as any)?.message || error || 'Unknown error').slice(0, 1000),
      lockExpiresAt: null,
    },
  });
}