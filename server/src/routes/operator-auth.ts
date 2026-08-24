import { Router } from 'express';
import { z } from 'zod';
import { OperatorModel, SessionModel } from '../db/models/index.js';
import {
  OPERATOR_COOKIE,
  clearOperatorCookie,
  generateRecoveryCodes,
  generateTotpSecret,
  getOperator,
  hashPassword,
  loginOperator,
  reauthenticate,
  requireOperator,
  totpUri,
  verifyTotp,
} from '../lib/operator-session.js';
import { ApiError } from '../lib/errors.js';
import { asyncRoute, parseBody } from '../lib/validate.js';

export const operatorAuthRouter: Router = Router();

/**
 * Operator authentication routes.
 *
 * TOTP is mandatory. An account with a password but no completed enrolment
 * cannot sign in at all — there is deliberately no grace period during which
 * the account is weaker.
 */

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
  totpCode: z.string().min(0).max(20).default(''),
  recoveryCode: z.string().max(40).optional(),
});

operatorAuthRouter.post(
  '/login',
  asyncRoute(async (req, res) => {
    const body = parseBody(loginSchema, req);
    const { operator } = await loginOperator(req, res, body);
    res.json({
      operator: {
        id: operator._id.toString(),
        email: operator.email,
        displayName: operator.displayName,
        role: operator.role,
      },
    });
  }),
);

operatorAuthRouter.post(
  '/logout',
  requireOperator,
  asyncRoute(async (req, res) => {
    const { session } = getOperator(req);
    await SessionModel.updateOne(
      { _id: session._id },
      { $set: { revokedAt: new Date(), revokedReason: 'signed out' } },
    );
    clearOperatorCookie(res);
    res.json({ ok: true });
  }),
);

operatorAuthRouter.get(
  '/me',
  requireOperator,
  asyncRoute(async (req, res) => {
    const { operator, session } = getOperator(req);
    res.json({
      operator: {
        id: operator._id.toString(),
        email: operator.email,
        displayName: operator.displayName,
        role: operator.role,
        totpEnrolled: operator.totpEnrolledAt != null,
      },
      session: {
        expiresAt: session.expiresAt,
        lastReauthAt: session.lastReauthAt,
      },
    });
  }),
);

/**
 * Re-authentication, required before bulk export or bulk deletion. A session
 * open all day is not evidence that the operator is still at the keyboard.
 */
const reauthSchema = z.object({ password: z.string().min(1).max(200) });

operatorAuthRouter.post(
  '/reauth',
  requireOperator,
  asyncRoute(async (req, res) => {
    const body = parseBody(reauthSchema, req);
    await reauthenticate(req, body.password);
    res.json({ ok: true, at: new Date() });
  }),
);

/* ------------------------------------------------------------- enrolment */

/**
 * TOTP enrolment. Two steps on purpose: `begin` hands over a secret and a QR
 * URI, `confirm` requires a working code before the secret becomes active. A
 * one-step enrolment can lock an operator out of their own account if the
 * authenticator app failed to save the secret.
 */
operatorAuthRouter.post(
  '/totp/begin',
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ email: z.email(), password: z.string().min(1) }), req);
    const operator = await OperatorModel.findOne({ email: body.email.toLowerCase().trim() }).select(
      '+passwordHash',
    );
    if (!operator) throw ApiError.unauthorized('invalid_credentials', 'Email or password is incorrect.');

    const { verifyPassword } = await import('../lib/operator-session.js');
    if (!(await verifyPassword(operator.passwordHash, body.password))) {
      throw ApiError.unauthorized('invalid_credentials', 'Email or password is incorrect.');
    }
    if (operator.totpEnrolledAt) {
      throw ApiError.conflict(
        'already_enrolled',
        'Two-factor is already set up. Reset it from an authenticated session.',
      );
    }

    const secret = generateTotpSecret();
    await OperatorModel.updateOne({ _id: operator._id }, { $set: { totpSecret: secret } });

    res.json({
      // Shown once. The client renders it as a QR code and never stores it.
      secret,
      otpauthUri: totpUri(operator.email, secret),
    });
  }),
);

operatorAuthRouter.post(
  '/totp/confirm',
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({ email: z.email(), password: z.string().min(1), totpCode: z.string().length(6) }),
      req,
    );
    const operator = await OperatorModel.findOne({ email: body.email.toLowerCase().trim() }).select(
      '+passwordHash +totpSecret',
    );
    if (!operator?.totpSecret) {
      throw ApiError.badRequest('no_enrolment_started', 'Start two-factor setup first.');
    }

    const { verifyPassword } = await import('../lib/operator-session.js');
    if (!(await verifyPassword(operator.passwordHash, body.password))) {
      throw ApiError.unauthorized('invalid_credentials', 'Email or password is incorrect.');
    }
    if (!verifyTotp(operator.totpSecret, body.totpCode)) {
      throw ApiError.badRequest('invalid_code', 'That code is not right. Check your authenticator app.');
    }

    const { plain, hashes } = await generateRecoveryCodes();
    await OperatorModel.updateOne(
      { _id: operator._id },
      { $set: { totpEnrolledAt: new Date(), recoveryCodeHashes: hashes } },
    );

    res.json({
      enrolled: true,
      // Shown exactly once. Only their hashes are stored.
      recoveryCodes: plain,
      note: 'Save these somewhere safe. They are shown once and each works once.',
    });
  }),
);

export { OPERATOR_COOKIE, hashPassword };
