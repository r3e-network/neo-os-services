import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { trackedBuildOutputViolations } from "./lib/tracked-build-outputs.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoIndex = process.argv.indexOf("--repo");
const root = repoIndex >= 0 ? path.resolve(process.argv[repoIndex + 1] ?? "") : scriptRoot;

function runGit(args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

try {
  const trackedPaths = runGit(["ls-files", "-z"]).split("\0").filter(Boolean);
  const violations = trackedBuildOutputViolations(trackedPaths);
  if (violations.length > 0) {
    console.error(`tracked build output paths are not allowed (${violations.length}):\n${violations.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`tracked build output boundary holds: ${trackedPaths.length} tracked paths checked`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
