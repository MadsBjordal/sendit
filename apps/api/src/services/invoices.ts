import { and, desc, eq, sql } from 'drizzle-orm';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Ctx } from '../context';
import type { Tx } from '../db/client';
import {
  bookings,
  carrierObligations,
  customsJobs,
  invoices,
  invoiceSequences,
  organisations,
  shipmentLocations,
  shipments,
} from '../db/schema';
import { saveFile } from './files';
import { registerJob } from './jobs';
import { shipmentNumber } from './shipments';

/**
 * Invoices. The customer invoice is issued when a booking is confirmed (the price is final and paid);
 * the carrier gets a payment statement when its payout starts. Numbers have no gaps per series and
 * year. The seller's legal details come from the configuration; without them the PDF says DRAFT.
 * Invoice content and the VAT wording must be approved by the tax adviser (COMPLIANCE.md gate 11).
 */
const SERIES: Record<string, string> = {
  customer_invoice: 'INV',
  carrier_statement: 'CST',
  credit_note: 'CRN',
  customs_invoice: 'CIN',
  customs_statement: 'CCS',
};

async function nextNumber(tx: Tx, kind: string, at: Date): Promise<string> {
  const series = SERIES[kind]!;
  const year = at.getUTCFullYear();
  await tx.insert(invoiceSequences).values({ series, year, last: 0 }).onConflictDoNothing();
  const [row] = await tx
    .update(invoiceSequences)
    .set({ last: sql`${invoiceSequences.last} + 1` })
    .where(and(eq(invoiceSequences.series, series), eq(invoiceSequences.year, year)))
    .returning();
  return `${series}-${year}-${String(row!.last).padStart(6, '0')}`;
}

export interface InvoiceLine {
  description: string;
  netMinor: number;
}

function money(minor: number, currency: string) {
  return `${(minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

async function renderPdf(
  ctx: Ctx,
  inv: {
    number: string;
    kind: string;
    issuedAt: Date;
    currency: string;
    netMinor: number;
    vatMinor: number;
    totalMinor: number;
    vatBp: number;
    taxNote: string;
    lines: InvoiceLine[];
  },
  buyer: { name: string; country: string; vatNumber: string | null },
  shipmentNo: string | null,
) {
  const seller = ctx.config.legalEntity;
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const safe = (t: string) => t.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
  let y = 790;
  const text = (
    t: string,
    x: number,
    opts: { size?: number; f?: typeof font; color?: [number, number, number] } = {},
  ) =>
    page.drawText(safe(t), {
      x,
      y,
      size: opts.size ?? 10,
      font: opts.f ?? font,
      color: rgb(...(opts.color ?? [0.1, 0.1, 0.15])),
    });
  const title =
    {
      customer_invoice: 'Invoice',
      carrier_statement: 'Payment statement',
      credit_note: 'Credit note',
      customs_invoice: 'Invoice (customs services)',
      customs_statement: 'Payment statement (customs services)',
    }[inv.kind] ?? 'Invoice';
  if (!seller.complete) {
    text('DRAFT - the legal entity is not configured yet; not a valid invoice', 50, {
      f: bold,
      color: [0.7, 0.1, 0.1],
    });
    y -= 22;
  }
  text(seller.name, 50, { size: 14, f: bold });
  y -= 15;
  for (const l of [seller.address, seller.vatNumber ? `VAT ${seller.vatNumber}` : null].filter(
    Boolean,
  ) as string[]) {
    text(l, 50);
    y -= 13;
  }
  y -= 20;
  text(`${title} ${inv.number}`, 50, { size: 18, f: bold });
  y -= 18;
  text(
    `Date ${inv.issuedAt.toISOString().slice(0, 10)}${shipmentNo ? `   Shipment ${shipmentNo}` : ''}`,
    50,
  );
  y -= 30;
  text(
    inv.kind === 'carrier_statement' || inv.kind === 'customs_statement' ? 'Paid to' : 'Bill to',
    50,
    { f: bold },
  );
  y -= 14;
  text(buyer.name, 50);
  y -= 13;
  text(`${buyer.country}${buyer.vatNumber ? `   VAT ${buyer.vatNumber}` : ''}`, 50);
  y -= 30;
  text('Description', 50, { f: bold });
  text('Amount', 470, { f: bold });
  y -= 16;
  for (const l of inv.lines) {
    text(l.description.slice(0, 80), 50);
    text(money(l.netMinor, inv.currency), 470);
    y -= 14;
  }
  y -= 10;
  page.drawLine({
    start: { x: 50, y: y + 6 },
    end: { x: 545, y: y + 6 },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.75),
  });
  y -= 8;
  text('Net', 380);
  text(money(inv.netMinor, inv.currency), 470);
  y -= 14;
  text(`VAT ${(inv.vatBp / 100).toFixed(2)} %`, 380);
  text(money(inv.vatMinor, inv.currency), 470);
  y -= 14;
  text('Total', 380, { f: bold });
  text(money(inv.totalMinor, inv.currency), 470, { f: bold });
  y -= 28;
  text(inv.taxNote, 50, { size: 9 });
  y -= 14;
  text(
    inv.kind === 'customer_invoice'
      ? 'Paid in advance. Thank you.'
      : inv.kind.endsWith('statement')
        ? 'Self-billing statement: issued by us on your behalf where a self-billing agreement exists.'
        : '',
    50,
    { size: 9 },
  );
  return Buffer.from(await pdf.save());
}

async function issue(
  ctx: Ctx,
  tx: Tx,
  a: {
    kind: string;
    orgId: string;
    shipmentId: string | null;
    refType: string;
    refId: string;
    currency: string;
    netMinor: number;
    vatMinor: number;
    vatBp: number;
    taxNote: string;
    lines: InvoiceLine[];
  },
) {
  const [existing] = await tx
    .select()
    .from(invoices)
    .where(
      and(eq(invoices.kind, a.kind), eq(invoices.refType, a.refType), eq(invoices.refId, a.refId)),
    );
  if (existing) return existing;
  const issuedAt = ctx.now();
  const number = await nextNumber(tx, a.kind, issuedAt);
  const totalMinor = a.netMinor + a.vatMinor;
  const [buyer] = await tx.select().from(organisations).where(eq(organisations.id, a.orgId));
  const [s] = a.shipmentId
    ? await tx
        .select({ number: shipments.number })
        .from(shipments)
        .where(eq(shipments.id, a.shipmentId))
    : [];
  const pdf = await renderPdf(
    ctx,
    { ...a, number, issuedAt, totalMinor },
    { name: buyer!.name, country: buyer!.country, vatNumber: buyer!.vatNumber },
    s ? shipmentNumber(s.number) : null,
  );
  const file = await saveFile(ctx, tx, {
    orgId: a.orgId,
    shipmentId: a.shipmentId,
    kind: a.kind.endsWith('statement') ? 'statement' : 'invoice',
    contentType: 'application/pdf',
    data: pdf,
    fileName: `${number}.pdf`,
    uploadedBy: null,
  });
  const [row] = await tx
    .insert(invoices)
    .values({
      number,
      kind: a.kind,
      orgId: a.orgId,
      shipmentId: a.shipmentId,
      refType: a.refType,
      refId: a.refId,
      currency: a.currency,
      netMinor: a.netMinor,
      vatMinor: a.vatMinor,
      totalMinor,
      vatBp: a.vatBp,
      taxNote: a.taxNote,
      lines: a.lines,
      fileId: file.id,
      issuedAt,
    })
    .returning();
  return row!;
}

async function route(tx: Tx, shipmentId: string) {
  const locs = await tx
    .select()
    .from(shipmentLocations)
    .where(eq(shipmentLocations.shipmentId, shipmentId));
  const p = locs.find((l) => l.kind === 'pickup')!;
  const d = locs.find((l) => l.kind === 'delivery')!;
  return `${p.city} (${p.country}) - ${d.city} (${d.country})`;
}

registerJob('issue_customer_invoice', async (ctx, payload) => {
  const { bookingId } = payload as { bookingId: string };
  await ctx.db.transaction(async (tx) => {
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, bookingId));
    if (!b) return;
    const [s] = await tx.select().from(shipments).where(eq(shipments.id, b.shipmentId));
    const reverse = b.vatMinor === 0;
    await issue(ctx, tx, {
      kind: 'customer_invoice',
      orgId: s!.orgId,
      shipmentId: s!.id,
      refType: 'booking',
      refId: b.id,
      currency: b.currency,
      netMinor: b.netMinor,
      vatMinor: b.vatMinor,
      vatBp: reverse ? 0 : Math.round((b.vatMinor * 10_000) / b.netMinor),
      taxNote: reverse
        ? 'VAT reverse charge: the customer accounts for VAT (to be confirmed per country by the tax adviser).'
        : 'VAT charged at the domestic rate.',
      lines: [
        {
          description: `Road transport ${await route(tx, s!.id)}, ${s!.serviceLevel} (${shipmentNumber(s!.number)})`,
          netMinor: b.netMinor,
        },
      ],
    });
  });
});

registerJob('issue_carrier_statement', async (ctx, payload) => {
  const { obligationId } = payload as { obligationId: string };
  await ctx.db.transaction(async (tx) => {
    const [o] = await tx
      .select()
      .from(carrierObligations)
      .where(eq(carrierObligations.id, obligationId));
    if (!o) return;
    let shipmentId: string;
    let description: string;
    if (o.kind === 'customs') {
      const [j] = await tx.select().from(customsJobs).where(eq(customsJobs.id, o.customsJobId!));
      const [s] = await tx.select().from(shipments).where(eq(shipments.id, j!.shipmentId));
      shipmentId = s!.id;
      description = `Customs service ${j!.service.replaceAll('_', ' ')} in ${j!.country} (${shipmentNumber(s!.number)})`;
    } else {
      const [b] = await tx.select().from(bookings).where(eq(bookings.id, o.bookingId!));
      const [s] = await tx.select().from(shipments).where(eq(shipments.id, b!.shipmentId));
      shipmentId = s!.id;
      description = `Transport ${await route(tx, s!.id)} (${shipmentNumber(s!.number)})`;
    }
    await issue(ctx, tx, {
      kind: o.kind === 'customs' ? 'customs_statement' : 'carrier_statement',
      orgId: o.carrierOrgId,
      shipmentId,
      refType: 'obligation',
      refId: o.id,
      currency: o.currency,
      netMinor: o.amountMinor,
      vatMinor: 0,
      vatBp: 0,
      taxNote:
        'Amount agreed at assignment. VAT treatment of the service to be confirmed by the tax adviser.',
      lines: [{ description, netMinor: o.amountMinor }],
    });
  });
});

/** Invoice for the customs service fee, issued when a provider is assigned. */
export async function issueCustomsInvoice(ctx: Ctx, jobId: string) {
  await ctx.db.transaction(async (tx) => {
    const [j] = await tx.select().from(customsJobs).where(eq(customsJobs.id, jobId));
    if (!j || !j.priceMinor) return;
    const [s] = await tx.select().from(shipments).where(eq(shipments.id, j.shipmentId));
    const net = (j.providerFeeMinor ?? 0) + (j.platformFeeMinor ?? 0);
    const vat = j.priceMinor - net;
    await issue(ctx, tx, {
      kind: 'customs_invoice',
      orgId: j.orgId,
      shipmentId: j.shipmentId,
      refType: 'customs_job',
      refId: j.id,
      currency: j.currency,
      netMinor: net,
      vatMinor: vat,
      vatBp: vat === 0 ? 0 : Math.round((vat * 10_000) / net),
      taxNote:
        vat === 0
          ? 'VAT reverse charge assumed (to be confirmed by the tax adviser). Customs duties and import VAT are not included.'
          : 'Customs duties and import VAT are not included.',
      lines: [
        {
          description: `Customs service: ${j.service.replaceAll('_', ' ')} in ${j.country} (${shipmentNumber(s!.number)})`,
          netMinor: net,
        },
      ],
    });
  });
}

export async function listInvoices(ctx: Ctx, orgId: string) {
  return ctx.db
    .select({
      id: invoices.id,
      number: invoices.number,
      kind: invoices.kind,
      totalMinor: invoices.totalMinor,
      vatMinor: invoices.vatMinor,
      currency: invoices.currency,
      issuedAt: invoices.issuedAt,
      fileId: invoices.fileId,
      shipmentId: invoices.shipmentId,
    })
    .from(invoices)
    .where(eq(invoices.orgId, orgId))
    .orderBy(desc(invoices.issuedAt))
    .limit(500);
}
