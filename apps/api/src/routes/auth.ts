import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loginSchema, MEMBER_ROLES, registerSchema } from '@freight/shared';
import type { Ctx } from '../context';
import { doc, member, parse, SESSION_COOKIE, setSessionCookie } from '../lib/http';
import { unauthorised } from '../lib/errors';
import * as auth from '../services/auth';
import { eq } from 'drizzle-orm';
import { memberships, organisations, sessions } from '../db/schema';

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const secure = ctx.config.env === 'production';
  const meta = (req: { ip: string; headers: Record<string, unknown> }) => ({
    ip: req.ip,
    userAgent: String(req.headers['user-agent'] ?? ''),
  });
  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post(
    '/api/auth/register',
    {
      ...strict,
      schema: {
        tags: ['auth'],
        summary: 'Register a company and its first user',
        body: doc(registerSchema),
      },
    },
    async (req, reply) => {
      const input = parse(registerSchema, req.body);
      const s = await auth.register(ctx, input, meta(req));
      setSessionCookie(reply, s.token, s.expiresAt, secure);
      return { ok: true, userId: s.userId, orgId: s.orgId };
    },
  );

  app.post(
    '/api/auth/login',
    { ...strict, schema: { tags: ['auth'], summary: 'Log in', body: doc(loginSchema) } },
    async (req, reply) => {
      const input = parse(loginSchema, req.body);
      const s = await auth.login(ctx, input, meta(req));
      setSessionCookie(reply, s.token, s.expiresAt, secure);
      return { ok: true };
    },
  );

  // Mobile apps (driver app) keep the session token themselves and send it as "Authorization: Bearer"
  app.post(
    '/api/auth/token',
    {
      ...strict,
      schema: {
        tags: ['auth'],
        summary: 'Log in from a mobile app: returns a bearer token',
        body: doc(loginSchema),
      },
    },
    async (req) => {
      const input = parse(loginSchema, req.body);
      const s = await auth.login(ctx, input, meta(req));
      return { token: s.token, expiresAt: s.expiresAt };
    },
  );

  app.post('/api/auth/logout', { schema: { tags: ['auth'] } }, async (req, reply) => {
    if (req.session) await auth.logout(ctx, req.session.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get(
    '/api/auth/me',
    { schema: { tags: ['auth'], summary: 'Who is logged in' } },
    async (req) => {
      const s = req.session;
      if (!s) throw unauthorised();
      const orgs = await ctx.db
        .select({
          id: organisations.id,
          name: organisations.name,
          kind: organisations.kind,
          role: memberships.role,
        })
        .from(memberships)
        .innerJoin(organisations, eq(organisations.id, memberships.orgId))
        .where(eq(memberships.userId, s.user.id));
      return {
        user: s.user,
        org: s.org,
        role: s.role,
        mfaPassed: s.mfaPassed,
        organisations: orgs,
        brand: ctx.config.brand,
      };
    },
  );

  app.post('/api/auth/switch-org', { schema: { tags: ['auth'] } }, async (req) => {
    const s = req.session;
    if (!s) throw unauthorised();
    const { orgId } = parse(z.object({ orgId: z.string().uuid() }), req.body);
    const all = await ctx.db.select().from(memberships).where(eq(memberships.userId, s.user.id));
    if (!all.some((x) => x.orgId === orgId && x.active))
      throw unauthorised('You are not a member of that organisation');
    await ctx.db.update(sessions).set({ activeOrgId: orgId }).where(eq(sessions.id, s.sessionId));
    return { ok: true };
  });

  app.post('/api/auth/verify-email', { ...strict, schema: { tags: ['auth'] } }, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10) }), req.body);
    await auth.verifyEmail(ctx, token);
    return { ok: true };
  });

  app.post(
    '/api/auth/resend-verification',
    { ...strict, schema: { tags: ['auth'] } },
    async (req) => {
      if (!req.session) throw unauthorised();
      await auth.resendVerification(ctx, req.session.user.id);
      return { ok: true };
    },
  );

  app.post('/api/auth/forgot-password', { ...strict, schema: { tags: ['auth'] } }, async (req) => {
    const { email } = parse(z.object({ email: z.string().email() }), req.body);
    await auth.requestPasswordReset(ctx, email);
    return { ok: true };
  });

  app.post('/api/auth/reset-password', { ...strict, schema: { tags: ['auth'] } }, async (req) => {
    const { token, password } = parse(
      z.object({ token: z.string().min(10), password: z.string().min(12).max(200) }),
      req.body,
    );
    await auth.resetPassword(ctx, token, password);
    return { ok: true };
  });

  app.post(
    '/api/auth/mfa/setup',
    { schema: { tags: ['auth'], summary: 'Start two-step login setup (authenticator app)' } },
    async (req) => {
      if (!req.session) throw unauthorised();
      return auth.startMfaSetup(ctx, req.session.user.id);
    },
  );

  app.post('/api/auth/mfa/enable', { ...strict, schema: { tags: ['auth'] } }, async (req) => {
    if (!req.session) throw unauthorised();
    const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
    await auth.enableMfa(ctx, req.session, code);
    return { ok: true };
  });

  // ---- members of my organisation
  app.get('/api/org/members', { schema: { tags: ['organisation'] } }, async (req) => {
    const a = member(req);
    return auth.listMembers(ctx, a.orgId);
  });

  app.post('/api/org/invitations', { schema: { tags: ['organisation'] } }, async (req) => {
    const a = member(req, { permission: 'members.manage' });
    const input = parse(
      z.object({ email: z.string().email(), role: z.enum(MEMBER_ROLES) }),
      req.body,
    );
    await auth.inviteMember(ctx, a, input);
    return { ok: true };
  });

  app.post(
    '/api/org/invitations/accept',
    { ...strict, schema: { tags: ['organisation'] } },
    async (req, reply) => {
      const input = parse(
        z.object({
          token: z.string().min(10),
          name: z.string().min(1).max(200).optional(),
          password: z.string().max(200).optional(),
        }),
        req.body,
      );
      const s = await auth.acceptInvitation(
        ctx,
        input.token,
        input.name && input.password ? { name: input.name, password: input.password } : null,
        req.session,
        meta(req),
      );
      setSessionCookie(reply, s.token, s.expiresAt, secure);
      return { ok: true };
    },
  );

  app.patch('/api/org/members/:id', { schema: { tags: ['organisation'] } }, async (req) => {
    const a = member(req, { permission: 'members.manage' });
    const { id } = req.params as { id: string };
    const input = parse(z.object({ role: z.enum(MEMBER_ROLES), active: z.boolean() }), req.body);
    await auth.changeMemberRole(ctx, a, id, input.role, input.active);
    return { ok: true };
  });
}
