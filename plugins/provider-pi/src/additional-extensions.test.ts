import {
  chmodSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveAdditionalExtensionPaths } from "./additional-extensions.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-extra-extensions-")));
  file = join(dir, "with spaces.mjs");
  writeFileSync(file, "export default () => {};");
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

it("normalizes missing and empty snapshots", () => {
  expect(resolveAdditionalExtensionPaths(undefined)).toEqual([]);
  expect(resolveAdditionalExtensionPaths("[]")).toEqual([]);
  expect(process.stderr.write).not.toHaveBeenCalled();
});

it("keeps readable files with spaces and deduplicates canonical paths", () => {
  const alias = join(dir, "alias.mjs");
  symlinkSync(file, alias);
  expect(
    resolveAdditionalExtensionPaths(JSON.stringify([file, alias, file])),
  ).toEqual([file]);
});

it.each([
  "{",
  "{}",
  '"path"',
  "null",
  JSON.stringify(Array(33).fill("/missing")),
  " ".repeat(65_537),
])("omits invalid or excessive lists: %.40s", (value) => {
  expect(resolveAdditionalExtensionPaths(value)).toEqual([]);
  expect(process.stderr.write).toHaveBeenCalledWith(
    expect.stringContaining("BB_PI_ADDITIONAL_EXTENSIONS"),
  );
});

it("omits bad entries while preserving valid entries", () => {
  expect(
    resolveAdditionalExtensionPaths(
      JSON.stringify([
        null,
        3,
        "relative.mjs",
        "/missing/extension.mjs",
        dir,
        "/" + "x".repeat(4096),
        "/bad\0path",
        file,
      ]),
    ),
  ).toEqual([file]);
  expect(process.stderr.write).toHaveBeenCalled();
});

it.skipIf(process.getuid?.() === 0)("omits unreadable files", () => {
  chmodSync(file, 0);
  expect(resolveAdditionalExtensionPaths(JSON.stringify([file]))).toEqual([]);
  expect(process.stderr.write).toHaveBeenCalled();
});

it("accepts the count limit", () => {
  expect(
    resolveAdditionalExtensionPaths(JSON.stringify(Array(32).fill(file))),
  ).toEqual([file]);
});
