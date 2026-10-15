import type { DbOrTx } from '../db/client';
import { auditLogs, shipmentEvents } from '../db/schema';

export interface Actor {
  userId?: string | null;
  orgId?: string | null;
  ip?: string | null;
}

export async function audit(
  db: DbOrTx,
  actor: Actor,
  action: string,
  target?: { type: string; id: string },
  data: object = {},
) {
  await db.insert(auditLogs).values({
    actorUserId: actor.userId ?? null,
    actorOrgId: actor.orgId ?? null,
    action,
    targetType: target?.type ?? null,
    targetId: target?.id ?? null,
    ip: actor.ip ?? null,
    data,
  });
}

export async function shipmentEvent(
  db: DbOrTx,
  shipmentId: string,
  kind: string,
  actor: Actor,
  data: object = {},
) {
  await db
    .insert(shipmentEvents)
    .values({
      shipmentId,
      kind,
      actorUserId: actor.userId ?? null,
      actorOrgId: actor.orgId ?? null,
      data,
    });
}
