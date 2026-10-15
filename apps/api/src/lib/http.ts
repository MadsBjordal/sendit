import type { FastifyReply, FastifyRequest } from 'fastify';
import { roleCan, type OrgKind } from '@freight/shared';
import { z, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { SessionInfo } from '../services/auth';
import { platformCan } from '../services/admin';
import { AppError, badRequest, forbidden, unauthorised } from './errors';

export const SESSION_COOKIE = 'pf_session';

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionInfo | null;
    rawBody?: string;
  }
}

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const res = schema.safeParse(data);
  if (!res.success)
    throw badRequest(
      'invalid_input',
      'Some fields are missing or wrong',
      res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  return res.data;
}

/** JSON Schema for the OpenAPI documentation (validation itself is done by zod). */
export function doc(schema: ZodTypeAny) {
  return zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' }) as Record<
    string,
    unknown
  >;
}

export interface OrgActor {
  userId: string;
  orgId: string;
  ip: string;
  session: SessionInfo;
}

/** The logged-in member of an organisation, optionally of a given kind and with a permission. */
export function member(
  req: FastifyRequest,
  opts: { kind?: OrgKind | OrgKind[]; permission?: string; allowDriver?: boolean } = {},
): OrgActor {
  const s = req.session;
  if (!s) throw unauthorised();
  if (!s.org || !s.role) throw forbidden('Choose an organisation first');
  // Drivers use the driver endpoints only: no prices, loads or company settings
  if (s.role === 'driver' && !opts.allowDriver) throw forbidden('Drivers use the driver app');
  const kinds = opts.kind ? (Array.isArray(opts.kind) ? opts.kind : [opts.kind]) : null;
  if (kinds && !kinds.includes(s.org.kind as OrgKind))
    throw forbidden('This is not available for your type of company');
  if (opts.permission && !roleCan(s.role, opts.permission))
    throw forbidden('Your role does not allow this. Ask an administrator of your company.');
  return { userId: s.user.id, orgId: s.org.id, ip: req.ip, session: s };
}

/** Platform staff with a permission. Two-step login (MFA) is required for every admin action. */
export function staff(req: FastifyRequest, permission: string) {
  const s = req.session;
  if (!s) throw unauthorised();
  if (!s.user.platformRole) throw forbidden();
  if (!s.mfaPassed)
    throw new AppError(
      403,
      'mfa_required',
      'Turn on two-step login and log in with your code to use administration',
    );
  if (!platformCan(s.user.platformRole, permission)) throw forbidden();
  return { userId: s.user.id, orgId: s.org?.id ?? null, ip: req.ip };
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  secure: boolean,
) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    expires: expiresAt,
  });
}
