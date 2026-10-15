import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { carrierObligations, emailOutbox, payouts } from '../src/db/schema';
import {
  adminClient,
  carrierWithDriver,
  settledBankDetails,
  key,
  lastEmailToken,
  norwayInput,
  pdfBase64,
  readyCustomsProvider,
  registerCompany,
  shipmentInput,
  useTestEnv,
} from './helpers';

const env = useTestEnv();

async function norwayShipment() {
  const shipper = await registerCompany(env, 'shipper');
  const res = await shipper.client.post('/api/shipments', norwayInput(env));
  await shipper.client.post(`/api/test-payments/${res.data.payment.paymentRef}/complete`, {
    outcome: 'succeed',
  });
  const overview = await shipper.client.get(`/api/shipments/${res.data.id}/customs`);
  const exp = overview.data.procedures.find((p: { kind: string }) => p.kind === 'export');
  const imp = overview.data.procedures.find((p: { kind: string }) => p.kind === 'import');
  return {
    shipper,
    shipmentId: res.data.id as string,
    exportId: exp.id as string,
    importId: imp.id as string,
  };
}

async function marketplaceExport(
  s: Awaited<ReturnType<typeof norwayShipment>>,
  budgetMinor = 20_000,
) {
  const arr = await s.shipper.client.post(`/api/customs/procedures/${s.exportId}/arrange`, {
    arrangement: 'marketplace',
    budgetMinor,
  });
  expect(arr.statusCode).toBe(200);
  const paid = await s.shipper.client.post(
    `/api/test-payments/${arr.data.payment.paymentRef}/complete`,
    { outcome: 'succeed' },
  );
  expect(paid.data.result).toBe('customs_job_open');
  await env.jobs();
  return arr.data.jobId as string;
}

const view = async (s: Awaited<ReturnType<typeof norwayShipment>>) =>
  (await s.shipper.client.get(`/api/shipments/${s.shipmentId}/customs`)).data;
const proc = (
  v: { procedures: Array<{ id: string; status: string; statusReason: string }> },
  id: string,
) => v.procedures.find((p) => p.id === id)!;

describe('customs procedures', () => {
  it('Hamburg → Oslo creates an export (DE) and an import (NO), both waiting for an arrangement', async () => {
    const s = await norwayShipment();
    const v = await view(s);
    expect(
      v.procedures.map(
        (p: { kind: string; country: string; status: string }) =>
          `${p.kind}:${p.country}:${p.status}`,
      ),
    ).toEqual(['export:DE:INFORMATION_MISSING', 'import:NO:INFORMATION_MISSING']);
    expect(v.readiness).toMatchObject({ required: true, ready: false });
  });

  it('a "possible" route check can be confirmed as not needed; a required step cannot be skipped', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const input = shipmentInput(env);
    Object.assign(input.delivery, {
      addressLine: 'Via Mecenate 76',
      postcode: '20138',
      city: 'Milano',
      country: 'IT',
      lat: 45.4462,
      lng: 9.2384,
    });
    const res = await shipper.client.post('/api/shipments', input);
    const v = (await shipper.client.get(`/api/shipments/${res.data.id}/customs`)).data;
    const check = v.procedures[0];
    expect(check.kind).toBe('check_route');
    expect(
      (
        await shipper.client.post(`/api/customs/procedures/${check.id}/arrange`, {
          arrangement: 'not_required',
        })
      ).data.error,
    ).toBe('confirmation_required');
    expect(
      (
        await shipper.client.post(`/api/customs/procedures/${check.id}/arrange`, {
          arrangement: 'not_required',
          confirmation: 'Route via Austria, stays in the EU',
        })
      ).statusCode,
    ).toBe(200);
    const s = await norwayShipment();
    expect(
      (
        await s.shipper.client.post(`/api/customs/procedures/${s.exportId}/arrange`, {
          arrangement: 'not_required',
          confirmation: 'x',
        })
      ).data.error,
    ).toBe('required_procedure');
  });
});

describe('customs brokers', () => {
  it('only qualified brokers see the job; two accepting at once: one gets it; the customer’s budget stays private', async () => {
    const s = await norwayShipment();
    const a = await readyCustomsProvider(env, ['DE'], ['export_declaration']);
    const b = await readyCustomsProvider(
      env,
      ['DE', 'NL'],
      ['export_declaration', 'import_declaration'],
    );
    const norwegian = await readyCustomsProvider(env, ['NO'], ['import_declaration']);
    const unverified = await registerCompany(env, 'customs_provider');
    await unverified.client.put('/api/customs-provider/profile', {
      countries: ['DE'],
      services: ['export_declaration'],
    });
    const jobId = await marketplaceExport(s);
    const openA = await a.client.get('/api/customs-provider/jobs/open');
    expect(openA.data.jobs).toHaveLength(1);
    expect(JSON.stringify(openA.data)).not.toContain('20000');
    expect((await norwegian.client.get('/api/customs-provider/jobs/open')).data.jobs).toHaveLength(
      0,
    );
    expect(
      (await unverified.client.post(`/api/customs-provider/jobs/${jobId}/accept`, {})).data.result,
    ).toBe('not_eligible');
    const [ra, rb] = await Promise.all([
      a.client.post(`/api/customs-provider/jobs/${jobId}/accept`, {}),
      b.client.post(`/api/customs-provider/jobs/${jobId}/accept`, {}),
    ]);
    expect([ra.data.result, rb.data.result].sort()).toEqual(['already_assigned', 'assigned']);
    const v = await view(s);
    expect(v.jobs[0].status).toBe('assigned');
    expect(v.parties.find((p: { role: string }) => p.role === 'export_declarant')).toBeTruthy();
    // The broker that lost cannot open the shipment; the winner can
    const winner = ra.data.result === 'assigned' ? a : b;
    const loser = winner === a ? b : a;
    expect((await loser.client.get(`/api/shipments/${s.shipmentId}/customs`)).statusCode).toBe(404);
    expect((await winner.client.get(`/api/shipments/${s.shipmentId}/customs`)).statusCode).toBe(
      200,
    );
  });

  it('a quote above the budget needs the customer’s approval and the difference', async () => {
    const s = await norwayShipment();
    const a = await readyCustomsProvider(env, ['DE'], ['export_declaration']);
    const jobId = await marketplaceExport(s, 10_000);
    const q = await a.client.post(`/api/customs-provider/jobs/${jobId}/accept`, {
      feeMinor: 12_000,
      note: 'Includes the export accompanying document',
    });
    expect(q.data.result).toBe('quote_pending');
    const quote = (await view(s)).jobs[0].quotes[0];
    expect(quote.overBudgetMinor).toBeGreaterThan(0);
    const appr = await s.shipper.client.post(`/api/customs/quotes/${quote.id}/approve`);
    expect(appr.data.result).toBe('payment_required');
    const paid = await s.shipper.client.post(
      `/api/test-payments/${appr.data.payment.paymentRef}/complete`,
      { outcome: 'succeed' },
    );
    expect(paid.data.result).toBe('customs_assigned');
  });
});

describe('documents, parties and border readiness', () => {
  it('stays "documents pending" until the documents are there; versions replace each other', async () => {
    const s = await norwayShipment();
    const a = await readyCustomsProvider(env, ['DE'], ['export_declaration']);
    const jobId = await marketplaceExport(s);
    await a.client.post(`/api/customs-provider/jobs/${jobId}/accept`, {});
    expect(proc(await view(s), s.exportId)).toMatchObject({
      status: 'INFORMATION_MISSING',
      statusReason: 'party:exporter',
    });
    await s.shipper.client.post(`/api/shipments/${s.shipmentId}/customs/parties`, {
      role: 'exporter',
      self: true,
    });
    expect(proc(await view(s), s.exportId)).toMatchObject({
      status: 'DOCUMENTS_PENDING',
      statusReason: 'document:commercial_invoice',
    });
    const upload = (docType: string) =>
      s.shipper.client.post(`/api/shipments/${s.shipmentId}/customs/documents`, {
        docType,
        contentType: 'application/pdf',
        data: pdfBase64(),
      });
    expect((await upload('commercial_invoice')).data.version).toBe(1);
    expect((await upload('commercial_invoice')).data.version).toBe(2);
    await upload('packing_list');
    const v = await view(s);
    expect(proc(v, s.exportId).status).toBe('BROKER_ASSIGNED');
    expect(
      v.documents
        .filter((d: { docType: string; status: string }) => d.docType === 'commercial_invoice')
        .map((d: { status: string }) => d.status),
    ).toEqual(['superseded', 'current']);
    // A wrong file is refused
    expect(
      (
        await s.shipper.client.post(`/api/shipments/${s.shipmentId}/customs/documents`, {
          docType: 'packing_list',
          contentType: 'application/pdf',
          data: Buffer.from('<script>').toString('base64'),
        })
      ).data.error,
    ).toBe('file_type');
  });

  it('another party must confirm before it counts; the border is ready only when export is accepted and import submitted', async () => {
    const s = await norwayShipment();
    const broker = await readyCustomsProvider(env, ['DE'], ['export_declaration']);
    const c = await carrierWithDriver(env, { countries: ['DE', 'NO'] });
    const jobId = await marketplaceExport(s);
    await broker.client.post(`/api/customs-provider/jobs/${jobId}/accept`, {});
    await s.shipper.client.post(`/api/shipments/${s.shipmentId}/customs/parties`, {
      role: 'exporter',
      self: true,
    });
    for (const d of ['commercial_invoice', 'packing_list'])
      await s.shipper.client.post(`/api/shipments/${s.shipmentId}/customs/documents`, {
        docType: d,
        contentType: 'application/pdf',
        data: pdfBase64(),
      });
    // Import: handled by the Norwegian importer (responsible party)
    await s.shipper.client.post(`/api/customs/procedures/${s.importId}/arrange`, {
      arrangement: 'responsible_party',
    });
    await s.shipper.client.post(`/api/shipments/${s.shipmentId}/customs/parties`, {
      role: 'importer_of_record',
      name: 'Oslo Import AS',
      email: 'customs@osloimport.example',
      eori: 'NO123456789',
    });
    for (const role of ['import_declarant', 'duty_payer', 'import_vat_payer'])
      await s.shipper.client.post(`/api/shipments/${s.shipmentId}/customs/parties`, {
        role,
        name: 'Oslo Import AS',
        email: `${role}@osloimport.example`,
      });
    expect(proc(await view(s), s.importId)).toMatchObject({
      status: 'INFORMATION_MISSING',
      statusReason: 'party:importer_of_record',
    });
    for (const to of [
      'customs@osloimport.example',
      'import_declarant@osloimport.example',
      'duty_payer@osloimport.example',
      'import_vat_payer@osloimport.example',
    ]) {
      const token = await lastEmailToken(env, to, 'customs_party_ack');
      expect(
        (
          await new (await import('./helpers')).Client(env).post('/api/customs/confirm', {
            token,
            name: 'Ola Nordmann',
          })
        ).statusCode,
      ).toBe(200);
    }
    expect(proc(await view(s), s.importId).status).toBe('BROKER_ASSIGNED');

    // Export declaration by the broker: a reference is required for "submitted"
    expect(
      (
        await broker.client.post(`/api/customs/procedures/${s.exportId}/status`, {
          status: 'DECLARATION_SUBMITTED',
        })
      ).data.error,
    ).toBe('reference_required');
    expect(
      (
        await broker.client.post(`/api/customs/procedures/${s.exportId}/status`, {
          status: 'DECLARATION_ACCEPTED',
          reference: 'XYZ123',
        })
      ).data.error,
    ).toBe('bad_transition');
    await broker.client.post(`/api/customs/procedures/${s.exportId}/status`, {
      status: 'DECLARATION_SUBMITTED',
      reference: '26DE123456789012A1',
      referenceType: 'MRN',
    });
    await broker.client.post(`/api/customs/procedures/${s.exportId}/status`, {
      status: 'DECLARATION_ACCEPTED',
    });
    // The broker cannot touch the import, which it does not handle
    expect(
      (
        await broker.client.post(`/api/customs/procedures/${s.importId}/status`, {
          status: 'DECLARATION_PREPARING',
        })
      ).statusCode,
    ).toBe(403);

    // Assign the carrier so the driver can look
    const acc = await c.carrier.client.post(`/api/carrier/loads/${s.shipmentId}/accept`, {
      vehicleId: c.carrier.vehicleId,
      idempotencyKey: key(),
    });
    await c.carrier.client.post(`/api/carrier/bookings/${acc.data.bookingId}/assign`, {
      driverId: c.driverId,
    });
    let border = await c.driver.get(`/api/shipments/${s.shipmentId}/border-readiness`);
    expect(border.data).toMatchObject({ required: true, ready: false });
    expect(border.data.missing).toEqual(['Import declaration: not ready yet']);
    // Accepted export alone is not enough; the import is pre-lodged by the importer (entered by the customer)
    await s.shipper.client.post(`/api/customs/procedures/${s.importId}/status`, {
      status: 'DECLARATION_PREPARING',
    });
    await s.shipper.client.post(`/api/customs/procedures/${s.importId}/status`, {
      status: 'DECLARATION_SUBMITTED',
      reference: 'NO26IMP0001',
      referenceType: 'MRN',
    });
    border = await c.driver.get(`/api/shipments/${s.shipmentId}/border-readiness`);
    expect(border.data.ready).toBe(true);
    expect(border.data.references.map((r: { value: string }) => r.value)).toEqual(
      expect.arrayContaining(['26DE123456789012A1', 'NO26IMP0001']),
    );
    expect(border.data.contacts[0].phone).toBe('+49 40 999');
    expect(JSON.stringify(border.data)).not.toMatch(/Minor/);
    // A hold at the border blocks again and tells the customer
    await broker.client.post(`/api/customs/procedures/${s.exportId}/status`, {
      status: 'BORDER_HOLD',
      note: 'Inspection',
    });
    expect(
      (await c.driver.get(`/api/shipments/${s.shipmentId}/border-readiness`)).data.missing,
    ).toEqual(['Export declaration: on hold at customs']);
    const notes = (await s.shipper.client.get('/api/notifications')).data.map(
      (n: { kind: string }) => n.kind,
    );
    expect(notes).toContain('customs.action_needed');
  });
});

describe('customs money', () => {
  it('the broker is paid when its procedures are released; customer gets a customs invoice; books reconcile', async () => {
    const s = await norwayShipment();
    const broker = await readyCustomsProvider(env, ['DE'], ['export_declaration']);
    await settledBankDetails(env, broker.client, broker.orgId);
    const jobId = await marketplaceExport(s);
    const acc = await broker.client.post(`/api/customs-provider/jobs/${jobId}/accept`, {});
    await env.jobs();
    await s.shipper.client.post(`/api/shipments/${s.shipmentId}/customs/parties`, {
      role: 'exporter',
      self: true,
    });
    for (const d of ['commercial_invoice', 'packing_list'])
      await s.shipper.client.post(`/api/shipments/${s.shipmentId}/customs/documents`, {
        docType: d,
        contentType: 'application/pdf',
        data: pdfBase64(),
      });
    for (const [st, ref] of [
      ['DECLARATION_SUBMITTED', 'MRN1'],
      ['DECLARATION_ACCEPTED'],
      ['RELEASED'],
    ] as const)
      expect(
        (
          await broker.client.post(`/api/customs/procedures/${s.exportId}/status`, {
            status: st,
            ...(ref ? { reference: ref } : {}),
          })
        ).statusCode,
      ).toBe(200);
    await env.jobs();
    const [o] = await env.ctx.db
      .select()
      .from(carrierObligations)
      .where(eq(carrierObligations.kind, 'customs'));
    expect(o).toMatchObject({ status: 'payable', amountMinor: acc.data.feeMinor });
    const [p] = await env.ctx.db.select().from(payouts).where(eq(payouts.obligationId, o!.id));
    expect(p!.status).toBe('pending');
    const inv = await s.shipper.client.get('/api/org/invoices');
    expect(inv.data.map((i: { kind: string }) => i.kind)).toContain('customs_invoice');
    expect((await broker.client.get('/api/org/invoices')).data[0].kind).toBe('customs_statement');
    const admin = await adminClient(env);
    const rec = await admin.get('/api/admin/reconciliation');
    expect(rec.data.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    expect(await env.ctx.db.select().from(emailOutbox)).not.toHaveLength(0);
  });
});
