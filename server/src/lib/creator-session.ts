import type { NextFunction, Request, Response } from 'express';
import type { HydratedDocument } from 'mongoose';
import {
  CreatorModel,
  MagicLinkModel,
  SessionModel,
  isMagicLinkUsable,
  type CreatorDoc,
  type SessionDoc,
} from '../db/models/index.js';
import { ApiError } from './errors.js';
import { hashToken, looksLikeToken, mintToken } from './tokens.js';
import { hashIp } from '../config/consent.js';
import { loadEnv } from '../config/env.js';
import { AUDIT, recordAudit } from './audit.js';
import { DAY_MS, HOUR_MS, enforceRateLimit } from './rate-limit.js';

/**
 * Creator authentication.
 *
 * A magic link is an *exchange* token, not a credential: short-lived,
 * single-use, and swapped once for an httpOnly session cookie. The working
 * assumption is that every link ends up in a group chat, so the window in
 * which a forwarded link is useful is minutes, and the first tap spends it.
 *
 * The session cookie is httpOnly (no script can read it), secure in
 * production, and sameSite=lax. There is no bearer token in JavaScript at all,
 * so an XSS in the creator app cannot exfiltrate a durable credential.
 */

export const CREATOR_COOKIE = 'anton_creator_session';

export interface CreatorSession {
  readonly session: HydratedDocument<SessionDoc>;
  readonly creator: HydratedDocument<CreatorDoc>;
}

declare module 'express-serve-static-core' {
  interface Request {
    creatorSession?: CreatorSession;
  }
}

export function clientIp(req: Request): string {
  return req.ip ?? '0.0.0.0';
}

export function userAgentOf(req: Request): string {
  return (req.header('user-agent') ?? '').slice(0, 400);
}

function cookieOptions(maxAgeMs: number): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  maxAge: number;
  path: string;
} {
  return {
    httpOnly: true,
    secure: loadEnv().NODE_ENV === 'production',
    // lax rather than strict: the creator arrives by tapping a link in
    // WhatsApp, and strict would drop the cookie on that first cross-site
    // navigation. There is no cookie-authenticated state-changing GET here,
    // so lax gives up nothing that matters.
    sameSite: 'lax',
    maxAge: maxAgeMs,
    path: '/',
  };
}

/**
 * Exchanges a magic-link token for a session. Rate limited per IP and per
 * creator, because this endpoint is the one place an attacker with a guessed
 * or scraped token would hammer.
 */
export async function exchangeMagicLink(
  req: Request,
  res: Response,
  rawToken: string,
): Promise<CreatorSession> {
  const env = loadEnv();
  const ipHash = hashIp(clientIp(req));

  await enforceRateLimit(
    {
      bucket: 'token_exchange_ip',
      subject: ipHash,
      limit: env.RATE_LIMIT_TOKEN_EXCHANGE_PER_IP_HOUR,
      windowMs: HOUR_MS,
    },
    'Too many attempts from this connection. Wait an hour and try again.',
  );

  if (!looksLikeToken(rawToken)) {
    throw ApiError.unauthorized('invalid_link', 'This link is not valid.');
  }

  const link = await MagicLinkModel.findOne({ tokenHash: hashToken(rawToken) });
  if (!link) {
    throw ApiError.unauthorized('invalid_link', 'This link is not valid.');
  }

  await enforceRateLimit(
    {
      bucket: 'token_exchange_creator',
      subject: link.creatorId.toString(),
      limit: env.RATE_LIMIT_TOKEN_EXCHANGE_PER_CREATOR_HOUR,
      windowMs: HOUR_MS,
    },
    'Too many attempts on this account. Wait an hour and try again.',
  );

  const usable = isMagicLinkUsable(
    { expiresAt: link.expiresAt, revokedAt: link.revokedAt ?? null, usedAt: link.usedAt ?? null },
    new Date(),
  );
  if (!usable.ok) {
    // Each reason gets its own code so the app can offer the right next step:
    // a fresh link for expired, a warning for already-used.
    const messages: Record<string, string> = {
      expired: 'This link has expired. Links last 15 minutes for your safety — ask for a new one.',
      already_used:
        'This link has already been opened. If that was not you, tell us in the community — links are personal and work only once.',
      revoked: 'This link has been cancelled. Ask in the community for a new one.',
    };
    throw ApiError.gone(`link_${usable.reason}`, messages[usable.reason] ?? 'This link is no longer valid.');
  }

  const creator = await CreatorModel.findById(link.creatorId);
  if (!creator) throw ApiError.notFound('creator_not_found', 'This account no longer exists.');
  if (creator.status === 'removed') {
    throw ApiError.gone('creator_removed', 'This account has been removed at your request.');
  }

  // Spend the link atomically. The filter re-checks usedAt so two simultaneous
  // taps of the same forwarded link cannot both mint a session.
  const spent = await MagicLinkModel.findOneAndUpdate(
    { _id: link._id, usedAt: null },
    { $set: { usedAt: new Date(), firstOpenedAt: link.firstOpenedAt ?? new Date(), lastOpenedAt: new Date() }, $inc: { openCount: 1 } },
    { new: true },
  );
  if (!spent) {
    throw ApiError.gone('link_already_used', 'This link has already been opened.');
  }

  const now = new Date();
  const ttlMs = env.CREATOR_SESSION_TTL_HOURS * HOUR_MS;
  const { raw, hash } = mintToken();

  const session = await SessionModel.create({
    tokenHash: hash,
    subjectKind: 'creator',
    creatorId: creator._id,
    operatorId: null,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
    lastSeenAt: now,
    ipHash,
    userAgent: userAgentOf(req),
    viaMagicLinkId: link._id,
  });

  res.cookie(CREATOR_COOKIE, raw, cookieOptions(ttlMs));

  await recordAudit({
    actorKind: 'creator',
    actorId: creator._id,
    actorLabel: creator.displayName,
    action: AUDIT.creatorSessionCreated,
    subjectKind: 'Creator',
    subjectId: creator._id,
    detail: { userAgent: userAgentOf(req), viaMagicLinkId: link._id.toString() },
    ipHash,
  });

  return { session, creator };
}

/** Reads and validates the session cookie. */
export async function resolveCreatorSession(req: Request): Promise<CreatorSession> {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
  const raw = cookies[CREATOR_COOKIE];
  if (!raw || !looksLikeToken(raw)) {
    throw ApiError.unauthorized('no_session', 'Open your Anton link to continue.');
  }

  const session = await SessionModel.findOne({ tokenHash: hashToken(raw), subjectKind: 'creator' });
  if (!session) throw ApiError.unauthorized('no_session', 'Open your Anton link to continue.');
  if (session.revokedAt) {
    throw ApiError.unauthorized('session_revoked', 'This session was signed out.');
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    throw ApiError.unauthorized('session_expired', 'You have been signed out. Open a fresh link.');
  }

  const creator = await CreatorModel.findById(session.creatorId);
  if (!creator) throw ApiError.notFound('creator_not_found', 'This account no longer exists.');
  if (creator.status === 'removed') {
    throw ApiError.gone('creator_removed', 'This account has been removed at your request.');
  }

  return { session, creator };
}

export function requireCreator(req: Request, _res: Response, next: NextFunction): void {
  resolveCreatorSession(req)
    .then(async (session) => {
      req.creatorSession = session;
      // Touch, but not on every request: a write per API call is pure cost for
      // a field only used to show "last seen" on the sessions list.
      if (Date.now() - session.session.lastSeenAt.getTime() > 60_000) {
        await SessionModel.updateOne(
          { _id: session.session._id },
          { $set: { lastSeenAt: new Date() } },
        ).catch(() => undefined);
      }
      next();
    })
    .catch(next);
}

/** Routes that write creator data require consent on record first. */
export function requireConsent(req: Request, _res: Response, next: NextFunction): void {
  const creator = req.creatorSession?.creator;
  if (!creator) {
    next(ApiError.unauthorized('no_session', 'Open your Anton link to continue.'));
    return;
  }
  if (!creator.consent || creator.consent.withdrawnAt !== null) {
    next(ApiError.forbidden('consent_required', 'We need your agreement before anything is stored.'));
    return;
  }
  next();
}

export function getSession(req: Request): CreatorSession {
  const session = req.creatorSession;
  if (!session) throw ApiError.unauthorized('no_session', 'Open your Anton link to continue.');
  return session;
}

/** Signs out every session for a creator. Reachable from their own page. */
export async function revokeAllCreatorSessions(
  creatorId: SessionDoc['creatorId'],
  reason: string,
): Promise<number> {
  const result = await SessionModel.updateMany(
    { creatorId, subjectKind: 'creator', revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason.slice(0, 120) } },
  );
  return result.modifiedCount;
}

export function clearCreatorCookie(res: Response): void {
  res.clearCookie(CREATOR_COOKIE, { path: '/' });
}

export { DAY_MS };
