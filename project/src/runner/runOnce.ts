import fs from "node:fs/promises";
import path from "node:path";

import { createRunControl } from "../server/runControl";
import type { RunOptions } from "./runOnce/shared";
import { getCurrentDateContext } from "./runOnce/shared";
import { runOnceCore } from "./runOnce/core";

const RUNS_DIR = path.resolve(process.cwd(), "runs");

async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

function resolveRunDir(runId: string) {
  return path.join(RUNS_DIR, runId);
}

// TOTO SPUSTI JEDEN BEH AGENTA
export async function runOnce(
  runId: string,
  url: string,
  task: string,
  maxSteps = 40,
  options: RunOptions = {}
) {
  const runDir = resolveRunDir(runId);
  const allowHumanHelp = options.allowHumanHelp !== false;
  const currentDate = getCurrentDateContext();

  await ensureDir(runDir);
  createRunControl(runId);

  return runOnceCore({
    runId,
    url,
    task,
    maxSteps,
    runDir,
    allowHumanHelp,
    difficulty: options.difficulty,
    runLabel: options.runLabel,
    currentDate,
  });
}
