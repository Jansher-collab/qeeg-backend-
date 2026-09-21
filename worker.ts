import 'dotenv/config';
import os from 'os';
import { claimNextJob, completeJob, failJob } from './lib/services/jobQueue';
import { processReportGeneration, processReportVoid } from './lib/services/reportProcessor';
import { validateEnvironment, reportEnvironmentIssues } from './lib/config/env';

const envCheck = reportEnvironmentIssues(validateEnvironment());
if (envCheck.errors > 0) {
  console.error(
    `[env] Aborting worker startup: ${envCheck.errors} configuration error(s) must be resolved before running in production.`
  );
  process.exit(1);
}

const WORKER_NAME = `worker-${os.hostname()}-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS || 3000);
const MAX_ATTEMPTS = Number(process.env.WORKER_MAX_ATTEMPTS || 5);

let shuttingDown = false;

async function handleOneJob(): Promise<boolean> {
  const job = await claimNextJob(WORKER_NAME);
  if (!job) return false;

  try {
    if (job.type === 'CORRELATE_AND_CAPTURE') {
      await processReportGeneration(job.reportId);
    } else if (job.type === 'VOID_PAYMENT') {
      await processReportVoid(job.reportId);
    } else {
      throw new Error(`Unknown job type: ${job.type}`);
    }
    await completeJob(job.id);
    console.log(`[Worker] Completed job ${job.id} (${job.type}) for report ${job.reportId}`);
  } catch (error: any) {
    const terminal = job.attempts >= MAX_ATTEMPTS;
    await failJob(job.id, error?.message || 'Unknown error');
    console.error(
      `[Worker] ${terminal ? 'FAILED (permanent)' : 'Failed (will retry)'} job ${job.id} (${job.type}) for report ${job.reportId}:`,
      error?.message || error
    );
  }
  return true;
}

async function tick(): Promise<void> {
  if (shuttingDown) return;
  try {
    const didWork = await handleOneJob();
    const delay = didWork ? 250 : POLL_INTERVAL_MS;
    setTimeout(tick, delay).unref?.();
  } catch (error: any) {
    console.error('[Worker] Unexpected tick error:', error?.message || error);
    setTimeout(tick, POLL_INTERVAL_MS).unref?.();
  }
}

function shutdown(signal: string) {
  console.log(`[Worker] Received ${signal}, finishing current job then exiting...`);
  shuttingDown = true;
  setTimeout(() => {
    console.log('[Worker] Exit.');
    process.exit(0);
  }, 15_000).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(
  `[QEEG Worker] Starting ${WORKER_NAME} — poll ${POLL_INTERVAL_MS}ms, max ${MAX_ATTEMPTS} attempts/claim.`
);
void tick();

// Keep the process alive even though tick uses unref'd timeouts.
setInterval(() => {}, 1 << 30);