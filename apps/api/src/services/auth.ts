import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { MemberRole, RegisterInput } from '@freight/shared';
import type { Ctx } from '../context';
import type { DbOrTx } from '../db/client';
import { invitations, memberships, organisations, sessions, users, userTokens } from '../db/schema';
import { newToken, newTotpSecret, sha256, verifyTotp } from '../lib/crypto';
import { AppError, badRequest, conflict, notFound, unauthorised } from '../lib/errors';
import { audit, type Actor } from './audit';

const SESSION_DAYS = 30;
const STAFF_SESSION_HOURS = 12;
const LOCK_AFTER_FAILURES = 10;
const LOCK_MINUTES = 15;

// Argon2id, OWASP-recommended parameters
const ARGON = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON);
}

export interface SessionInfo {
  sessionId: string;
  user: {
    id: string;
    email: string;
    name: string;
    locale: string;
    emailVerified: boolean;
    platformRole: string | null;
    mfaEnabled: boolean;
  };
  mfaPassed: boolean;
  org: { id: string; kind: string; name: string; status: string; country: string } | null;
  role: MemberRole | null;
}

async function createSession(
  ctx: Ctx,
  db: DbOrTx,
  userId: string,
  opts: {
    orgId: string | null;
    staff: boolean;
    mfaPassed: boolean;
    ip?: string;
    userAgent?: string;
  },
) {
  const token = newToken();
  const now = ctx.now();
  const expiresAt = new Date(
    now.getTime() + (opts.staff ? STAFF_SESSION_HOURS * 3_600_000 : SESSION_DAYS * 86_400_000),
  );
  await db.insert(sessions).values({
    tokenHash: sha256(token),
    userId,
    activeOrgId: opts.orgId,
    mfaPassed: opts.mfaPassed,
    ip: opts.ip ?? null,
    userAgent: opts.userAgent?.slice(0, 300) ?? null,
    expiresAt,
  });
  return { token, expiresAt };
}

async function sendEmailToken(
  ctx: Ctx,
  db: DbOrTx,
  user: { id: string; email: string; name: string },
  kind: 'verify_email' | 'reset_password',
) {
  const token = newToken();
  const hours = kind === 'verify_email' ? 72 : 1;
  await db
    .insert(userTokens)
    .values({
      userId: user.id,
      kind,
      tokenHash: sha256(token),
      expiresAt: new Date(ctx.now().getTime() + hours * 3_600_000),
    });
  const link = `${ctx.config.publicUrl}/${kind === 'verify_email' ? 'verify-email' : 'reset-password'}?token=${token}`;
  const brand = ctx.config.brand.name;
  await ctx.email.send(db, {
    to: user.email,
    template: kind,
    subject:
      kind === 'verify_email' ? `Confirm your email for ${brand}` : `Reset your ${brand} password`,
    body:
      kind === 'verify_email'
        ? `Hello ${user.name},\n\nPlease confirm your email address: ${link}\n\nThe link works for ${hours} hours.`
        : `Hello ${user.name},\n\nYou (or someone else) asked to reset your password: ${link}\n\nThe link works for 1 hour. If you did not ask, ignore this email.`,
  });
}

export async function register(
  ctx: Ctx,
  input: RegisterInput,
  meta: { ip?: string; userAgent?: string },
) {
  return ctx.db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${input.user.email.toLowerCase()}`);
    if (existing[0])
      throw conflict(
        'email_taken',
        'An account with this email already exists. Log in or reset your password.',
      );
    // Shippers pay in advance, so they can book once their email is confirmed; carriers and
    // customs providers are checked by the platform first (DECISIONS.md D-012).
    const autoVerified = input.organisation.kind === 'shipper';
    const [org] = await tx
      .insert(organisations)
      .values({
        kind: input.organisation.kind,
        name: input.organisation.name,
        country: input.organisation.country,
        vatNumber: input.organisation.vatNumber ?? null,
        registrationNumber: input.organisation.registrationNumber ?? null,
        status: autoVerified ? 'verified' : 'pending_verification',
        verifiedAt: autoVerified ? ctx.now() : null,
        statusNote: autoVerified ? 'Self-registered shipper: prepaid bookings only' : null,
      })
      .returning();
    const [user] = await tx
      .insert(users)
      .values({
        email: input.user.email,
        name: input.user.name,
        passwordHash: await hashPassword(input.user.password),
        locale: input.user.locale,
      })
      .returning();
    await tx.insert(memberships).values({ orgId: org!.id, userId: user!.id, role: 'owner' });
    await sendEmailToken(ctx, tx, user!, 'verify_email');
    await audit(
      tx,
      { userId: user!.id, orgId: org!.id, ip: meta.ip },
      'org.registered',
      { type: 'organisation', id: org!.id },
      { kind: org!.kind },
    );
    const session = await createSession(ctx, tx, user!.id, {
      orgId: org!.id,
      staff: false,
      mfaPassed: false,
      ...meta,
    });
    return { ...session, userId: user!.id, orgId: org!.id };
  });
}

export async function login(
  ctx: Ctx,
  input: { email: string; password: string; mfaCode?: string },
  meta: { ip?: string; userAgent?: string },
) {
  const [user] = await ctx.db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${input.email.toLowerCase()}`);
  const now = ctx.now();
  // Same answer for unknown email and wrong password
  const wrong = () => new AppError(401, 'bad_credentials', 'Email or password is wrong');
  if (!user || !user.active) {
    await hashPassword(input.password); // keep timing similar
    throw wrong();
  }
  if (user.lockedUntil && user.lockedUntil > now)
    throw new AppError(
      429,
      'locked',
      'Too many failed attempts. Try again in a few minutes or reset your password.',
    );
  const ok = await verify(user.passwordHash, input.password);
  if (!ok) {
    const failed = user.failedLogins + 1;
    await ctx.db
      .update(users)
      .set({
        failedLogins: failed,
        lockedUntil:
          failed >= LOCK_AFTER_FAILURES ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null,
      })
      .where(eq(users.id, user.id));
    await audit(ctx.db, { userId: user.id, ip: meta.ip }, 'auth.login_failed');
    throw wrong();
  }
  const staff = !!user.platformRole;
  let mfaPassed = false;
  if (user.mfaEnabled) {
    if (!input.mfaCode)
      throw new AppError(401, 'mfa_required', 'Enter the 6-digit code from your authenticator app');
    if (!user.mfaSecret || !verifyTotp(user.mfaSecret, input.mfaCode, now.getTime())) {
      await audit(ctx.db, { userId: user.id, ip: meta.ip }, 'auth.mfa_failed');
      throw new AppError(401, 'mfa_wrong', 'The code is wrong or too old');
    }
    mfaPassed = true;
  }
  await ctx.db
    .update(users)
    .set({ failedLogins: 0, lockedUntil: null })
    .where(eq(users.id, user.id));
  const [m] = await ctx.db
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(and(eq(memberships.userId, user.id), eq(memberships.active, true)))
    .orderBy(memberships.createdAt)
    .limit(1);
  const session = await createSession(ctx, ctx.db, user.id, {
    orgId: m?.orgId ?? null,
    staff,
    mfaPassed,
    ...meta,
  });
  await audit(ctx.db, { userId: user.id, orgId: m?.orgId, ip: meta.ip }, 'auth.login');
  return session;
}

export async function sessionFromToken(ctx: Ctx, token: string): Promise<SessionInfo | null> {
  const now = ctx.now();
  const rows = await ctx.db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, sha256(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    );
  const row = rows[0];
  if (!row || !row.u.active) return null;
  let org: SessionInfo['org'] = null;
  let role: MemberRole | null = null;
  if (row.s.activeOrgId) {
    const [m] = await ctx.db
      .select({ o: organisations, role: memberships.role })
      .from(memberships)
      .innerJoin(organisations, eq(organisations.id, memberships.orgId))
      .where(
        and(
          eq(memberships.orgId, row.s.activeOrgId),
          eq(memberships.userId, row.u.id),
          eq(memberships.active, true),
        ),
      );
    if (m) {
      org = {
        id: m.o.id,
        kind: m.o.kind,
        name: m.o.name,
        status: m.o.status,
        country: m.o.country,
      };
      role = m.role as MemberRole;
    }
  }
  if (now.getTime() - row.s.lastSeenAt.getTime() > 5 * 60_000)
    await ctx.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.s.id));
  return {
    sessionId: row.s.id,
    user: {
      id: row.u.id,
      email: row.u.email,
      name: row.u.name,
      locale: row.u.locale,
      emailVerified: !!row.u.emailVerifiedAt,
      platformRole: row.u.platformRole,
      mfaEnabled: row.u.mfaEnabled,
    },
    mfaPassed: row.s.mfaPassed,
    org,
    role,
  };
}

export async function logout(ctx: Ctx, sessionId: string) {
  await ctx.db.update(sessions).set({ revokedAt: ctx.now() }).where(eq(sessions.id, sessionId));
}

async function useToken(
  ctx: Ctx,
  db: DbOrTx,
  token: string,
  kind: 'verify_email' | 'reset_password',
) {
  const [row] = await db
    .update(userTokens)
    .set({ usedAt: ctx.now() })
    .where(
      and(
        eq(userTokens.tokenHash, sha256(token)),
        eq(userTokens.kind, kind),
        isNull(userTokens.usedAt),
        gt(userTokens.expiresAt, ctx.now()),
      ),
    )
    .returning();
  if (!row) throw badRequest('bad_token', 'This link is not valid any more. Ask for a new one.');
  return row;
}

export async function verifyEmail(ctx: Ctx, token: string) {
  await ctx.db.transaction(async (tx) => {
    const t = await useToken(ctx, tx, token, 'verify_email');
    await tx.update(users).set({ emailVerifiedAt: ctx.now() }).where(eq(users.id, t.userId));
    await audit(tx, { userId: t.userId }, 'auth.email_verified');
  });
}

export async function resendVerification(ctx: Ctx, userId: string) {
  const [u] = await ctx.db.select().from(users).where(eq(users.id, userId));
  if (!u || u.emailVerifiedAt) return;
  await sendEmailToken(ctx, ctx.db, u, 'verify_email');
}

/** Always answers the same, whether the email exists or not. */
export async function requestPasswordReset(ctx: Ctx, email: string) {
  const [u] = await ctx.db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
  if (u && u.active) await sendEmailToken(ctx, ctx.db, u, 'reset_password');
}

export async function resetPassword(ctx: Ctx, token: string, password: string) {
  if (password.length < 12) throw badRequest('weak_password', 'At least 12 characters');
  await ctx.db.transaction(async (tx) => {
    const t = await useToken(ctx, tx, token, 'reset_password');
    await tx
      .update(users)
      .set({ passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null })
      .where(eq(users.id, t.userId));
    // Every existing session ends: whoever knew the old password is logged out
    await tx
      .update(sessions)
      .set({ revokedAt: ctx.now() })
      .where(and(eq(sessions.userId, t.userId), isNull(sessions.revokedAt)));
    await audit(tx, { userId: t.userId }, 'auth.password_reset');
  });
}

// ------------------------------------------------------------ MFA (required for platform staff)

export async function startMfaSetup(ctx: Ctx, userId: string) {
  const [u] = await ctx.db.select().from(users).where(eq(users.id, userId));
  if (!u) throw unauthorised();
  if (u.mfaEnabled) throw conflict('mfa_enabled', 'Two-step login is already on');
  const secret = newTotpSecret();
  await ctx.db.update(users).set({ mfaSecret: secret }).where(eq(users.id, userId));
  const label = encodeURIComponent(`${ctx.config.brand.name}:${u.email}`);
  return {
    secret,
    otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ctx.config.brand.name)}`,
  };
}

export async function enableMfa(ctx: Ctx, session: SessionInfo, code: string) {
  const [u] = await ctx.db.select().from(users).where(eq(users.id, session.user.id));
  if (!u?.mfaSecret || !verifyTotp(u.mfaSecret, code, ctx.now().getTime()))
    throw badRequest('mfa_wrong', 'The code is wrong or too old');
  await ctx.db.update(users).set({ mfaEnabled: true }).where(eq(users.id, u.id));
  await ctx.db.update(sessions).set({ mfaPassed: true }).where(eq(sessions.id, session.sessionId));
  await audit(ctx.db, { userId: u.id }, 'auth.mfa_enabled');
}

// ------------------------------------------------------------ organisation members

export async function inviteMember(
  ctx: Ctx,
  actor: Actor & { userId: string; orgId: string },
  input: { email: string; role: MemberRole },
) {
  if (input.role === 'owner')
    throw badRequest('bad_role', 'Invite as admin; ownership is transferred separately');
  const token = newToken();
  const [org] = await ctx.db.select().from(organisations).where(eq(organisations.id, actor.orgId));
  await ctx.db.transaction(async (tx) => {
    await tx.insert(invitations).values({
      orgId: actor.orgId,
      email: input.email.toLowerCase(),
      role: input.role,
      tokenHash: sha256(token),
      invitedBy: actor.userId,
      expiresAt: new Date(ctx.now().getTime() + 7 * 86_400_000),
    });
    await ctx.email.send(tx, {
      to: input.email,
      template: 'invitation',
      subject: `You are invited to ${org!.name} on ${ctx.config.brand.name}`,
      body: `You have been invited to join ${org!.name}. Accept here: ${ctx.config.publicUrl}/invite?token=${token}\n\nThe link works for 7 days.`,
    });
    await audit(
      tx,
      actor,
      'members.invited',
      { type: 'organisation', id: actor.orgId },
      { email: input.email, role: input.role },
    );
  });
}

/** Accept an invitation: as a new user (name + password) or as the logged-in user with the same email. */
export async function acceptInvitation(
  ctx: Ctx,
  token: string,
  newUser: { name: string; password: string } | null,
  current: SessionInfo | null,
  meta: { ip?: string; userAgent?: string },
) {
  return ctx.db.transaction(async (tx) => {
    const [inv] = await tx
      .update(invitations)
      .set({ acceptedAt: ctx.now() })
      .where(
        and(
          eq(invitations.tokenHash, sha256(token)),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, ctx.now()),
        ),
      )
      .returning();
    if (!inv) throw badRequest('bad_token', 'This invitation is not valid any more');
    let userId: string;
    const [existing] = await tx
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${inv.email}`);
    if (existing) {
      if (!current || current.user.id !== existing.id)
        throw unauthorised('Log in as ' + inv.email + ' to accept this invitation');
      userId = existing.id;
    } else {
      if (!newUser || newUser.password.length < 12)
        throw badRequest('weak_password', 'Choose a name and a password of at least 12 characters');
      const [u] = await tx
        .insert(users)
        // The invitation link was sent to this address, which confirms it
        .values({
          email: inv.email,
          name: newUser.name,
          passwordHash: await hashPassword(newUser.password),
          emailVerifiedAt: ctx.now(),
        })
        .returning();
      userId = u!.id;
    }
    await tx
      .insert(memberships)
      .values({ orgId: inv.orgId, userId, role: inv.role })
      .onConflictDoUpdate({
        target: [memberships.orgId, memberships.userId],
        set: { role: inv.role, active: true },
      });
    await audit(
      tx,
      { userId, orgId: inv.orgId, ip: meta.ip },
      'members.joined',
      { type: 'organisation', id: inv.orgId },
      { role: inv.role },
    );
    const session = await createSession(ctx, tx, userId, {
      orgId: inv.orgId,
      staff: false,
      mfaPassed: false,
      ...meta,
    });
    return session;
  });
}

export async function listMembers(ctx: Ctx, orgId: string) {
  return ctx.db
    .select({
      id: memberships.id,
      userId: users.id,
      name: users.name,
      email: users.email,
      role: memberships.role,
      active: memberships.active,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.orgId, orgId))
    .orderBy(users.name);
}

export async function changeMemberRole(
  ctx: Ctx,
  actor: Actor & { userId: string; orgId: string },
  membershipId: string,
  role: MemberRole,
  active: boolean,
) {
  const [m] = await ctx.db
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.orgId, actor.orgId)));
  if (!m) throw notFound();
  if (m.role === 'owner' && (role !== 'owner' || !active)) {
    const owners = await ctx.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.orgId, actor.orgId),
          eq(memberships.role, 'owner'),
          eq(memberships.active, true),
        ),
      );
    if (owners.length <= 1)
      throw conflict('last_owner', 'The organisation needs at least one owner');
  }
  await ctx.db.update(memberships).set({ role, active }).where(eq(memberships.id, m.id));
  await audit(ctx.db, actor, 'members.changed', { type: 'membership', id: m.id }, { role, active });
}
