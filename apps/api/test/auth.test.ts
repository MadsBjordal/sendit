import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { organisations, users } from '../src/db/schema';
import { totp } from '../src/lib/crypto';
import { ensurePlatformAdmin } from '../src/db/seed-lib';
import { adminClient, Client, lastEmailToken, registerCompany, useTestEnv } from './helpers';

const env = useTestEnv();

describe('registration and login', () => {
  it('registers a shipper company with its owner, sends a confirmation email, and logs in', async () => {
    const { client, email, orgId } = await registerCompany(env, 'shipper', { verifyEmail: false });
    let me = await client.get('/api/auth/me');
    expect(me.data).toMatchObject({
      role: 'owner',
      org: { id: orgId, kind: 'shipper', status: 'verified' },
      user: { emailVerified: false },
    });
    const token = await lastEmailToken(env, email, 'verify_email');
    expect((await client.post('/api/auth/verify-email', { token })).statusCode).toBe(200);
    expect((await client.post('/api/auth/verify-email', { token })).data.error).toBe('bad_token'); // one use only
    me = await client.get('/api/auth/me');
    expect(me.data.user.emailVerified).toBe(true);
    const fresh = new Client(env);
    expect(
      (await fresh.post('/api/auth/login', { email, password: 'correct horse battery staple' }))
        .statusCode,
    ).toBe(200);
    expect((await fresh.get('/api/auth/me')).data.user.email).toBe(email);
  });

  it('carriers start unverified', async () => {
    const { client } = await registerCompany(env, 'carrier');
    expect((await client.get('/api/auth/me')).data.org.status).toBe('pending_verification');
  });

  it('refuses a duplicate email (any case), a short password and bad input', async () => {
    const { email } = await registerCompany(env, 'shipper');
    const c = new Client(env);
    const dup = await c.post('/api/auth/register', {
      organisation: { name: 'X GmbH', kind: 'shipper', country: 'DE' },
      user: { name: 'X', email: email.toUpperCase(), password: 'another long password' },
    });
    expect(dup.data.error).toBe('email_taken');
    const short = await c.post('/api/auth/register', {
      organisation: { name: 'X GmbH', kind: 'shipper', country: 'DE' },
      user: { name: 'X', email: 'x@example.com', password: 'short' },
    });
    expect(short.statusCode).toBe(400);
    const platform = await c.post('/api/auth/register', {
      organisation: { name: 'X', kind: 'platform', country: 'DE' },
      user: { name: 'X', email: 'y@example.com', password: 'another long password' },
    });
    expect(platform.statusCode).toBe(400);
  });

  it('gives the same answer for an unknown email and a wrong password, and locks after repeated failures', async () => {
    const { email } = await registerCompany(env, 'shipper');
    const c = new Client(env);
    const unknown = await c.post('/api/auth/login', {
      email: 'nobody@example.com',
      password: 'whatever whatever',
    });
    const wrong = await c.post('/api/auth/login', { email, password: 'wrong password!!' });
    expect(unknown.data).toEqual(wrong.data);
    for (let i = 0; i < 9; i++)
      await c.post('/api/auth/login', { email, password: 'wrong password!!' });
    const locked = await c.post('/api/auth/login', {
      email,
      password: 'correct horse battery staple',
    });
    expect(locked.data.error).toBe('locked');
  });

  it('password reset works once and logs out every session', async () => {
    const { client, email } = await registerCompany(env, 'shipper');
    const anon = new Client(env);
    await anon.post('/api/auth/forgot-password', { email });
    expect(
      (await anon.post('/api/auth/forgot-password', { email: 'unknown@example.com' })).statusCode,
    ).toBe(200);
    const token = await lastEmailToken(env, email, 'reset_password');
    expect(
      (
        await anon.post('/api/auth/reset-password', {
          token,
          password: 'a brand new long password',
        })
      ).statusCode,
    ).toBe(200);
    expect((await client.get('/api/auth/me')).statusCode).toBe(401);
    expect(
      (await anon.post('/api/auth/login', { email, password: 'a brand new long password' }))
        .statusCode,
    ).toBe(200);
  });

  it('requires the CSRF header on changes made with the session cookie', async () => {
    const { client } = await registerCompany(env, 'shipper');
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: client.cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('csrf');
  });
});

describe('members and roles', () => {
  it('an owner invites a colleague; the role limits what they can do', async () => {
    const owner = await registerCompany(env, 'shipper');
    expect(
      (
        await owner.client.post('/api/org/invitations', {
          email: 'finance@example.com',
          role: 'finance',
        })
      ).statusCode,
    ).toBe(200);
    const token = await lastEmailToken(env, 'finance@example.com', 'invitation');
    const colleague = new Client(env);
    const acc = await colleague.post('/api/org/invitations/accept', {
      token,
      name: 'Fiona',
      password: 'fiona long password',
    });
    expect(acc.statusCode).toBe(200);
    const me = await colleague.get('/api/auth/me');
    expect(me.data).toMatchObject({ role: 'finance', org: { id: owner.orgId } });
    // Finance may look but not book or invite
    expect((await colleague.get('/api/shipments')).statusCode).toBe(200);
    expect(
      (await colleague.post('/api/org/invitations', { email: 'z@example.com', role: 'member' }))
        .statusCode,
    ).toBe(403);
    const members = await owner.client.get('/api/org/members');
    expect(members.data).toHaveLength(2);
  });

  it('the last owner cannot be removed', async () => {
    const owner = await registerCompany(env, 'shipper');
    const [m] = (await owner.client.get('/api/org/members')).data;
    const res = await owner.client.req('PATCH', `/api/org/members/${m.id}`, {
      role: 'member',
      active: true,
    });
    expect(res.data.error).toBe('last_owner');
  });
});

describe('platform administration', () => {
  it('needs two-step login; then verifies carriers and reviews documents', async () => {
    const a = await ensurePlatformAdmin(
      env.ctx.db,
      'boss@example.com',
      'admin password long enough',
    );
    const noCode = new Client(env);
    expect(
      (
        await noCode.post('/api/auth/login', {
          email: 'boss@example.com',
          password: 'admin password long enough',
        })
      ).data.error,
    ).toBe('mfa_required');
    expect(
      (
        await noCode.post('/api/auth/login', {
          email: 'boss@example.com',
          password: 'admin password long enough',
          mfaCode: '000000',
        })
      ).data.error,
    ).toBe('mfa_wrong');
    const admin = new Client(env);
    await admin.post('/api/auth/login', {
      email: 'boss@example.com',
      password: 'admin password long enough',
      mfaCode: totp(a.mfaSecret, env.clock.now.getTime()),
    });

    const carrier = await registerCompany(env, 'carrier');
    const doc = await carrier.client.post('/api/carrier/documents', {
      kind: 'operator_licence',
      reference: 'EU-LIC-1',
      validUntil: '2027-01-01',
    });
    const pending = await admin.get('/api/admin/organisations?status=pending_verification');
    expect(pending.data.map((o: { id: string }) => o.id)).toContain(carrier.orgId);
    expect(
      (await admin.post(`/api/admin/documents/${doc.data.id}/review`, { decision: 'rejected' }))
        .data.error,
    ).toBe('note_required');
    expect(
      (await admin.post(`/api/admin/documents/${doc.data.id}/review`, { decision: 'approved' }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await admin.post(`/api/admin/organisations/${carrier.orgId}/decision`, {
          decision: 'verified',
        })
      ).statusCode,
    ).toBe(200);
    const [org] = await env.ctx.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, carrier.orgId));
    expect(org!.status).toBe('verified');
    const auditRows = await admin.get('/api/admin/audit');
    expect(auditRows.data.map((r: { action: string }) => r.action)).toEqual(
      expect.arrayContaining(['org.verified', 'verification.document_approved']),
    );
  });

  it('ordinary users and staff without MFA are refused', async () => {
    const shipper = await registerCompany(env, 'shipper');
    expect((await shipper.client.get('/api/admin/organisations')).statusCode).toBe(403);
    await ensurePlatformAdmin(env.ctx.db, 'nomfa@example.com', 'admin password long enough');
    await env.ctx.db
      .update(users)
      .set({ mfaEnabled: false })
      .where(eq(users.email, 'nomfa@example.com'));
    const c = new Client(env);
    await c.post('/api/auth/login', {
      email: 'nomfa@example.com',
      password: 'admin password long enough',
    });
    expect((await c.get('/api/admin/organisations')).data.error).toBe('mfa_required');
  });

  it('blocked countries cannot be opened; closed countries cannot be booked', async () => {
    const admin = await adminClient(env);
    expect(
      (await admin.put('/api/admin/countries/RU', { enabled: true, domesticEnabled: false })).data
        .error,
    ).toBe('country_blocked');
    expect(
      (await admin.put('/api/admin/countries/NL', { enabled: false, domesticEnabled: false }))
        .statusCode,
    ).toBe(200);
    const countries = await new Client(env).get('/api/countries');
    expect(countries.data.find((c: { code: string }) => c.code === 'NL').enabled).toBe(false);
  });

  it('pricing versions are kept and one is active', async () => {
    const admin = await adminClient(env);
    const list = await admin.get('/api/admin/pricing');
    const cfg = {
      ...list.data[0].config,
      version: 'v2',
      platformFee: { kind: 'commission_on_price', bp: 12_000, minimumMinor: 0 },
    };
    expect(
      (await admin.post('/api/admin/pricing', { config: cfg, activate: true })).data.error,
    ).toBe('bad_pricing');
    cfg.platformFee.bp = 1_200;
    expect(
      (await admin.post('/api/admin/pricing', { config: cfg, activate: true })).statusCode,
    ).toBe(200);
    const after = await admin.get('/api/admin/pricing');
    expect(
      after.data
        .filter((p: { active: boolean }) => p.active)
        .map((p: { version: string }) => p.version),
    ).toEqual(['v2']);
    expect(after.data).toHaveLength(2);
  });
});

describe('rate limiting', () => {
  it('slows down repeated login attempts from one address', async () => {
    const { buildApp } = await import('../src/app');
    const app = await buildApp(env.ctx, { rateLimit: true });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'freight' },
        payload: JSON.stringify({ email: 'a@example.com', password: 'x' }),
      });
      codes.push(res.statusCode);
    }
    await app.close();
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});
