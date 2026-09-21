import 'dotenv/config';

export type EnvIssueLevel = 'error' | 'warn';

export interface EnvIssue {
  level: EnvIssueLevel;
  key: string;
  message: string;
}

// Known insecure built-in fallbacks that must never be used in production.
const INSECURE_JWT_FALLBACK = 'qeeg-sydney-secure-jwt-secret-2026-production';

function isBlank(value: string | undefined): boolean {
  return !value || value.trim() === '';
}

/**
 * Validates the process environment at startup. In development every issue is
 * a warning (so local runs always boot); in production an `error`-level issue
 * aborts startup so a misconfigured deploy can never run with mock payments,
 * an insecure signing secret, or email silently disabled.
 */
export function validateEnvironment(env: NodeJS.ProcessEnv = process.env): EnvIssue[] {
  const issues: EnvIssue[] = [];
  const isProduction = env.NODE_ENV === 'production';

  const missing = (key: string, message: string) => {
    issues.push({ level: isProduction ? 'error' : 'warn', key, message });
  };

  if (isBlank(env.DATABASE_URL)) {
    missing(
      'DATABASE_URL',
      'Not set — a hardcoded fallback connection string is being used. Set DATABASE_URL to your own database.'
    );
  }

  if (isBlank(env.JWT_SECRET) || env.JWT_SECRET === INSECURE_JWT_FALLBACK) {
    missing(
      'JWT_SECRET',
      'Missing or set to the insecure built-in fallback — set a long random value before going live.'
    );
  }

  const payPalMode = (env.PAYPAL_MODE || 'sandbox').toLowerCase();
  const payPalLive = payPalMode === 'live' || payPalMode === 'production';

  if (payPalLive) {
    if (isBlank(env.PAYPAL_CLIENT_ID) || isBlank(env.PAYPAL_SECRET)) {
      missing(
        'PAYPAL_CLIENT_ID',
        'PAYPAL_MODE=live requires both PAYPAL_CLIENT_ID and PAYPAL_SECRET. Set the production credentials (or switch back to sandbox) — otherwise no real payments are captured.'
      );
    }
    if (isProduction && isBlank(env.PAYPAL_CLIENT_ID)) {
      issues.push({
        level: 'error',
        key: 'PAYPAL_MODE',
        message: 'PAYPAL_MODE=live in production requires PAYPAL_CLIENT_ID to be set.',
      });
    }
  } else {
    const hasSandboxCreds =
      !isBlank(env.PAYPAL_SANDBOX_CLIENT_ID) && !isBlank(env.PAYPAL_SANDBOX_SECRET);
    const hasBaseCreds = !isBlank(env.PAYPAL_CLIENT_ID) && !isBlank(env.PAYPAL_SECRET);
    if (!hasSandboxCreds && !hasBaseCreds) {
      issues.push({
        level: isProduction ? 'error' : 'warn',
        key: 'PAYPAL_SANDBOX_CLIENT_ID',
        message:
          'Sandbox mode has no PayPal credentials — set PAYPAL_SANDBOX_CLIENT_ID/PAYPAL_SANDBOX_SECRET (or PAYPAL_CLIENT_ID/PAYPAL_SECRET). PayPal runs in mock mode; no real payments are captured.',
      });
    }
    if (isProduction) {
      issues.push({
        level: 'error',
        key: 'PAYPAL_MODE',
        message:
          'PAYPAL_MODE must be "live" in production — sandbox mode cannot capture real payments. Set PAYPAL_MODE=live and the production PAYPAL_CLIENT_ID/PAYPAL_SECRET.',
      });
    }
  }

  if (isBlank(env.ANTHROPIC_API_KEY)) {
    issues.push({
      level: 'warn',
      key: 'ANTHROPIC_API_KEY',
      message:
        'Not set — knowledge-base ingestion uses the heuristic fallback and report synthesis is excerpt-only.',
    });
  } else if (isBlank(env.ANTHROPIC_MODEL)) {
    issues.push({
      level: 'warn',
      key: 'ANTHROPIC_MODEL',
      message: 'ANTHROPIC_API_KEY is set but ANTHROPIC_MODEL is missing — AI calls will fall back to heuristics.',
    });
  }

  if (isBlank(env.POSTMARK_SERVER_TOKEN)) {
    issues.push({
      level: isProduction ? 'error' : 'warn',
      key: 'POSTMARK_SERVER_TOKEN',
      message: 'Not set — outbound email is disabled (logged only). Set the token from your Postmark server.',
    });
  }
  if (isBlank(env.FROM_EMAIL)) {
    issues.push({
      level: 'warn',
      key: 'FROM_EMAIL',
      message: "Not set — falling back to 'admin@qeeg.com.au'. Use a Postmark-verified sender address.",
    });
  }

  return issues;
}

/**
 * Prints a startup configuration summary and returns the error/warning counts.
 */
export function reportEnvironmentIssues(
  issues: EnvIssue[],
  logger: Pick<Console, 'log' | 'warn' | 'error'> = console
): { errors: number; warnings: number } {
  if (issues.length === 0) {
    logger.log('[env] Configuration looks good.');
    return { errors: 0, warnings: 0 };
  }
  for (const issue of issues) {
    const line = `[env] ${issue.level.toUpperCase()} ${issue.key}: ${issue.message}`;
    if (issue.level === 'error') logger.error(line);
    else logger.warn(line);
  }
  const errors = issues.filter((i) => i.level === 'error').length;
  return { errors, warnings: issues.length - errors };
}
