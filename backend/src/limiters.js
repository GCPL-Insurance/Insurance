import rateLimit from 'express-rate-limit';

// Auth endpoints (login/signup) — only failed requests count toward the cap.
// This prevents brute-force attacks while not penalising successful logins.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again later.' },
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
});

// Enrollment endpoints need a generous limit — employees draft-save multiple
// times before submitting. 200/15min is enough to never block normal usage.
export const enrollmentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many enrollment requests. Please wait a moment and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});
