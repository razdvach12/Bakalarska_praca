import type { Response } from "express";
import type { GoalSpec } from "../runner/types";
import type { RunControlState } from "./runControl";

export type RunPageKind =
  | "login"
  | "inventory"
  | "product_detail"
  | "cart"
  | "checkout_info"
  | "checkout_overview"
  | "checkout_complete"
  | "form"
  | "unknown";

export type DecisionSource = "agent" | "human_guided" | "self_heal" | "completion_check";

export type JourneyStage =
  | "starting"
  | "planning"
  | "analyzing"
  | "checking_completion"
  | "thinking"
  | "self_healing"
  | "applying_human_input"
  | "executing"
  | "waiting_for_human"
  | "finished";

export type RunEvent =
  | { type: "run_started"; runId: string; ts: number; url: string; task: string }
  | { type: "run_control"; runId: string; ts: number; state: RunControlState; reason?: string }
  | { type: "plan_ready"; runId: string; ts: number; goalSpec: GoalSpec }
  | {
      type: "progress";
      runId: string;
      ts: number;
      step: number;
      activeSubtaskId: string | null;
      activeSubtaskTitle: string | null;
      completedSubtasks: string[];
      stalePageCount: number;
      helpRound: number;
      pageKind: RunPageKind;
      decisionSource: DecisionSource;
      progressNote?: string;
      reason?: string;
    }
  | {
      type: "phase";
      runId: string;
      ts: number;
      stage: JourneyStage;
      label: string;
      detail: string;
      step?: number;
      pageKind?: RunPageKind;
      activeSubtaskId?: string | null;
      activeSubtaskTitle?: string | null;
      decisionSource?: DecisionSource;
      verdict?: string | null;
    }
  | { type: "step"; runId: string; ts: number; step: number; decision: any }
  | { type: "log"; runId: string; ts: number; message: string }
  | { type: "screenshot"; runId: string; ts: number; path: string }
  | {
      type: "need_help";
      runId: string;
      ts: number;
      step: number;
      helpId: string;
      reason: string;
      question: string;
      context?: any;
    }
  | { type: "help_received"; runId: string; ts: number; helpId: string; text: string }
  | {
      type: "run_finished";
      runId: string;
      ts: number;
      success: boolean;
      successMode?: "strict" | "llm_soft" | "user_forced";
      reason?: string;
      verdict?: string;
      error?: string;
    };

type Client = { res: Response };
const clients = new Map<string, Set<Client>>();
const eventSeq = new Map<string, number>();
const history = new Map<string, Array<{ id: number; event: RunEvent }>>();
const MAX_HISTORY = 300;

function nextEventId(runId: string) {
  const next = (eventSeq.get(runId) ?? 0) + 1;
  eventSeq.set(runId, next);
  return next;
}

function rememberEvent(runId: string, event: RunEvent) {
  const bucket = history.get(runId) ?? [];
  const id = nextEventId(runId);
  bucket.push({ id, event });

  if (bucket.length > MAX_HISTORY) {
    bucket.splice(0, bucket.length - MAX_HISTORY);
  }

  history.set(runId, bucket);
  return id;
}

function writeSse(res: Response, id: number, event: RunEvent) {
  res.write(`id: ${id}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// TOTO PRIDA NOVEHO SSE KLIENTA A POSLE MU HISTORIU
export function addClient(runId: string, res: Response, lastEventId?: number | null) {
  const set = clients.get(runId) ?? new Set<Client>();
  const client = { res };
  set.add(client);
  clients.set(runId, set);

  const bucket = history.get(runId) ?? [];
  const replayAfter = Number.isFinite(lastEventId) ? Number(lastEventId) : 0;

  for (const item of bucket) {
    if (item.id <= replayAfter) continue;
    writeSse(res, item.id, item.event);
  }

  res.on("close", () => {
    set.delete(client);
    if (set.size === 0) clients.delete(runId);
  });
}

// TOTO POSLE EVENT VSETKYM PRIHLASENYM KLIENTOM
export function emit(event: RunEvent) {
  const id = rememberEvent(event.runId, event);
  const set = clients.get(event.runId);
  if (!set) return;
  for (const c of set) writeSse(c.res, id, event);
}
