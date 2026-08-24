import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type { NextFunction, Request, Response } from 'express';
import type { HydratedDocument, Types } from 'mongoose';
import * as OTPAuth from 'otpauth';
import { OperatorModel, SessionModel, type OperatorDoc, type SessionDoc } from '../db/models/index.js';
import { ApiError } from './errors.js';
import { hashToken, looksLikeToken, mintToken } from './tokens.js';
import { hashIp } from '../config/consent.js';
import { loadEnv } from '../config/env.js';
import { AUDIT, recordAudit } from './audit.js';
import { HOUR_MS, enforceRateLimit } from './rate-limit.js';
import { clientIp, userAgentOf } from './creator-session.js';

/**
 * Operator authentication.
 *
 * This account can read every creator's private analytics, so: Argon2id for
 * passwords, TOTP required rather than optional, short sessions, and a fresh
 * password check before anything bulk.
 *
 * No homegrown crypto anywhere — @node-rs/argon2 for hashing, otpauth for TOTP.
 */

export const OPERATOR_COOKIE = 'anton_operator_session';

/**
 * OWASP's recommended Argon2id floor: 19 MiB, 2 iterations, 1 degree of
 * parallelism. Deliberately not tuned lower to speed up the test suite; a
 * weaker hash in development is a weaker hash nobody notices in production.
 */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export interface OperatorSession {
  readonly session: HydratedDocument<SessionDoc>;
  readonly operator: HydratedDocument<OperatorDoc>;
}

declare module 'express-serve-static-core' {
  interface Request {
    operatorSession?: OperatorSession;
  }
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2Hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(hashValue: string, plain: string): Promise<boolean> {
  try {
    return await argon2Verify(hashValue, plain);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------- TOTP */

export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function totpUri(email: string, secret: string): string {
  return new OTPAuth.TOTP({
    issuer: 'Anton',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  }).toString();
}

/**
 * Validates a TOTP code with a one-step window either side, which absorbs
 * ordinary clock drift between the phone and the server without widening the
 * window enough to matter.
 */
export function verifyTotp(secret: string, code: string): boolean {
  if (!/^\d{6}$/.test(code.trim())) return false;
  const totp = new OTPAuth.TOTP({
    issuer: 'Anton',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  return totp.validate({ token: code.trim(), window: 1 }) !== null;
}

/** Recovery codes, shown once at enrolment and stored only as hashes. */
export async function generateRecoveryCodes(count = 8): Promise<{
  plain: string[];
  hashes: string[];
}> {
  const plain = Array.from({ length: count }, () =>
    randomBytes(5).toString('hex').match(/.{1,5}/g)?.join('-') ?? randomBytes(5).toString('hex'),
  );
  const hashes = await Promise.all(plain.map((code) => argon2Hash(code, ARGON2_OPTIONS)));
  return { plain, hashes };
}

/** Consumes a recovery code. Single-use: a match removes it from the account. */
export async function consumeRecoveryCode(
  operatorId: Types.ObjectId,
  candidate: string,
): Promise<boolean> {
  const operator = await OperatorModel.findById(operatorId).select('+recoveryCodeHashes');
  if (!operator) return false;
  const normalised = candidate.trim().toLowerCase();

  for (const stored of operator.recoveryCodeHashes) {
    if (await verifyPassword(stored, normalised)) {
      await OperatorModel.updateOne(
        { _id: operatorId },
        { $pull: { recoveryCodeHashes: stored } },
      );
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ login */

export interface LoginResult {
  readonly operator: HydratedDocument<OperatorDoc>;
  readonly session: HydratedDocument<SessionDoc>;
}

/**
 * Password plus TOTP, in one step.
 *
 * Deliberately not a two-request flow with an intermediate "password was
 * correct" token: that intermediate state is itself a credential to protect,
 * and a single step gives an attacker no oracle telling them the password was
 * right but the code was wrong.
 */
export async function loginOperator(
  req: Request,
  res: Response,
  credentials: { email: string; password: string; totpCode: string; recoveryCode?: string | undefined },
): Promise<LoginResult> {
  const env = loadEnv();
  const ipHash = hashIp(clientIp(req));

  await enforceRateLimit(
    { bucket: 'operator_login_ip', subject: ipHash, limit: 10, windowMs: HOUR_MS },
    'Too many sign-in attempts. Wait an hour.',
  );

  const operator = await OperatorModel.findOne({ email: credentials.email.toLowerCase().trim() })
    .select('+passwordHash +totpSecret');

  // Uniform failure for every reason. A distinct "no such account" would let
  // anyone enumerate who has operator access.
  const genericFailure = ApiError.unauthorized('invalid_credentials', 'Email, password or code is incorrect.');

  if (!operator) {
    // Burn comparable time so absence is not detectable by response latency.
    await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', credentials.password);
    await recordAudit({
      actorKind: 'system',
      actorLabel: credentials.email,
      action: AUDIT.operatorLoginFailed,
      detail: { reason: 'unknown_account' },
      ipHash,
    });
    throw genericFailure;
  }

  if (operator.lockedUntil && operator.lockedUntil.getTime() > Date.now()) {
    throw ApiError.forbidden(
      'account_locked',
      `Too many failed attempts. Locked until ${operator.lockedUntil.toISOString()}.`,
    );
  }

  const passwordOk = await verifyPassword(operator.passwordHash, credentials.password);

  let secondFactorOk = false;
  if (operator.totpSecret && operator.totpEnrolledAt) {
    secondFactorOk = verifyTotp(operator.totpSecret, credentials.totpCode);
    if (!secondFactorOk && credentials.recoveryCode) {
      secondFactorOk = await consumeRecoveryCode(operator._id, credentials.recoveryCode);
    }
  }

  if (!passwordOk || !secondFactorOk) {
    const failed = operator.failedLoginCount + 1;
    await OperatorModel.updateOne(
      { _id: operator._id },
      {
        $set: {
          failedLoginCount: failed,
          ...(failed >= MAX_FAILED_LOGINS
            ? { lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000) }
            : {}),
        },
      },
    );
    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.operatorLoginFailed,
      detail: { passwordOk, secondFactorOk, failedCount: failed },
      ipHash,
    });
    throw genericFailure;
  }

  // TOTP is required, not optional. An operator without it cannot sign in at
  // all — there is no "set it up later" path that leaves the account weaker in
  // the meantime.
  if (!operator.totpEnrolledAt) {
    throw ApiError.forbidden(
      'totp_enrolment_required',
      'Two-factor authentication must be set up before this account can be used.',
    );
  }

  const now = new Date();
  const ttlMs = env.OPERATOR_SESSION_TTL_HOURS * HOUR_MS;
  const { raw, hash } = mintToken();

  const session = await SessionModel.create({
    tokenHash: hash,
    subjectKind: 'operator',
    creatorId: null,
    operatorId: operator._id,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
    lastSeenAt: now,
    lastReauthAt: now,
    ipHash,
    userAgent: userAgentOf(req),
  });

  await OperatorModel.updateOne(
    { _id: operator._id },
    { $set: { lastLoginAt: now, failedLoginCount: 0, lockedUntil: null } },
  );

  res.cookie(OPERATOR_COOKIE, raw, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    // strict, unlike the creator cookie: an operator never arrives by tapping a
    // link from elsewhere, so there is no cross-site entry to accommodate.
    sameSite: 'strict',
    maxAge: ttlMs,
    path: '/',
  });

  await recordAudit({
    actorKind: 'operator',
    actorId: operator._id,
    actorLabel: operator.email,
    action: AUDIT.operatorLogin,
    ipHash,
  });

  return { operator, session };
}

/* --------------------------------------------------------------- middleware */

export async function resolveOperatorSession(req: Request): Promise<OperatorSession> {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
  const raw = cookies[OPERATOR_COOKIE];
  if (!raw || !looksLikeToken(raw)) {
    throw ApiError.unauthorized('no_session', 'Sign in to continue.');
  }

  const session = await SessionModel.findOne({ tokenHash: hashToken(raw), subjectKind: 'operator' });
  if (!session) throw ApiError.unauthorized('no_session', 'Sign in to continue.');
  if (session.revokedAt) throw ApiError.unauthorized('session_revoked', 'This session was ended.');
  if (session.expiresAt.getTime() <= Date.now()) {
    throw ApiError.unauthorized('session_expired', 'Your session has timed out. Sign in again.');
  }

  const operator = await OperatorModel.findById(session.operatorId);
  if (!operator) throw ApiError.unauthorized('no_session', 'Sign in to continue.');

  return { session, operator };
}

export function requireOperator(req: Request, _res: Response, next: NextFunction): void {
  resolveOperatorSession(req)
    .then(async (resolved) => {
      req.operatorSession = resolved;
      if (Date.now() - resolved.session.lastSeenAt.getTime() > 60_000) {
        await SessionModel.updateOne(
          { _id: resolved.session._id },
          { $set: { lastSeenAt: new Date() } },
        ).catch(() => undefined);
      }
      next();
    })
    .catch(next);
}

/**
 * Guards bulk export and bulk deletion. A session that has been open all day is
 * not evidence that the person at the keyboard is still the operator.
 */
export function requireFreshReauth(req: Request, _res: Response, next: NextFunction): void {
  const resolved = req.operatorSession;
  if (!resolved) {
    next(ApiError.unauthorized('no_session', 'Sign in to continue.'));
    return;
  }
  const windowMs = loadEnv().OPERATOR_REAUTH_WINDOW_MINUTES * 60_000;
  const last = resolved.session.lastReauthAt?.getTime() ?? 0;
  if (Date.now() - last > windowMs) {
    next(
      ApiError.forbidden(
        'reauth_required',
        'Confirm your password before exporting or deleting in bulk.',
      ),
    );
    return;
  }
  next();
}

/** Re-checks the password and stamps the session. */
export async function reauthenticate(req: Request, password: string): Promise<void> {
  const resolved = req.operatorSession;
  if (!resolved) throw ApiError.unauthorized('no_session', 'Sign in to continue.');

  const withHash = await OperatorModel.findById(resolved.operator._id).select('+passwordHash');
  if (!withHash || !(await verifyPassword(withHash.passwordHash, password))) {
    throw ApiError.unauthorized('invalid_credentials', 'That password is not correct.');
  }

  await SessionModel.updateOne({ _id: resolved.session._id }, { $set: { lastReauthAt: new Date() } });
  await recordAudit({
    actorKind: 'operator',
    actorId: resolved.operator._id,
    actorLabel: resolved.operator.email,
    action: AUDIT.operatorReauth,
    ipHash: hashIp(clientIp(req)),
  });
}

export function getOperator(req: Request): OperatorSession {
  const resolved = req.operatorSession;
  if (!resolved) throw ApiError.unauthorized('no_session', 'Sign in to continue.');
  return resolved;
}

export function clearOperatorCookie(res: Response): void {
  res.clearCookie(OPERATOR_COOKIE, { path: '/' });
}

/** Constant-time string compare, for anything not covered by argon2. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
