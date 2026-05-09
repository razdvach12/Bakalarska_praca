export type RunControlState =
  | "running"
  | "stop_requested"
  | "paused"
  | "finish_requested"
  | "terminate_requested"
  | "finished";

export type RunControl = {
  runId: string;
  state: RunControlState;
  reason?: string;
  requestedAt?: number;
  finishedAt?: number;
};

const controls = new Map<string, RunControl>();

// TOTO VYTVORI KONTROLNY OBJEKT PRE BEH
export function createRunControl(runId: string) {
  const existing = controls.get(runId);
  if (existing) return existing;

  const control: RunControl = {
    runId,
    state: "running",
  };

  controls.set(runId, control);
  return control;
}

export function getRunControl(runId: string) {
  return controls.get(runId) ?? null;
}

function setRequestedState(
  runId: string,
  nextState: Extract<RunControlState, "stop_requested" | "finish_requested" | "terminate_requested">,
  reason: string
) {
  const control = controls.get(runId);
  if (!control) return null;

  if (control.state === "finished") return control;

  control.state = nextState;
  control.reason = reason;
  control.requestedAt = Date.now();
  return control;
}

export function requestStop(runId: string, reason = "paused_by_user") {
  return setRequestedState(runId, "stop_requested", reason);
}

export function markRunPaused(runId: string, reason = "paused_by_user") {
  const control = controls.get(runId);
  if (!control) return null;

  if (control.state === "finished") return control;

  control.state = "paused";
  control.reason = reason;
  control.requestedAt = Date.now();
  return control;
}

export function resumeRun(runId: string, reason = "resumed_by_user") {
  const control = controls.get(runId);
  if (!control) return null;

  if (control.state === "finished") return control;

  control.state = "running";
  control.reason = reason;
  control.requestedAt = Date.now();
  return control;
}

export function requestFinish(runId: string, reason = "finished_by_user") {
  return setRequestedState(runId, "finish_requested", reason);
}

export function requestTerminate(runId: string, reason = "terminated_by_user") {
  return setRequestedState(runId, "terminate_requested", reason);
}

export function markRunFinished(runId: string) {
  const control = controls.get(runId);
  if (!control) return;

  control.state = "finished";
  control.finishedAt = Date.now();
}

export class RunControlInterrupt extends Error {
  kind: "stop" | "finish" | "terminate";
  success: boolean;

  constructor(kind: "stop" | "finish" | "terminate", reason: string, success: boolean) {
    super(reason);
    this.name = "RunControlInterrupt";
    this.kind = kind;
    this.success = success;
  }
}

// TOTO HODI VYNIMKU AK BOL BEH PRERUSENY POUZIVATELOM
export function throwIfRunInterrupted(runId: string) {
  const control = controls.get(runId);
  if (!control) return;

  if (control.state === "finish_requested") {
    throw new RunControlInterrupt("finish", control.reason ?? "finished_by_user", true);
  }

  if (control.state === "terminate_requested") {
    throw new RunControlInterrupt("terminate", control.reason ?? "terminated_by_user", false);
  }
}
