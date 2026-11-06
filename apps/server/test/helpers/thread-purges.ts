import type { AppDeps } from "../../src/types.js";
import { advanceThreadPurge } from "../../src/services/threads/thread-purge.js";

export function runThreadPurges(deps: Pick<AppDeps, "db" | "hub">): void {
  while (advanceThreadPurge(deps)) {}
}
