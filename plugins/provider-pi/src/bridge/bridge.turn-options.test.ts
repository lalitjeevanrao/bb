import { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { PiRpcSession } from "./rpc-session.js";
import type {
  BridgeJsonRpcObject,
  BridgeJsonRpcOutputMessage,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  FULL_PERMISSION_OPTIONS,
  fakePiPath,
  type FakePiBridgeHarness,
  startFakePiBridge,
} from "./test-support.js";

const TURN_OPTIONS_TEST_TIMEOUT_MS = 60_000;

const MINI = {
  ...FULL_PERMISSION_OPTIONS,
  model: "fake-provider/fake-mini",
  reasoningLevel: "medium",
};
const FULL_MODEL = { ...MINI, model: "fake-provider/fake-model" };

const sessionReplacedParamsSchema = z.object({
  threadId: z.string(),
  providerThreadId: z.string().nullable(),
  reason: z.string(),
  contextLost: z.boolean(),
});

let harness: FakePiBridgeHarness;

beforeEach(async () => {
  harness = await startFakePiBridge({
    prefix: "bb-pi-turn-options-",
    initialize: true,
  });
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 30_000);

function sessionReplacements(
  threadId: string,
): z.infer<typeof sessionReplacedParamsSchema>[] {
  return harness.messages
    .filter((message) => message.method === "session/replaced")
    .map((message) => sessionReplacedParamsSchema.parse(message.params))
    .filter((params) => params.threadId === threadId);
}

function contextWindowSizes(threadId: string): number[] {
  return harness
    .deltasOf(threadId)
    .filter((delta) => delta.kind === "contextWindow")
    .map((delta) => delta.size)
    .filter((size): size is number => typeof size === "number");
}

function providerThreadIdFor(threadId: string): string {
  const identity = [...harness.messages]
    .reverse()
    .find(
      (message) =>
        message.method === "thread/identity" &&
        (message.params as { threadId?: unknown }).threadId === threadId,
    );
  const providerThreadId = (identity?.params as { providerThreadId?: unknown })
    .providerThreadId;
  expect(typeof providerThreadId).toBe("string");
  if (typeof providerThreadId !== "string")
    throw new Error("missing provider thread identity");
  return providerThreadId;
}

function turnStart(
  id: number,
  threadId: string,
  text: string,
  options: BridgeJsonRpcObject,
): Promise<BridgeJsonRpcOutputMessage> {
  return harness.request(id, "turn/start", {
    threadId,
    providerThreadId: providerThreadIdFor(threadId),
    clientRequestId: `creq_abcdefghi${"23456789"[id % 8] ?? "2"}`,
    input: [{ type: "text", text, mentions: [] }],
    options,
  });
}

it(
  "rebuilds the session with environment from a later turn",
  async () => {
    const threadId = "thr_turn_options_env";
    const envLog = join(harness.workspaceDir, "env.log");
    const options = (marker: string) => ({
      ...MINI,
      envVars: { FAKE_PI_ENV_LOG: envLog, FAKE_PI_ENV_MARKER: marker },
    });
    await harness.startThread(threadId, { options: options("first") });

    expect(
      (await turnStart(1, threadId, "first", options("first"))).error,
    ).toBeUndefined();
    const seen = await harness.waitForTurnBoundary(threadId, 0);
    expect(
      (await turnStart(2, threadId, "second", options("second"))).error,
    ).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);

    expect(readFileSync(envLog, "utf8").trim().split("\n")).toEqual([
      "first",
      "second",
    ]);
    expect(sessionReplacements(threadId)).toHaveLength(1);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "rebuilds the session on the model a later turn carries",
  async () => {
    const threadId = "thr_turn_options_model";
    const start = await harness.startThread(threadId, { options: MINI });
    const originalProviderThreadId = providerThreadIdFor(threadId);
    expect(start.result).toMatchObject({
      providerThreadId: originalProviderThreadId,
    });

    expect((await turnStart(1, threadId, "first", MINI)).error).toBeUndefined();
    let seen = await harness.waitForTurnBoundary(threadId, 0);
    expect(contextWindowSizes(threadId)).toEqual([32_000]);
    expect(sessionReplacements(threadId)).toEqual([]);

    expect(
      (await turnStart(2, threadId, "second", FULL_MODEL)).error,
    ).toBeUndefined();
    seen = await harness.waitForTurnBoundary(threadId, seen);

    expect(contextWindowSizes(threadId).at(-1)).toBe(200_000);
    expect(sessionReplacements(threadId)).toEqual([
      {
        threadId,
        providerThreadId: originalProviderThreadId,
        reason: expect.stringContaining("Execution settings changed"),
        contextLost: false,
      },
    ]);
    expect(
      harness
        .deltasOf(threadId)
        .filter((delta) => delta.kind === "session.reset"),
    ).toHaveLength(2);

    expect(
      (await turnStart(3, threadId, "third", FULL_MODEL)).error,
    ).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);
    expect(sessionReplacements(threadId)).toHaveLength(1);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "rebuilds the session on the reasoning level a later turn carries",
  async () => {
    const threadId = "thr_turn_options_level";
    await harness.startThread(threadId, { options: MINI });

    expect((await turnStart(1, threadId, "first", MINI)).error).toBeUndefined();
    const seen = await harness.waitForTurnBoundary(threadId, 0);
    expect(sessionReplacements(threadId)).toEqual([]);

    expect(
      (
        await turnStart(2, threadId, "second", {
          ...MINI,
          reasoningLevel: "high",
        })
      ).error,
    ).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);

    expect(sessionReplacements(threadId)).toHaveLength(1);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "compacts with the model the compaction turn selected",
  async () => {
    const threadId = "thr_turn_options_compact";
    await harness.startThread(threadId, { options: MINI });

    expect((await turnStart(1, threadId, "first", MINI)).error).toBeUndefined();
    const seen = await harness.waitForTurnBoundary(threadId, 0);

    const compaction = await harness.request(2, "turn/start", {
      threadId,
      providerThreadId: providerThreadIdFor(threadId),
      clientRequestId: "creq_abcdefghij",
      input: [
        {
          type: "text",
          text: "/compact",
          mentions: [
            {
              start: 0,
              end: 8,
              resource: {
                kind: "command",
                trigger: "/",
                name: "compact",
                source: "command",
                origin: "builtin",
                label: "compact",
                argumentHint: null,
              },
            },
          ],
        },
      ],
      options: FULL_MODEL,
    });
    expect(compaction.result).toMatchObject({ threadId });

    await harness.waitForDelta(
      threadId,
      (delta) => delta.kind === "contextWindow" && delta.size === 200_000,
      seen,
    );
    expect(sessionReplacements(threadId)).toHaveLength(1);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "fails a turn whose model cannot be resolved and keeps the live session",
  async () => {
    const threadId = "thr_turn_options_bad_model";
    await harness.startThread(threadId, { options: MINI });

    expect((await turnStart(1, threadId, "first", MINI)).error).toBeUndefined();
    const seen = await harness.waitForTurnBoundary(threadId, 0);

    expect(
      (
        await turnStart(2, threadId, "second", {
          ...MINI,
          model: "no-such-model",
        })
      ).error,
    ).toMatchObject({
      code: -32000,
      message: 'Failed to resolve Pi model "no-such-model"',
    });
    expect(sessionReplacements(threadId)).toEqual([]);

    expect((await turnStart(3, threadId, "third", MINI)).error).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);
    expect(contextWindowSizes(threadId).at(-1)).toBe(32_000);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "keeps serving the thread when the replacement child never starts",
  async () => {
    const threadId = "thr_turn_options_dead_replacement";
    await harness.startThread(threadId, { options: MINI });

    expect((await turnStart(1, threadId, "first", MINI)).error).toBeUndefined();
    const seen = await harness.waitForTurnBoundary(threadId, 0);

    vi.stubEnv("FAKE_PI_EXIT_BEFORE_FIRST_RESPONSE", "1");
    const failed = await turnStart(2, threadId, "second", FULL_MODEL);
    vi.stubEnv("FAKE_PI_EXIT_BEFORE_FIRST_RESPONSE", undefined);

    expect(failed.error).toMatchObject({ code: -32000 });
    expect(sessionReplacements(threadId)).toEqual([]);

    const recovered = await turnStart(3, threadId, "third", MINI);
    expect(recovered.error).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);
    expect(contextWindowSizes(threadId).at(-1)).toBe(32_000);
    expect(sessionReplacements(threadId)).toEqual([]);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "steers the running turn without rebuilding on its options",
  async () => {
    const threadId = "thr_turn_options_steer";
    const extension = join(harness.workspaceDir, "steer-extension.mjs");
    writeFileSync(extension, "export default () => {};\n");
    const initial = {
      ...MINI,
      envVars: { BB_PI_ADDITIONAL_EXTENSIONS: JSON.stringify([extension]) },
    };
    await harness.startThread(threadId, { options: initial });

    expect(
      (await turnStart(1, threadId, "/hold", initial)).error,
    ).toBeUndefined();
    await harness.waitForDelta(threadId, (delta) => delta.kind === "turn.open");

    const steer = await harness.request(2, "turn/steer", {
      threadId,
      providerThreadId: providerThreadIdFor(threadId),
      clientRequestId: "creq_abcdefghik",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "steered", mentions: [] }],
      options: FULL_MODEL,
    });
    expect(steer.result).toMatchObject({ threadId });
    expect(sessionReplacements(threadId)).toEqual([]);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it.each(["[]", "empty", "omitted"])(
  "reconciles optional extension updates and removal through %s without changing identity",
  async (removal) => {
    const children: ChildProcess[] = [];
    const onSpawn = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "process" in message &&
        message.process instanceof ChildProcess
      ) {
        children.push(message.process);
      }
    };
    const childChannel = channel("child_process");
    childChannel.subscribe(onSpawn);
    const first = join(
      realpathSync(harness.workspaceDir),
      "first extension.mjs",
    );
    const second = join(realpathSync(harness.workspaceDir), "second.mjs");
    writeFileSync(first, "export default () => {};\n");
    writeFileSync(second, "export default () => {};\n");
    const options = (path: string) => ({
      ...MINI,
      envVars: { BB_PI_ADDITIONAL_EXTENSIONS: JSON.stringify([path]) },
    });
    const extensions = (args: string[]) =>
      args.flatMap((arg, index) =>
        arg === "--extension" ? [args[index + 1]] : [],
      );
    try {
      vi.stubEnv("BB_PI_ADDITIONAL_EXTENSIONS", JSON.stringify([first]));
      const threadId = "thr_turn_extensions";
      await harness.startThread(threadId, { options: options(first) });
      const identity = providerThreadIdFor(threadId);
      const sessionFile = join(harness.sessionDir, `${identity}.jsonl`);
      const checkpoint = readFileSync(sessionFile, "utf8");
      expect(
        (await turnStart(1, threadId, "first", options(first))).error,
      ).toBeUndefined();
      let seen = await harness.waitForTurnBoundary(threadId, 0);
      expect(sessionReplacements(threadId)).toHaveLength(0);
      expect(
        (await turnStart(2, threadId, "second", options(second))).error,
      ).toBeUndefined();
      seen = await harness.waitForTurnBoundary(threadId, seen);
      const removalEnv: Record<string, string> =
        removal === "empty" ? {} : { BB_PI_ADDITIONAL_EXTENSIONS: "[]" };
      const removed =
        removal === "omitted" ? MINI : { ...MINI, envVars: removalEnv };
      expect(
        (await turnStart(3, threadId, "removed", removed)).error,
      ).toBeUndefined();
      seen = await harness.waitForTurnBoundary(threadId, seen);
      expect(
        (await turnStart(4, threadId, "still removed", removed)).error,
      ).toBeUndefined();
      await harness.waitForTurnBoundary(threadId, seen);
      const launches = children
        .filter((child) => child.spawnargs.includes(fakePiPath))
        .map((child) => child.spawnargs);
      const sessions = launches.filter((args) => args.includes("--session"));
      expect(sessions).toHaveLength(3);
      const builtin = extensions(sessions[0]!)[0];
      expect(builtin).toMatch(/bb-pi-extension\.mjs$/);
      expect(sessions.map(extensions)).toEqual([
        [builtin, first],
        [builtin, second],
        [builtin],
      ]);
      expect(
        launches
          .filter((args) => args.includes("--no-session"))
          .every((args) => extensions(args).length === 1),
      ).toBe(true);
      expect(providerThreadIdFor(threadId)).toBe(identity);
      expect(readFileSync(sessionFile, "utf8")).toBe(checkpoint);
      expect(sessionReplacements(threadId)).toHaveLength(2);
      expect(
        sessionReplacements(threadId).every((value) => !value.contextLost),
      ).toBe(true);
      if (removal === "[]") {
        const utilitiesBefore = children.filter(
          (child) =>
            child.spawnargs.includes(fakePiPath) &&
            child.spawnargs.includes("--no-session"),
        ).length;
        const fork = await harness.request(900, "thread/fork", {
          threadId: "thr_extensions_fork",
          cwd: harness.workspaceDir,
          sourceProviderThreadId: identity,
          options: options(first),
          instructionMode: "append",
        });
        expect(fork.error).toBeUndefined();
        const utilities = children.filter(
          (child) =>
            child.spawnargs.includes(fakePiPath) &&
            child.spawnargs.includes("--no-session"),
        );
        expect(utilities.length).toBeGreaterThan(utilitiesBefore);
        expect(
          utilities.every((child) => extensions(child.spawnargs).length === 1),
        ).toBe(true);
      }
    } finally {
      childChannel.unsubscribe(onSpawn);
      vi.unstubAllEnvs();
    }
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it.each(["not JSON", "{}", '["relative.mjs", "/missing/extension.mjs"]'])(
  "starts once and serves a turn when optional entries are invalid: %s",
  async (value) => {
    const start = vi.spyOn(PiRpcSession.prototype, "start");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const options = {
        ...MINI,
        envVars: { BB_PI_ADDITIONAL_EXTENSIONS: value },
      };
      const threadId = "thr_optional_invalid";
      expect(
        (await harness.startThread(threadId, { options })).error,
      ).toBeUndefined();
      expect(
        (await turnStart(1, threadId, "hello", options)).error,
      ).toBeUndefined();
      await harness.waitForTurnBoundary(threadId, 0);
      expect(start).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("BB_PI_ADDITIONAL_EXTENSIONS"),
      );
      expect(sessionReplacements(threadId)).toHaveLength(0);
    } finally {
      start.mockRestore();
      stderr.mockRestore();
    }
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);
