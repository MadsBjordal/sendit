import { sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import type { DbOrTx } from '../db/client';
import { jobs } from '../db/schema';

/**
 * A small, reliable job queue inside PostgreSQL (DECISIONS.md D-005): jobs are written in the same
 * transaction as the change that needs them (so they are never lost or sent for a change that
 * was rolled back), picked with FOR UPDATE SKIP LOCKED, retried with back-off, and parked as
 * "dead" after max_attempts for an operator to look at.
 */
export type JobHandler = (ctx: Ctx, payload: Record<string, unknown>) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJob(kind: string, handler: JobHandler) {
  handlers.set(kind, handler);
}

export async function enqueue(
  db: DbOrTx,
  kind: string,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {},
) {
  await db
    .insert(jobs)
    .values({
      kind,
      payload,
      runAt: opts.runAt ?? new Date(),
      dedupeKey: opts.dedupeKey ?? null,
      maxAttempts: opts.maxAttempts ?? 8,
    })
    .onConflictDoNothing();
}

function backoffMs(attempts: number) {
  return Math.min(60 * 60_000, 2 ** attempts * 5_000);
}

/** Runs due jobs until none are left (or `limit`). Returns how many ran. */
export async function runDueJobs(ctx: Ctx, limit = 100): Promise<number> {
  let ran = 0;
  while (ran < limit) {
    const now = ctx.now();
    const picked = await ctx.db.execute<{
      id: number;
      kind: string;
      payload: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
    }>(sql`
      UPDATE jobs SET status = 'running', locked_at = ${now.toISOString()}, attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs WHERE status = 'queued' AND run_at <= ${now.toISOString()}
        ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING id, kind, payload, attempts, max_attempts`);
    const job = picked.rows[0];
    if (!job) break;
    ran++;
    const handler = handlers.get(job.kind);
    try {
      if (!handler) throw new Error(`no handler for job kind ${job.kind}`);
      await handler(ctx, job.payload);
      await ctx.db.execute(
        sql`UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL WHERE id = ${job.id}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const dead = job.attempts >= job.max_attempts;
      ctx.log.warn(
        `[job ${job.id} ${job.kind}] attempt ${job.attempts} failed: ${message}${dead ? ' (dead)' : ''}`,
      );
      await ctx.db.execute(sql`
        UPDATE jobs SET status = ${dead ? 'dead' : 'queued'}, last_error = ${message},
          run_at = ${new Date(now.getTime() + backoffMs(job.attempts)).toISOString()},
          finished_at = ${dead ? sql`now()` : null}
        WHERE id = ${job.id}`);
    }
  }
  return ran;
}

/** Background worker loop for the server process. */
export function startWorker(ctx: Ctx, intervalMs = 1_000): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      await runDueJobs(ctx, 50);
    } catch (err) {
      ctx.log.error({ msg: 'job worker failed', err });
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
