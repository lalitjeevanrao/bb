import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { isAbsolute } from "node:path";

export const PI_ADDITIONAL_EXTENSIONS_ENV = "BB_PI_ADDITIONAL_EXTENSIONS";
const MAX_JSON_LENGTH = 65_536;
const MAX_PATHS = 32;
const MAX_PATH_LENGTH = 4_096;

function warn(reason: string): void {
  process.stderr.write(
    `pi bridge: ${PI_ADDITIONAL_EXTENSIONS_ENV}: ${reason}; optional extensions omitted\n`,
  );
}

export function resolveAdditionalExtensionPaths(
  value: string | undefined,
): string[] {
  if (value === undefined) return [];
  if (value.length > MAX_JSON_LENGTH) {
    warn("JSON exceeds 65536 characters");
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    warn("invalid JSON");
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_PATHS) {
    warn("expected an array of at most 32 paths");
    return [];
  }
  const paths = new Set<string>();
  for (const entry of parsed) {
    if (
      typeof entry !== "string" ||
      entry.length > MAX_PATH_LENGTH ||
      entry.includes("\0") ||
      !isAbsolute(entry)
    ) {
      warn("entry must be an absolute path of at most 4096 characters");
      continue;
    }
    try {
      const path = realpathSync(entry);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
      } finally {
        closeSync(fd);
      }
      paths.add(path);
    } catch {
      warn(`cannot read regular file ${JSON.stringify(entry)}`);
    }
  }
  return [...paths];
}
