import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { countryCode } from '@freight/shared';
import type { Ctx } from '../context';
import { savedAddresses } from '../db/schema';
import { notFound } from '../lib/errors';
import type { Actor } from './audit';

export const savedAddressSchema = z.object({
  label: z.string().trim().min(1).max(100),
  addressLine: z.string().trim().min(3).max(300),
  postcode: z.string().trim().min(2).max(16),
  city: z.string().trim().min(1).max(120),
  country: countryCode,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  contactName: z.string().trim().max(200).nullable().optional(),
  contactPhone: z.string().trim().max(40).nullable().optional(),
  hasForklift: z.boolean().default(false),
  hasLoadingDock: z.boolean().default(false),
  instructions: z.string().trim().max(2000).nullable().optional(),
});

export async function listAddresses(ctx: Ctx, orgId: string) {
  return ctx.db
    .select()
    .from(savedAddresses)
    .where(eq(savedAddresses.orgId, orgId))
    .orderBy(desc(sql`coalesce(${savedAddresses.lastUsedAt}, ${savedAddresses.createdAt})`))
    .limit(200);
}

export async function saveAddress(
  ctx: Ctx,
  actor: Actor & { orgId: string },
  input: z.infer<typeof savedAddressSchema>,
) {
  // The same place saved twice is updated, not duplicated
  const [same] = await ctx.db
    .select()
    .from(savedAddresses)
    .where(
      and(
        eq(savedAddresses.orgId, actor.orgId),
        eq(savedAddresses.addressLine, input.addressLine),
        eq(savedAddresses.postcode, input.postcode),
        eq(savedAddresses.country, input.country),
      ),
    );
  const values = {
    ...input,
    contactName: input.contactName ?? null,
    contactPhone: input.contactPhone ?? null,
    instructions: input.instructions ?? null,
  };
  if (same) {
    const [row] = await ctx.db
      .update(savedAddresses)
      .set(values)
      .where(eq(savedAddresses.id, same.id))
      .returning();
    return row!;
  }
  const [row] = await ctx.db
    .insert(savedAddresses)
    .values({ ...values, orgId: actor.orgId })
    .returning();
  return row!;
}

export async function deleteAddress(ctx: Ctx, actor: Actor & { orgId: string }, id: string) {
  const res = await ctx.db
    .delete(savedAddresses)
    .where(and(eq(savedAddresses.id, id), eq(savedAddresses.orgId, actor.orgId)))
    .returning({ id: savedAddresses.id });
  if (!res[0]) throw notFound();
}

/** Marks saved places used by a new shipment, so the most used come first. */
export async function touchAddresses(
  ctx: Ctx,
  orgId: string,
  places: Array<{ addressLine: string; postcode: string; country: string }>,
) {
  for (const p of places)
    await ctx.db
      .update(savedAddresses)
      .set({ lastUsedAt: ctx.now() })
      .where(
        and(
          eq(savedAddresses.orgId, orgId),
          eq(savedAddresses.addressLine, p.addressLine),
          eq(savedAddresses.postcode, p.postcode),
          eq(savedAddresses.country, p.country),
        ),
      );
}
