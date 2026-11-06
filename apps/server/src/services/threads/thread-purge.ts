import {
  deleteThread,
  deleteThreadPurgeBatch,
  listRunningThreads,
  nextThreadPurge,
} from "@bb/db";
import type { AppDeps } from "../../types.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";

const THREAD_PURGE_SLICE_MS = 10;
const BUSY_REST_FACTOR = 9;
const IDLE_REST_FACTOR = 1;
const IDLE_POLL_MS = 60_000;
const PURGE_EVENT_ROWS = 64;
const PURGE_EVENT_BYTES = 512 * 1024;
const PURGE_ROWS = 128;
const STEP_COST_SMOOTHING = 0.2;

type ThreadPurgeDeps = Pick<AppDeps, "db" | "hub" | "logger">;

export function advanceThreadPurge(deps: Pick<AppDeps, "db" | "hub">): boolean {
  const notifications = new NotificationBuffer();
  const worked = deps.db.transaction(
    (tx) => {
      const threadId = nextThreadPurge(tx);
      if (threadId === null) return false;
      const deleted = deleteThreadPurgeBatch(tx, {
        maxEventBytes: PURGE_EVENT_BYTES,
        maxEventRows: PURGE_EVENT_ROWS,
        maxRows: PURGE_ROWS,
        threadId,
      });
      if (deleted === 0) deleteThread(tx, notifications, threadId);
      return true;
    },
    { behavior: "immediate" },
  );
  notifications.flushInto(deps.hub);
  return worked;
}

const wakers = new Set<() => void>();

export function wakeThreadPurging(): void {
  for (const wake of wakers) wake();
}

export function startThreadPurging(
  deps: ThreadPurgeDeps,
  options: { isFrozen(): boolean },
): { stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let stepCostMs = 0;
  let resting = false;

  const schedule = (delayMs: number, afterWork: boolean) => {
    if (stopped) return;
    resting = afterWork;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(tick, delayMs);
    timer.unref();
  };

  function tick(): void {
    timer = null;
    if (stopped) return;
    if (options.isFrozen()) {
      schedule(IDLE_POLL_MS, false);
      return;
    }
    const startedAt = performance.now();
    let idle = false;
    try {
      do {
        const stepStartedAt = performance.now();
        idle = !advanceThreadPurge(deps);
        stepCostMs += STEP_COST_SMOOTHING * (performance.now() - stepStartedAt - stepCostMs);
      } while (
        !idle &&
        !stopped &&
        performance.now() - startedAt + stepCostMs <= THREAD_PURGE_SLICE_MS
      );
    } catch (error) {
      deps.logger.warn({ err: error }, "Thread purge step failed");
      schedule(IDLE_POLL_MS, false);
      return;
    }
    if (idle) {
      schedule(IDLE_POLL_MS, false);
      return;
    }
    const busy = deps.hub.hasClients() || listRunningThreads(deps.db).length > 0;
    const worked = performance.now() - startedAt;
    schedule(Math.max(1, worked * (busy ? BUSY_REST_FACTOR : IDLE_REST_FACTOR)), true);
  }

  const wake = () => {
    if (!resting) schedule(0, false);
  };
  wakers.add(wake);
  schedule(0, false);
  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      wakers.delete(wake);
    },
  };
}
