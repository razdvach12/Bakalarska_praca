import { useEffect, useMemo, useRef, useState } from "react";
import type { DecisionSource, GoalSpec, JourneyStage, RunControlState, RunEvent, RunPageKind, RunSummary } from "./api";
import {
  API_BASE,
  connectEvents,
  createRun,
  fetchRunSummary,
  finishRun,
  sendHelp,
  stopRun,
  terminateRun,
} from "./api";
import "./App.css";

type LogLine = { ts: number; text: string };

type ChatRole = "agent" | "user" | "system";
type ChatMessage = {
  id: string;
  role: ChatRole;
  ts: number;
  text: string;
  pending?: boolean;
  helpId?: string;
  step?: number;
  quickReplies?: string[];
  kind?: string;
};

type ProgressEvent = Extract<RunEvent, { type: "progress" }>;
type PhaseEvent = Extract<RunEvent, { type: "phase" }>;
type JourneyItemState = "done" | "active" | "pending" | "skipped";

// TOTO VYKRESLI FAREBNY STATUS CHIP
function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "idle"
      ? "muted"
      : ["running", "starting...", "stopping...", "paused", "finishing...", "terminating..."].includes(status)
        ? "info"
        : status === "success"
          ? "success"
          : status.startsWith("failed") || status.startsWith("error")
            ? "danger"
            : "muted";

  return (
    <span className={`badge badge--${tone}`} title={status}>
      {status}
    </span>
  );
}

function formatTime(ts: number) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return String(ts);
  }
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// TOTO PREVEDIE RUN CONTROL STATE NA UI STATUS TEXT
function statusFromControlState(state: RunControlState) {
  switch (state) {
    case "running":
      return "running";
    case "stop_requested":
      return "stopping...";
    case "paused":
      return "paused";
    case "finish_requested":
      return "finishing...";
    case "terminate_requested":
      return "terminating...";
    case "finished":
      return "success";
    default:
      return "idle";
  }
}

function StageChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "active" | "success";
}) {
  return (
    <div className={`stage-chip ${tone ? `stage-chip--${tone}` : ""}`}>
      <span className="stage-chip__label">{label}</span>
      <span className="stage-chip__value">{value}</span>
    </div>
  );
}

function getPageKindLabel(pageKind?: RunPageKind | null) {
  switch (pageKind) {
    case "login":
      return "Login";
    case "inventory":
      return "Produkty";
    case "product_detail":
      return "Detail produktu";
    case "cart":
      return "Kosik";
    case "checkout_info":
      return "Checkout info";
    case "checkout_overview":
      return "Checkout overview";
    case "checkout_complete":
      return "Potvrdenie";
    case "form":
      return "Formular";
    default:
      return "Neznamy stav";
  }
}

function getSourceLabel(source?: DecisionSource, stage?: JourneyStage) {
  if (stage === "waiting_for_human") {
    return "Human";
  }

  switch (source) {
    case "agent":
      return "LLM";
    case "human_guided":
      return "Human input";
    case "self_heal":
      return "Self-heal";
    case "completion_check":
      return "Completion check";
    default:
      return "System";
  }
}

function getStageTone(stage?: JourneyStage, status?: string): "neutral" | "active" | "success" {
  if (stage === "finished" && status === "success") {
    return "success";
  }

  if (stage) {
    return "active";
  }

  return "neutral";
}

function getVerdictTitle(status: string, hasFinalVerdict: boolean) {
  if (hasFinalVerdict && status === "success") {
    return "Uloha je splnena";
  }

  if (hasFinalVerdict && (status.startsWith("failed") || status.startsWith("error"))) {
    return "Beh neskoncil uspesne";
  }

  return "Finalna odpoved na zadanie";
}

// TOTO JE HLAVNY KOMPONENT MONITOROVACEJ APLIKACIE
export default function App() {
  const [url, setUrl] = useState("https://www.saucedemo.com/");
  const [task, setTask] = useState(
    'Prihlaste sa pomocou "standard_user" / "secret_sauce". Otvorte detail produktu "Sauce Labs Onesie", pridajte ho do kosika a otvorte kosik.'
  );
  const [maxSteps, setMaxSteps] = useState(25);

  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [controlBusy, setControlBusy] = useState<null | "stop" | "finish" | "terminate">(null);

  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runFinishedAt, setRunFinishedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number>(0);

  const [logs, setLogs] = useState<LogLine[]>([]);
  const [shots, setShots] = useState<string[]>([]);

  const [goalSpec, setGoalSpec] = useState<GoalSpec | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [phase, setPhase] = useState<PhaseEvent | null>(null);
  const [finalVerdict, setFinalVerdict] = useState<string | null>(null);
  const [runSummary, setRunSummary] = useState<RunSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [helpRequestCount, setHelpRequestCount] = useState(0);
  const [helpResponseCount, setHelpResponseCount] = useState(0);
  const [isEvidenceCollapsed, setIsEvidenceCollapsed] = useState(false);
  const [isJourneyCollapsed, setIsJourneyCollapsed] = useState(false);
  const [showVerdictModal, setShowVerdictModal] = useState(false);

  const [realtimeCompletedSubtasks, setRealtimeCompletedSubtasks] = useState<string[]>([]);

  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");

  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const disconnectRef = useRef<null | (() => void)>(null);
  const chatRef = useRef<ChatMessage[]>([]);
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    chatRef.current = chat;
  }, [chat]);

  useEffect(() => {
    runIdRef.current = runId;
  }, [runId]);

  const canStart = useMemo(() => url.trim().length > 0 && task.trim().length > 0, [url, task]);

  useEffect(() => {
    return () => {
      disconnectRef.current?.();
      disconnectRef.current = null;
    };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat.length]);

  useEffect(() => {
    if (!showVerdictModal) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowVerdictModal(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showVerdictModal]);

  useEffect(() => {
    if (!runStartedAt) {
      setElapsedMs(0);
      return;
    }

    if (runFinishedAt) {
      setElapsedMs(runFinishedAt - runStartedAt);
      return;
    }

    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - runStartedAt);
    }, 1000);

    return () => window.clearInterval(id);
  }, [runStartedAt, runFinishedAt]);

  // TOTO POSLE SPRAVU OD POUZIVATELA AGENTOVI
  async function sendUserMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;

    const currentRun = runId;
    const pending = [...chatRef.current].reverse().find((message) => message.role === "agent" && message.pending && message.helpId);
    const pendingHelpId = pending?.helpId;

    setChat((previous) => {
      const next = previous.map((message) => (message.id === pending?.id ? { ...message, pending: false } : message));
      next.push({ id: makeId(), role: "user", ts: Date.now(), text: trimmed });
      return next;
    });

    if (currentRun && pendingHelpId) {
      try {
        await sendHelp(currentRun, pendingHelpId, trimmed);
      } catch (error: any) {
        setChat((previous) => [
          ...previous,
          {
            id: makeId(),
            role: "system",
            ts: Date.now(),
            text: `Failed to send help: ${error?.message ?? String(error)}`,
          },
        ]);
      }
    }
  }

  // TOTO SPUSTI NOVY BEH AGENTA
  async function onStart() {
    setLogs([]);
    setShots([]);
    setChat([]);
    setGoalSpec(null);
    setProgress(null);
    setPhase(null);
    setFinalVerdict(null);
    setRunSummary(null);
    setSummaryLoading(false);
    setHelpRequestCount(0);
    setHelpResponseCount(0);
    setShowVerdictModal(false);
    setRealtimeCompletedSubtasks([]);
    setStatus("starting...");
    setRunId(null);
    setControlBusy(null);
    runIdRef.current = null;

    setRunStartedAt(null);
    setRunFinishedAt(null);
    setElapsedMs(0);

    disconnectRef.current?.();
    disconnectRef.current = null;

    try {
      const createdRun = await createRun({ url: url.trim(), task: task.trim(), maxSteps });
      const startedNow = Date.now();

      setRunId(createdRun.runId);
      runIdRef.current = createdRun.runId;
      setStatus("running");
      setRunStartedAt(startedNow);
      setRunFinishedAt(null);
      setElapsedMs(0);
      setPhase({
        type: "phase",
        runId: createdRun.runId,
        ts: startedNow,
        stage: "starting",
        label: "Spustam agenta",
        detail: "Cakam na prve eventy zo servera.",
      });

      disconnectRef.current = connectEvents(createdRun.runId, (event: RunEvent) => {
        if (event.type === "log") {
          setLogs((previous) => [...previous, { ts: event.ts, text: event.message }]);
          return;
        }

        if (event.type === "run_started") {
          setRunStartedAt(event.ts);
          setRunFinishedAt(null);
          setElapsedMs(0);
          setLogs((previous) => [...previous, { ts: event.ts, text: `Run started: ${event.url}` }]);
          return;
        }

        if (event.type === "run_control") {
          setStatus(statusFromControlState(event.state));
          if (event.state === "paused" || event.state === "running") {
            setControlBusy(null);
          }
          return;
        }

        if (event.type === "plan_ready") {
          setGoalSpec(event.goalSpec);
          return;
        }

        if (event.type === "progress") {
          setProgress(event);
          return;
        }

        if (event.type === "phase") {
          setPhase(event);
          return;
        }

        if (event.type === "step") {
          setLogs((previous) => [...previous, { ts: event.ts, text: `Step ${event.step}: ${JSON.stringify(event.decision)}` }]);
          return;
        }

        if (event.type === "screenshot") {
          setShots((previous) => [...previous, event.path]);
          return;
        }

        if (event.type === "need_help") {
          const kind = String(event.context?.kind ?? "");
          const quickReplies = Array.isArray(event.context?.quickReplies)
            ? event.context.quickReplies
            : ["Je to v menu", "Scrollni nizsie", "Skus pravu hornu cast"];

          if (kind === "resume_after_stop") {
            setStatus("paused");
            setControlBusy(null);
          }

          setHelpRequestCount((previous) => previous + 1);
          setChat((previous) => [
            ...previous,
            {
              id: makeId(),
              role: "agent",
              ts: event.ts,
              text: event.question,
              pending: true,
              helpId: event.helpId,
              step: event.step,
              quickReplies,
              kind,
            },
          ]);
          return;
        }

        if (event.type === "help_received") {
          setHelpResponseCount((previous) => previous + 1);
          setLogs((previous) => [...previous, { ts: event.ts, text: `Help received: ${event.text}` }]);
          return;
        }

        if ((event as any).type === "subtask_done") {
          const subtaskEvent = event as any;
          setRealtimeCompletedSubtasks(subtaskEvent.completedSubtasks ?? []);
          setLogs((previous) => [
            ...previous,
            { ts: subtaskEvent.ts, text: `Subtask done [${subtaskEvent.source}]: ${subtaskEvent.subtaskId}` },
          ]);
          return;
        }

        if (event.type === "run_finished") {
          const finishedRunId = event.runId;
          setRunFinishedAt(event.ts);
          setStatus(event.success ? "success" : `failed: ${event.reason ?? event.error ?? ""}`);
          setControlBusy(null);
          setFinalVerdict((previous) => event.verdict?.trim() ?? event.reason ?? previous ?? event.error ?? null);
          setLogs((previous) => [
            ...previous,
            {
              ts: event.ts,
              text: event.success ? `Run finished: ${event.reason ?? "success"}` : `Run failed: ${event.reason ?? event.error ?? "unknown error"}`,
            },
          ]);
          disconnectRef.current?.();
          disconnectRef.current = null;
          setShowVerdictModal(true);
          setSummaryLoading(true);
          void fetchRunSummary(finishedRunId)
            .then((summary) => {
              if (runIdRef.current === finishedRunId) {
                setRunSummary(summary);
              }
            })
            .catch(() => {
              if (runIdRef.current === finishedRunId) {
                setRunSummary(null);
              }
            })
            .finally(() => {
              if (runIdRef.current === finishedRunId) {
                setSummaryLoading(false);
              }
            });
        }
      });
    } catch (error: any) {
      setStatus(`error: ${error?.message ?? String(error)}`);
      setControlBusy(null);
    }
  }

  // TOTO RIESI TLACIDLA STOP/FINISH/TERMINATE
  async function handleRunControl(action: "stop" | "finish" | "terminate") {
    if (!runId || controlBusy) return;

    try {
      setControlBusy(action);
      setStatus(
        action === "stop"
          ? "stopping..."
          : action === "finish"
            ? "finishing..."
            : "terminating..."
      );

      if (action === "stop") {
        await stopRun(runId);
      } else if (action === "finish") {
        await finishRun(runId);
      } else {
        await terminateRun(runId);
      }

      setLogs((previous) => [
        ...previous,
        {
          ts: Date.now(),
          text:
            action === "stop"
              ? "User requested pause."
              : action === "finish"
                ? "User requested manual finish."
                : "User requested terminate.",
        },
      ]);
    } catch (error: any) {
      setStatus(`error: ${error?.message ?? String(error)}`);
      setControlBusy(null);
    }
  }

  const isActiveRun = ["running", "starting...", "stopping...", "paused", "finishing...", "terminating..."].includes(status);
  const pendingCount = useMemo(() => chat.filter((message) => message.role === "agent" && message.pending).length, [chat]);

  const activeSubtaskId = phase?.activeSubtaskId ?? progress?.activeSubtaskId ?? null;
  const activeSubtaskTitle = phase?.activeSubtaskTitle ?? progress?.activeSubtaskTitle ?? null;
  const currentStep = phase?.step ?? progress?.step ?? null;
  const currentStageLabel = phase?.label ?? (isActiveRun ? "Agent pracuje" : "Pripraveny");
  const currentStageDetail =
    phase?.detail ??
    progress?.progressNote ??
    progress?.reason ??
    (status === "idle"
      ? "Po spusteni sa tu zobrazi stadium, aktivny subtask a priebezny komentar agenta."
      : "Agent este neposlal detailnejsi update.");
  const currentPageLabel = getPageKindLabel(phase?.pageKind ?? progress?.pageKind ?? null);
  const currentSourceLabel = getSourceLabel(phase?.decisionSource ?? progress?.decisionSource, phase?.stage);
  const currentStageTone = getStageTone(phase?.stage, status);
  const currentCompletedSubtasks = useMemo(() => {
    const fromProgress = progress?.completedSubtasks ?? [];
    const fromRealtime = realtimeCompletedSubtasks;
    const merged = new Set([...fromProgress, ...fromRealtime]);
    return [...merged];
  }, [progress?.completedSubtasks, realtimeCompletedSubtasks]);

  const journeyItems = useMemo(() => {
    if (!goalSpec) {
      return [] as Array<{ id: string; title: string; hint: string; state: JourneyItemState }>;
    }

    const completed = new Set(currentCompletedSubtasks);
    const isFinished = status === "success" || status.startsWith("failed") || status.startsWith("error");

    return goalSpec.subtasks.map((item) => {
      const done = completed.has(item.id);
      const active = !done && activeSubtaskId === item.id;
      const skipped = isFinished && !done;

      return {
        id: item.id,
        title: item.title,
        hint: active ? currentStageDetail : done ? item.doneWhen : skipped ? "Preskočené / nedokončené" : item.doneWhen,
        state: (done ? "done" : active ? "active" : skipped ? "skipped" : "pending") as JourneyItemState,
      };
    });
  }, [activeSubtaskId, currentCompletedSubtasks, currentStageDetail, goalSpec, status]);

  const hasFinalVerdict = Boolean(finalVerdict?.trim());
  const verdictTitle = getVerdictTitle(status, hasFinalVerdict);
  const verdictText = hasFinalVerdict
    ? finalVerdict
    : isActiveRun
      ? "Po dokonceni sa tu objavi finalna odpoved na zadanie."
      : status === "idle"
        ? "Spustite run a po dokonceni sa tu vypise vysledok celej ulohy."
        : "Finalna odpoved nebola k dispozicii.";
  const backendLabel = useMemo(() => {
    try {
      return new URL(API_BASE).host;
    } catch {
      return API_BASE;
    }
  }, []);
  const isFinished = status === "success" || status.startsWith("failed") || status.startsWith("error");
  const isSuccessfulRun = runSummary?.success ?? (status === "success");
  const summaryRunId = runSummary?.runId ?? runId;
  const helpRequestsTotal = runSummary?.metrics.humanHelpRequests ?? progress?.helpRound ?? helpRequestCount;
  const helpResponsesTotal = runSummary?.metrics.humanHelpResponses ?? helpResponseCount;
  const stepsExecutedTotal = runSummary?.metrics.stepsExecuted ?? (currentStep != null ? currentStep + 1 : 0);
  const totalSubtasks = runSummary?.goalSpec?.subtasks.length ?? goalSpec?.subtasks.length ?? 0;
  const completedSubtasksTotal = runSummary?.completedSubtasks.length ?? currentCompletedSubtasks.length;
  const selfHealAttempts = runSummary?.metrics.selfHealAttempts ?? 0;
  const replanCount = runSummary?.metrics.replanCount ?? 0;
  const modalVerdictText = runSummary?.finalVerdict?.trim() || verdictText;
  const lastShot = shots.length > 0 ? shots[shots.length - 1] : null;
  const summaryStats = [
    { label: "Status", value: isSuccessfulRun ? "Uspesne" : isFinished ? "Nedokoncene" : "Priebezne" },
    { label: "Pomoc", value: String(helpRequestsTotal) },
    { label: "Odpovede", value: String(helpResponsesTotal) },
    { label: "Kroky", value: String(stepsExecutedTotal) },
    { label: "Subtasks", value: totalSubtasks > 0 ? `${completedSubtasksTotal}/${totalSubtasks}` : String(completedSubtasksTotal) },
    { label: "Screenshoty", value: String(shots.length) },
    { label: "Self-heal", value: String(selfHealAttempts) },
    { label: "Replany", value: String(replanCount) },
  ];

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="brand__mark" aria-hidden="true">
            UI
          </div>
          <div className="brand__text">
            <h1 className="brand__title">UI Agent</h1>
            <div className="brand__subtitle">Live agent monitor</div>
          </div>
        </div>

        <div className="meta">
          <div className="meta__row">
            <span className="meta__label">Backend</span>
            <code className="meta__code">{backendLabel}</code>
          </div>
          <div className="meta__row">
            <span className="meta__label">UI</span>
            <code className="meta__code">localhost:5173</code>
          </div>
        </div>
      </header>

      <main className="grid">
        <section className="card card--control">
          <div className="card__head">
            <div>
              <div className="card__title">New run</div>
              <div className="card__desc">Start an agent run and watch journey, logs and screenshots in real time.</div>
            </div>

            <div className="status">
              <StatusBadge status={status} />
              {runId ? <span className="status__id">runId: {runId}</span> : <span className="status__id muted">-</span>}
            </div>
          </div>

          <div className="form">
            <label className="field">
              <span className="field__label">URL</span>
              <input className="input" value={url} onChange={(event) => setUrl(event.target.value)} inputMode="url" />
            </label>

            <label className="field">
              <span className="field__label">Task</span>
              <textarea className="textarea" value={task} onChange={(event) => setTask(event.target.value)} rows={4} />
            </label>

            <div className="row">
              <label className="field field--compact">
                <span className="field__label">Max steps</span>
                <input
                  className="input"
                  type="number"
                  value={maxSteps}
                  onChange={(event) => setMaxSteps(Number(event.target.value))}
                  min={1}
                  max={50}
                />
              </label>

              <label className="field field--compact">
                <span className="field__label">Run time</span>
                <input className="input" type="text" value={formatDuration(elapsedMs)} readOnly />
              </label>

              <div className="run-actions">
                <button className="button" disabled={!canStart || isActiveRun} onClick={onStart}>
                  {isActiveRun ? (
                    <>
                      {status !== "paused" ? <span className="spinner" aria-hidden="true" /> : null}
                      {status === "paused" ? "Run paused" : "Running..."}
                    </>
                  ) : (
                    <>Start run</>
                  )}
                </button>

                {runId && isActiveRun ? (
                  <>
                    <button
                      className="button button--ghost"
                      type="button"
                      disabled={Boolean(controlBusy) || status === "paused"}
                      onClick={() => handleRunControl("stop")}
                    >
                      Stop
                    </button>

                    <button
                      className="button button--ghost"
                      type="button"
                      disabled={Boolean(controlBusy)}
                      onClick={() => handleRunControl("finish")}
                    >
                      Finish
                    </button>

                    <button
                      className="button button--danger"
                      type="button"
                      disabled={Boolean(controlBusy)}
                      onClick={() => handleRunControl("terminate")}
                    >
                      Terminate
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </section>

        <section className={`card card--journey card--collapsible ${isJourneyCollapsed ? "card--collapsed" : ""}`}>
          <button
            className="card__head card__head--toggle"
            type="button"
            onClick={() => setIsJourneyCollapsed((previous) => !previous)}
            aria-expanded={!isJourneyCollapsed}
          >
            <div>
              <div className="card__title">Agent journey</div>
              <div className="card__desc">Live decision flow, current focus a priebezny final verdict v jednom okne.</div>
            </div>

            <div className="card-toggle-meta">
              <div className="journey-head">
                {currentStep != null ? <div className="pill">step {currentStep + 1}</div> : null}
                {goalSpec ? <div className="pill">{goalSpec.subtasks.length} subtasks</div> : <div className="pill">waiting for plan</div>}
                <div className="pill">{helpRequestsTotal} human helps</div>
              </div>
              <span className="card__toggle">{isJourneyCollapsed ? "Show" : "Hide"}</span>
            </div>
          </button>

          {isJourneyCollapsed ? (
            <div className="card__collapsed-note">Agent journey je schovany. Kliknite na hlavicku pre zobrazenie.</div>
          ) : (
            <div className="journey">
              <div className="journey__summary">
                <div className="journey-panel">
                  <div className="journey-panel__label">Current focus</div>
                  <div className="journey-panel__title">{activeSubtaskTitle ?? currentStageLabel}</div>
                  <div className="journey-panel__text">{currentStageDetail}</div>

                  <div className="journey-stages">
                    <StageChip label="Stadium" value={currentStageLabel} tone={currentStageTone} />
                    <StageChip label="Page" value={currentPageLabel} tone="neutral" />
                    <StageChip label="Source" value={currentSourceLabel} tone="neutral" />
                  </div>

                  <div className="journey-meta">
                    {currentStep != null ? <div className="journey-meta__item">Current step: {currentStep + 1}</div> : null}
                    {progress ? <div className="journey-meta__item">Completed subtasks: {progress.completedSubtasks.length}</div> : null}
                    {progress ? <div className="journey-meta__item">Stale page count: {progress.stalePageCount}</div> : null}
                  </div>
                </div>

                <div className="journey-panel journey-panel--verdict">
                  <div className="journey-panel__label">Final verdict</div>
                  <div className="journey-panel__title">{verdictTitle}</div>
                  <div className="journey-panel__text">{verdictText}</div>

                  {hasFinalVerdict ? (
                    <div className="verdict-tags">
                      <span className={`verdict-tag ${status === "success" ? "verdict-tag--success" : ""}`}>{status}</span>
                      {phase?.stage ? <span className="verdict-tag">{phase.stage}</span> : null}
                      {phase?.decisionSource ? <span className="verdict-tag">{getSourceLabel(phase.decisionSource)}</span> : null}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="journey__timeline">
                {journeyItems.length === 0 ? (
                  <div className="empty">
                    <div className="empty__title">Plan este nie je pripraveny</div>
                    <div className="empty__text">Po spusteni si agent najprv vygeneruje goal spec a subtasks, potom sa timeline naplni.</div>
                  </div>
                ) : (
                  <div className="journey-list">
                    {journeyItems.map((item, index) => (
                      <article key={item.id} className={`journey-step journey-step--${item.state}`}>
                        <div className="journey-step__rail">
                          <div className="journey-step__index">
                            {item.state === "done" ? "✓" : item.state === "skipped" ? "✗" : index + 1}
                          </div>
                          {index < journeyItems.length - 1 ? <div className="journey-step__line" /> : null}
                        </div>

                        <div className="journey-step__content">
                          <div className="journey-step__top">
                            <div className="journey-step__title">{item.title}</div>
                            <span className={`journey-state journey-state--${item.state}`}>
                              {item.state === "done"
                                ? "hotovo"
                                : item.state === "active"
                                  ? "prebieha"
                                  : item.state === "skipped"
                                    ? "preskočené"
                                    : "čaká"}
                            </span>
                          </div>
                          <div className="journey-step__hint">{item.hint}</div>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        <section className={`card card--evidence card--collapsible ${isEvidenceCollapsed ? "card--collapsed" : ""}`}>
          <button
            className="card__head card__head--toggle"
            type="button"
            onClick={() => setIsEvidenceCollapsed((previous) => !previous)}
            aria-expanded={!isEvidenceCollapsed}
          >
            <div>
              <div className="card__title">Run evidence</div>
              <div className="card__desc">DEVMODE: Live log a screenshots</div>
            </div>

            <div className="card-toggle-meta">
              <div className="evidence-head">
                <div className="pill">{logs.length} events</div>
                <div className="pill">{shots.length} shots</div>
              </div>
              <span className="card__toggle">{isEvidenceCollapsed ? "Show" : "Hide"}</span>
            </div>
          </button>

          {isEvidenceCollapsed ? (
            <div className="card__collapsed-note">Live log a screenshots su schovane. Kliknite na hlavicku pre zobrazenie.</div>
          ) : (
            <div className="evidence">
              <section className="evidence-pane">
                <div className="evidence-pane__head">
                  <div>
                    <div className="evidence-pane__title">Live log</div>
                    <div className="evidence-pane__desc">Streaming events from SSE.</div>
                  </div>
                  <div className="pill">{logs.length} events</div>
                </div>

                <div className="log">
                  {logs.length === 0 ? (
                    <div className="empty">
                      <div className="empty__title">No events yet</div>
                      <div className="empty__text">Start a run to see step decisions, logs and finish status.</div>
                    </div>
                  ) : (
                    logs.map((line, index) => (
                      <div key={index} className="log__line">
                        <span className="log__ts">{formatTime(line.ts)}</span>
                        <span className="log__sep">-</span>
                        <span className="log__msg">{line.text}</span>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="evidence-pane">
                <div className="evidence-pane__head">
                  <div>
                    <div className="evidence-pane__title">Screenshots</div>
                    <div className="evidence-pane__desc">Captured during steps (click to open).</div>
                  </div>
                  <div className="pill">{shots.length} shots</div>
                </div>

                {shots.length === 0 ? (
                  <div className="shots-empty">
                    <div className="shots-empty__title">No screenshots</div>
                    <div className="shots-empty__text">They will appear here as soon as the agent captures them.</div>
                  </div>
                ) : (
                  <div className="shots">
                    {shots.map((path, index) => (
                      <a key={index} className="shot" href={path} target="_blank" rel="noreferrer">
                        <img className="shot__img" src={path} alt={`screenshot-${index}`} loading="lazy" />
                        <div className="shot__footer">
                          <span className="shot__label">Screenshot</span>
                          <span className="shot__path">{path}</span>
                        </div>
                      </a>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </section>

        <section className="card card--chat">
          <div className="card__head">
            <div>
              <div className="card__title">Clarification chat</div>
              <div className="card__desc">Agent tu pyta potvrdenie cookies, doplnujuce instrukcie aj dalsi krok po stlaceni Stop.</div>
            </div>

            <div className="chat-head-actions">
              <div className="pill">{pendingCount} pending</div>
            </div>
          </div>

          <div className="chat">
            <div className="chat__messages">
              {chat.length === 0 ? (
                <div className="empty">
                  <div className="empty__title">No questions yet</div>
                  <div className="empty__text">
                    During a run, the agent can post a question here and continue after you answer.
                  </div>
                </div>
              ) : (
                chat.map((message) => (
                  <div key={message.id} className={`chat-msg chat-msg--${message.role}`}>
                    <div className="chat-msg__meta">
                      <span className="chat-msg__who">
                        {message.role === "agent" ? "Agent" : message.role === "user" ? "You" : "System"}
                      </span>
                      <span className="chat-msg__dot">•</span>
                      <span className="chat-msg__time">{formatTime(message.ts)}</span>
                      {message.role === "agent" && message.pending ? <span className="chat-msg__badge">waiting</span> : null}
                      {message.role === "agent" && message.step != null ? <span className="chat-msg__badge">step {message.step + 1}</span> : null}
                    </div>

                    <div className="chat-msg__bubble">{message.text}</div>

                    {message.role === "agent" && message.pending && message.quickReplies && message.quickReplies.length > 0 ? (
                      <div className="chat-msg__quick">
                        {message.quickReplies.map((quickReply) => (
                          <button
                            key={quickReply}
                            type="button"
                            className="chip"
                            onClick={() => {
                              void sendUserMessage(quickReply);
                              setDraft("");
                            }}
                          >
                            {quickReply}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
              <div ref={chatEndRef} />
            </div>

            <div className="chat__composer">
              <textarea
                className="textarea chat__input"
                placeholder="Type your answer... (Enter to send, Shift+Enter for newline)"
                value={draft}
                rows={2}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendUserMessage(draft);
                    setDraft("");
                  }
                }}
              />

              <button
                className="button"
                type="button"
                disabled={draft.trim().length === 0}
                onClick={() => {
                  void sendUserMessage(draft);
                  setDraft("");
                }}
              >
                Send
              </button>
            </div>
          </div>
        </section>
      </main>

      {showVerdictModal ? (
        <div
          className="verdict-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="verdict-modal-title"
          onClick={() => setShowVerdictModal(false)}
        >
          <div
            className={`verdict-modal__card ${isSuccessfulRun ? "verdict-modal__card--success" : ""}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="verdict-modal__eyebrow">{isSuccessfulRun ? "Task completed" : "Run finished"}</div>
            <div id="verdict-modal-title" className="verdict-modal__title">
              {verdictTitle}
            </div>
            <div className="verdict-modal__text">{modalVerdictText}</div>

            {summaryLoading ? <div className="verdict-modal__hint">Summary sa este nacitava z posledneho runu.</div> : null}

            <div className="verdict-modal__stats">
              {summaryStats.map((item) => (
                <div key={item.label} className="verdict-stat">
                  <div className="verdict-stat__label">{item.label}</div>
                  <div className="verdict-stat__value">{item.value}</div>
                </div>
              ))}
            </div>

            {runSummary?.finalUrl ? (
              <div className="verdict-detail">
                <span className="verdict-detail__label">Finalna URL</span>
                <span className="verdict-detail__value">{runSummary.finalUrl}</span>
              </div>
            ) : null}

            {lastShot ? (
              <a className="verdict-modal__preview" href={lastShot} target="_blank" rel="noreferrer">
                <img className="verdict-modal__img" src={lastShot} alt="final-run-preview" loading="lazy" />
                <div className="verdict-modal__preview-foot">
                  <span>Posledny screenshot</span>
                  <span>{shots.length} total</span>
                </div>
              </a>
            ) : null}

            <div className="verdict-modal__actions">
              {summaryRunId ? (
                <a className="button button--ghost" href={`/runs/${summaryRunId}/summary.json`} target="_blank" rel="noreferrer">
                  Open summary
                </a>
              ) : null}
              <button className="button" type="button" onClick={() => setShowVerdictModal(false)}>
                Zavriet
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <footer className="footer">
        <span className="muted">BP • UI Agent • Live journey monitor</span>
      </footer>
    </div>
  );
}