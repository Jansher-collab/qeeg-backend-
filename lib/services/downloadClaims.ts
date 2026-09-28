/**
 * In-process serialisation for the two-phase report download protocol.
 *
 * Phase 1 (GET /api/reports/:id/download) no longer purges the report:
 * it claims the report so findings can be served to exactly one downloader,
 * and the client renders/stamps the PDF in-browser. Phase 2
 * (POST /api/reports/:id/download/complete) finalises the purge and releases
 * the claim. A claim is an ephemeral, in-process Map entry with a TTL — never
 * persisted, so the zero-retention policy is unaffected.
 *
 * The same claimant may re-claim instantly (retry after a client-side render
 * failure); a different claimant receives 409 until the claim expires or the
 * report is purged.
 */

type DownloadClaim = {
  claimant: string;
  expiresAt: number;
};

const claims = new Map<string, DownloadClaim>();

// Long enough for a practitioner to finish a download/retry, short enough that
// an abandoned (crash/close) claim cannot block an owner for long.
export const CLAIM_TTL_MS = 10 * 60 * 1000;

export type Claimant = string;

export function claimantKey(userId?: string | null, token?: string | null): Claimant {
  if (userId) return `user:${userId}`;
  if (token) return `token:${token}`;
  return 'anonymous';
}

function liveClaim(reportId: string): DownloadClaim | undefined {
  const claim = claims.get(reportId);
  if (!claim) return undefined;
  if (claim.expiresAt <= Date.now()) {
    claims.delete(reportId);
    return undefined;
  }
  return claim;
}

export type ClaimResult = 'claimed' | 'retry' | 'busy';

/** Claims the report for this claimant, or reports the claim state. */
export function tryClaim(reportId: string, claimant: Claimant): ClaimResult {
  const claim = liveClaim(reportId);
  const now = Date.now();
  if (!claim) {
    claims.set(reportId, { claimant, expiresAt: now + CLAIM_TTL_MS });
    return 'claimed';
  }
  if (claim.claimant === claimant) {
    // Refresh the claim window for same-claimant retries.
    claims.set(reportId, { claimant, expiresAt: now + CLAIM_TTL_MS });
    return 'retry';
  }
  return 'busy';
}

/** Releases the claim (after a completed purge or an aborted phase 1). */
export function releaseClaim(reportId: string): void {
  claims.delete(reportId);
}