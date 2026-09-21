import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

const isProduction = process.env.NODE_ENV === 'production';

// General limiter for auth endpoints (login, signup, forgot/reset password).
// Looser in development to avoid friction during local testing.
export const authRateLimit = rateLimit({
  windowMs: isProduction ? 15 * 60 * 1000 : 1 * 60 * 1000, // 15 min (prod) / 1 min (dev)
  limit: isProduction ? 20 : 100, // per window
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  message: { error: 'Too many authentication attempts. Please try again later.' },
});

// Stricter limiter for password-reset / 2FA challenge endpoints where
// enumeration and brute-force are the primary threat.
export const sensitiveAuthRateLimit = rateLimit({
  windowMs: isProduction ? 15 * 60 * 1000 : 1 * 60 * 1000,
  limit: isProduction ? 5 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

// Limiter for report submission & payment-authorization endpoints.
export const submitRateLimit = rateLimit({
  windowMs: isProduction ? 15 * 60 * 1000 : 1 * 60 * 1000,
  limit: isProduction ? 30 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again later.' },
});

// Trusted proxy estimate for accurate client IP detection behind a VPS/LB.
export function clientIpFrom(req: Request): string | undefined {
  return req.ip || req.socket?.remoteAddress;
}