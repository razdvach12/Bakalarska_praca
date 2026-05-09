export type GoalSubtask = {
  id: string;
  title: string;
  doneWhen: string;
  dependsOn: string[];
};

export type GoalSpec = {
  goal: string;
  successCriteria: string[];
  stopCondition: string;
  assumptions: string[];
  constraints: string[];
  subtasks: GoalSubtask[];
};

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

export type RunControlState =
  | "running"
  | "stop_requested"
  | "paused"
  | "finish_requested"
  | "terminate_requested"
  | "finished";

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
      type: "subtask_done";
      runId: string;
      ts: number;
      subtaskId: string;
      source: string;
      completedSubtasks: string[];
    }
  | {
      type: "run_finished";
      runId: string;
      ts: number;
      success: boolean;
      reason?: string;
      verdict?: string;
      error?: string;
    };

export type RunSummaryMetrics = {
  humanHelpRequests: number;
  humanHelpResponses: number;
  selfHealAttempts: number;
  replanCount: number;
  replanReasons: Record<string, number>;
  stepsExecuted: number;
};

export type RunSummary = {
  runId: string;
  url: string;
  task: string;
  goalSpec: GoalSpec | null;
  success: boolean;
  stopReason?: string;
  finalVerdict?: string;
  error?: string;
  allowHumanHelp: boolean;
  metrics: RunSummaryMetrics;
  helpRound: number;
  completedSubtasks: string[];
  stepsExecuted: number;
  finalUrl: string | null;
};

export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

// TOTO VYTVORI NOVY BEH NA SERVERI
export async function createRun(args: { url: string; task: string; maxSteps: number }) {
  const res = await fetch(`${API_BASE}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });

  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as { runId: string };
}

// TOTO PRIPOJI KLIENTA NA SSE STREAM SO SERVERA
export function connectEvents(runId: string, onEvent: (ev: RunEvent) => void) {
  const es = new EventSource(`${API_BASE}/api/runs/${runId}/events`);

  es.onmessage = (m) => {
    try {
      const ev = JSON.parse(m.data) as RunEvent;
      onEvent(ev);
    } catch {}
  };

  es.onerror = () => {};

  return () => es.close();
}

// TOTO POSLE ODPOVED OD POUZIVATELA NA OTAZKU AGENTA
export async function sendHelp(runId: string, helpId: string, text: string) {
  const res = await fetch(`${API_BASE}/api/runs/${runId}/help`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ helpId, text }),
  });

  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as { ok: true };
}

// TOTO STIAHNE SUMMARY DOKONCENEHO BEHU
export async function fetchRunSummary(runId: string) {
  const res = await fetch(`/runs/${runId}/summary.json`, {
    cache: "no-store",
  });

  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as RunSummary;
}

async function sendRunCommand(runId: string, action: "stop" | "finish" | "terminate") {
  const res = await fetch(`${API_BASE}/api/runs/${runId}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as { ok: true; state: string };
}

export function stopRun(runId: string) {
  return sendRunCommand(runId, "stop");
}

export function finishRun(runId: string) {
  return sendRunCommand(runId, "finish");
}

export function terminateRun(runId: string) {
  return sendRunCommand(runId, "terminate");
}