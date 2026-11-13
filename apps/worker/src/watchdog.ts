import { type AppDatabase, appendAudit } from "@proofdesk/db";
import { type Kysely, sql } from "kysely";

/** How the agent did for one tenant on one route, as counts. */
export type HealthRow = {
  tenantId: string;
  route: "stable" | "canary";
  /** Tickets the agent finished in the window. */
  finished: number;
  /** Of those, the ones that ended without a clean resolution. */
  failed: number;
  /** Of those, the ones the reply guard stopped. */
  guard: number;
};

export type Thresholds = {
  /** A route is judged only once it has finished this many tickets. */
  minSample: number;
  /** The canary is rolled back when its failure rate exceeds the stable build's by this much. */
  canaryExcessFailureRate: number;
  /** A tenant's agent is paused when the reply guard stopped this many of its tickets. */
  guardStopsToPause: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  minSample: 10,
  canaryExcessFailureRate: 0.2,
  guardStopsToPause: 5,
};

export type WatchdogAction =
  | { kind: "rollback_canary"; detail: Record<string, number> }
  | { kind: "pause_agent"; tenantId: string; detail: Record<string, number> };

/**
 * Decides what to do about the numbers. A pure function of counts and
 * thresholds: no model, no judgment, and the same answer every time.
 *
 * Both actions only ever stop something. The watchdog cannot widen a canary
 * or restart an agent; a person does that.
 */
export function assess(rows: HealthRow[], thresholds: Thresholds): WatchdogAction[] {
  const actions: WatchdogAction[] = [];
  const total = (route: HealthRow["route"]) =>
    rows
      .filter((row) => row.route === route)
      .reduce(
        (sum, row) => ({
          finished: sum.finished + row.finished,
          failed: sum.failed + row.failed,
        }),
        { finished: 0, failed: 0 },
      );
  const rate = (sum: { finished: number; failed: number }) =>
    sum.finished === 0 ? 0 : sum.failed / sum.finished;

  const canary = total("canary");
  const stable = total("stable");
  if (
    canary.finished >= thresholds.minSample &&
    rate(canary) - rate(stable) > thresholds.canaryExcessFailureRate
  ) {
    actions.push({
      kind: "rollback_canary",
      detail: {
        canaryFinished: canary.finished,
        canaryFailed: canary.failed,
        stableFinished: stable.finished,
        stableFailed: stable.failed,
      },
    });
  }

  // A guard stop means the model said it did something it did not. On the
  // stable build that is not a bad deploy to roll back; it is a reason to
  // stop and have a person look.
  for (const row of rows) {
    if (row.route === "stable" && row.guard >= thresholds.guardStopsToPause) {
      actions.push({
        kind: "pause_agent",
        tenantId: row.tenantId,
        detail: { finished: row.finished, guardStops: row.guard },
      });
    }
  }
  return actions;
}

export type WatchdogDeps = {
  /** Connection as `worker_app`. */
  db: Kysely<AppDatabase>;
  clock: () => Date;
  /** How far back to look. */
  windowMinutes?: number;
  thresholds?: Thresholds;
  /** Tells a person. Called once per action taken, never for one already in effect. */
  notify?: (alert: { kind: string; tenantId: string | null; detail: unknown }) => Promise<void>;
};

const ACTOR = "system:watchdog";
/** The audit log's tenant for an entry about the whole system. */
const PLATFORM = "*";

export function createWatchdogActivities(deps: WatchdogDeps) {
  const thresholds = deps.thresholds ?? DEFAULT_THRESHOLDS;

  return {
    /**
     * Looks at how the agent has been doing and acts on it. Returns the
     * actions it took. An action already in effect is not taken, alerted or
     * recorded again, so running this every minute is quiet.
     */
    async watch(): Promise<WatchdogAction[]> {
      const now = deps.clock();
      const since = new Date(now.getTime() - (deps.windowMinutes ?? 60) * 60_000);
      const health = await sql<HealthRow>`select * from agent_health(${since})`.execute(deps.db);

      const taken: WatchdogAction[] = [];
      for (const action of assess(health.rows, thresholds)) {
        const tenantId = action.kind === "pause_agent" ? action.tenantId : null;
        const changed =
          action.kind === "rollback_canary"
            ? await sql<{ changed: boolean }>`
                select rollback_canary(
                  'Canary failure rate above the stable build', ${ACTOR}, ${now}
                ) as changed`.execute(deps.db)
            : await sql<{ changed: boolean }>`
                select pause_agent(
                  ${action.tenantId}, 'agent', 'The reply guard stopped too many replies',
                  ${ACTOR}, ${now}
                ) as changed`.execute(deps.db);
        if (!changed.rows[0]?.changed) continue;

        const detail = { ...action.detail, ...thresholds };
        await sql`
          select raise_alert(${action.kind}, ${tenantId}, ${JSON.stringify(detail)}::jsonb, ${ACTOR}, ${now})
        `.execute(deps.db);
        await appendAudit(deps.db, {
          tenantId: tenantId ?? PLATFORM,
          at: now,
          actor: ACTOR,
          event: action.kind === "rollback_canary" ? "canary_rolled_back" : "agent_paused",
          detail,
        });
        await deps.notify?.({ kind: action.kind, tenantId, detail });
        taken.push(action);
      }
      return taken;
    },
  };
}

export type WatchdogActivities = ReturnType<typeof createWatchdogActivities>;
