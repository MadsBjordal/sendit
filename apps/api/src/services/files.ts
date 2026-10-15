import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import type { DbOrTx } from '../db/client';
import { files } from '../db/schema';
import { badRequest, notFound } from '../lib/errors';
import { shipmentAccess } from './access';
import type { SessionInfo } from './auth';

export const FILE_KINDS = [
  'photo',
  'signature',
  'pod',
  'document',
  'invoice',
  'statement',
  'evidence',
  'message',
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

const ALLOWED: Record<string, { magic: number[][]; maxBytes: number }> = {
  'image/jpeg': { magic: [[0xff, 0xd8, 0xff]], maxBytes: 10_000_000 },
  'image/png': { magic: [[0x89, 0x50, 0x4e, 0x47]], maxBytes: 10_000_000 },
  'image/webp': { magic: [[0x52, 0x49, 0x46, 0x46]], maxBytes: 10_000_000 },
  'application/pdf': { magic: [[0x25, 0x50, 0x44, 0x46]], maxBytes: 15_000_000 },
};

/**
 * Stores a file privately. Only images and PDFs are accepted, checked by their first bytes (not
 * just the declared type), and within a size limit.
 */
export async function saveFile(
  ctx: Ctx,
  db: DbOrTx,
  input: {
    orgId: string | null;
    shipmentId: string | null;
    kind: FileKind;
    contentType: string;
    data: Buffer;
    fileName?: string | null;
    uploadedBy: string | null;
  },
) {
  const rule = ALLOWED[input.contentType];
  if (!rule)
    throw badRequest('file_type', 'Only JPEG, PNG, WebP images and PDF files are accepted');
  if (input.data.length === 0 || input.data.length > rule.maxBytes)
    throw badRequest(
      'file_size',
      `The file must be between 1 byte and ${rule.maxBytes / 1_000_000} MB`,
    );
  if (!rule.magic.some((m) => m.every((b, i) => input.data[i] === b)))
    throw badRequest('file_type', 'The file content does not match its type');
  const id = randomUUID();
  const key = `${new Date().toISOString().slice(0, 7)}/${id}`;
  await ctx.storage.put(key, input.data, input.contentType);
  const [row] = await db
    .insert(files)
    .values({
      id,
      orgId: input.orgId,
      shipmentId: input.shipmentId,
      kind: input.kind,
      storageKey: key,
      contentType: input.contentType,
      sizeBytes: input.data.length,
      sha256: createHash('sha256').update(input.data).digest('hex'),
      fileName: input.fileName?.slice(0, 200) ?? null,
      uploadedBy: input.uploadedBy,
    })
    .returning();
  return row!;
}

/** A file, if this person may see it: through its shipment, or as a member of the owning organisation. */
export async function readFileFor(ctx: Ctx, session: SessionInfo | null, fileId: string) {
  if (!session) throw notFound();
  const [f] = await ctx.db.select().from(files).where(eq(files.id, fileId));
  if (!f) throw notFound();
  if (f.shipmentId) {
    const { role } = await shipmentAccess(ctx, session, f.shipmentId);
    // Invoices and statements belong to one side only
    if (
      (f.kind === 'invoice' || f.kind === 'statement') &&
      role !== 'platform' &&
      f.orgId !== session.org?.id
    )
      throw notFound();
  } else if (
    !(f.orgId && f.orgId === session.org?.id) &&
    !(session.user.platformRole && session.mfaPassed)
  )
    throw notFound();
  return { file: f, data: await ctx.storage.get(f.storageKey) };
}
