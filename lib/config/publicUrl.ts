/**
 * Canonical public application URL.
 *
 * This is deliberately NOT the same value as `FRONTEND_URL`. `FRONTEND_URL` is
 * the CORS origin for the browser-facing app and is dev-oriented by default
 * (`http://localhost:3000`, and `http://vps.qeeg.com.au:3000` on the VPS),
 * so it must never be used to build links that leave the system — email
 * buttons, one-time collection links and password-reset links all have to
 * resolve to the public HTTPS domain regardless of which origin the API is
 * currently serving.
 */
const DEFAULT_PUBLIC_BASE_URL = 'https://qeeg.com.au';

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * The public base URL, e.g. `https://qeeg.com.au`. Falls back to the
 * production domain so a deployment that never sets `APP_BASE_URL` still
 * emits correct public links.
 */
export function getPublicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.APP_BASE_URL?.trim();
  if (!configured) return DEFAULT_PUBLIC_BASE_URL;
  return stripTrailingSlashes(configured);
}

/**
 * Builds an absolute public URL for `path` (a leading slash is optional).
 * Prefer this over string concatenation so every outbound link goes through
 * the same audited source of truth.
 */
export function getPublicUrl(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = getPublicBaseUrl(env);
  if (!path) return base;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Returns a human-readable problem description if the configured public URL is
 * unsuitable for links that are emailed to real users, otherwise null.
 */
export function getPublicBaseUrlProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = getPublicBaseUrl(env);
  const isExplicitlyConfigured = Boolean(env.APP_BASE_URL?.trim());

  if (!/^https:\/\//i.test(base)) {
    return `APP_BASE_URL resolves to "${base}" which is not HTTPS — links sent by email (including one-time report collection and password reset) would be sent over plain HTTP. Set APP_BASE_URL to your public https:// domain.`;
  }

  if (/(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(base)) {
    return `APP_BASE_URL resolves to the local address "${base}" — recipients cannot open it. Set APP_BASE_URL to your public https:// domain.`;
  }

  if (/:\d{2,5}(\/|$)/.test(base)) {
    return `APP_BASE_URL resolves to "${base}" which includes an explicit port — the public domain normally serves 80/443. Emailed links would expose a non-standard port.`;
  }

  if (!isExplicitlyConfigured) {
    return `APP_BASE_URL is not set — falling back to the built-in default "${DEFAULT_PUBLIC_BASE_URL}". Set APP_BASE_URL explicitly so email links are auditable.`;
  }

  return null;
}
