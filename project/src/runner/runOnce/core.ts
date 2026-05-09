import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { uiAgent } from "../../mastra/agents/ui-agent";
import { createLanguageModel, DEFAULT_OPENAI_MODEL, getModelId } from "../../shared/modelFactory";
import { AgentDecisionSchema } from "../types";
import type { AgentDecision, AgentAction, CompletionCheck, DeterministicFinalGate, GoalSpec, VisionNotes } from "../types";
import { emit } from "../../server/sse";
import { waitForHelp, cancelPendingForRun } from "../../server/help";
import {
  getRunControl,
  markRunFinished,
  markRunPaused,

  RunControlInterrupt,
  resumeRun,
  throwIfRunInterrupted,
} from "../../server/runControl";
import { getPage } from "../../../playwright/browser";
import {
  DecisionSource,
  JourneyStage,
  PageKind,
  PendingHumanDirective,
  PendingSelfHeal,
  ReplanReason,
  SelfHealSource,
  cleanJsonMaybe,
  extractModelUsage,
  includesAny,
  normalizeParsedDecisionLike,
  safeLogMessage,
  type ModelUsage,
} from "./shared";
import {
  actionSignature,
  compactSnapshotForAgent,
  compactSnapshotForPlanner,
  decisionSignature,
  detectPageKind,
  getKnownSubtaskIds,
  getSubtaskTitle,
  inferAutoCompletedSubtasks,
  isLoginLikeSubtask,
  pageSignature,
  selectorInSnapshot,
  summarizeOptions,
  textInSnapshot,
} from "./pageState";
import {
  afterActionStabilize,
  findDynamicSuggestionCandidate,
  findSnapshotItemBySelector,
  isNonNavigationalClickFallback,
  looksLikeCssSelector,
  miniStabilize,
  normalizeActionAgainstSnapshot,
  normalizeCssSelector,
  planDynamicTypeInput,
  pushRecent,
  recordAppliedHumanDirective,
  shouldClickByTextExact,
} from "./actions";
import {
  buildProgressPayload,
  isBackwardSubtask,
  looksLikeBlockedUiError,
} from "./clarification";
import { getViewportScreenshotDataUrl, screenshotFullPage, visionPass } from "./media";
import {
  deriveCompletionCheck,
  deriveFinalVerdict,
  deriveGoal,
  deriveHumanGuidedDecision,
  deriveSelfHealDecision,
  fallbackFinalVerdict,
  generateClarificationQuestion,
} from "./models";
import {
  assessInformationAnswer,
  buildDeterministicFinalGate,
  classifyFailure,
  deriveVisualFinalVerdict,
  synthesizeActionMetadata,
  verifyActionOutcome,
} from "./verification";

export type RunOnceCoreInput = {
  runId: string;
  url: string;
  task: string;
  maxSteps: number;
  runDir: string;
  allowHumanHelp: boolean;
  difficulty?: string;
  runLabel?: string;
  currentDate: { iso: string; local: string };
};

// TOTO RIADI HLAVNU SLUCKU JEDNEHO BEHU AGENTA
export async function runOnceCore(input: RunOnceCoreInput) {
  const { runId, url, task, maxSteps, runDir, allowHumanHelp, difficulty, runLabel, currentDate } = input;
  const runStartedAt = Date.now();
  const configuredModel = getModelId((uiAgent as any).model, DEFAULT_OPENAI_MODEL);
  const normalizedDifficulty = typeof difficulty === "string" && difficulty.trim() ? difficulty.trim() : null;
  const normalizedRunLabel = typeof runLabel === "string" && runLabel.trim() ? runLabel.trim() : runId;
  type SuccessMode = "strict" | "llm_soft" | "user_forced";

  let completed = false;
  let stopReason = "";
  let lastDecisionSig: string | null = null;
  let sameDecisionCount = 0;
  let stalePageCount = 0;
  let lastPageSig: string | null = null;
  let helpRound = 0;
  let stepsExecuted = 0;
  let replanCount = 0;
  let latestSnapshot: any = null;
  let latestVisionNotes: VisionNotes | null = null;
  let latestPageKind: PageKind = "unknown";
  let latestActiveSubtaskId: string | null = null;
  let finalVerdict: string | null = null;
  let latestDeterministicFinalGate: DeterministicFinalGate | null = null;
  let latestVisualFinalVerdict: { verdict: "confirmed" | "contradicted" | "inconclusive"; reason: string; evidence: string[] } | null =
    null;
  let latestCompletionCheck: CompletionCheck | null = null;
  let successMode: SuccessMode | null = null;

  const completedSubtasks = new Set<string>();
  const recentActionSigs: string[] = [];
  const helpHistory: string[] = [];
  type DoneClaimRecord = { step: number; pageSig: string; done: boolean };
  const doneClaimWindow: DoneClaimRecord[] = [];
  let lastDoneClaimRecordedAtStep: number | null = null;
  const CONSENSUS_WINDOW = 3;
  const CONSENSUS_REQUIRED_HITS = 2;
  let cookieDismissFailures = 0;
  let cookieBannerSuppressed = false;
  let lastCookieDismissAttemptedAtStep: number | null = null;
  const COOKIE_DISMISS_MAX_FAILURES = 3;
  const stepTrace: Array<Record<string, any>> = [];
  const blockerEvents: Array<Record<string, any>> = [];
  const recoveryTransitions: Array<Record<string, any>> = [];
  const actionVerifications: Array<Record<string, any>> = [];
  const blockerAttemptedKeys = new Set<string>();
  const safeFallbackAttemptedKeys = new Set<string>();
  const tokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    callCount: 0,
  };
  const replanReasons: Record<ReplanReason, number> = {
    backward_subtask_blocked: 0,
    pending_human_guidance_replan: 0,
    need_help_suppressed_later_workflow: 0,
    selector_missing: 0,
    click_text_missing: 0,
    no_action_executed: 0,
  };

  let initialSnapshot: any = null;
  let initialVisionNotes: VisionNotes | null = null;
  let goalSpec: GoalSpec | null = null;
  let pendingHumanDirective: PendingHumanDirective | null = null;
  let pendingSelfHeal: PendingSelfHeal | null = null;
  let tools: any = null;
  let selfHealAttempts = 0;
  let humanGuidedStepCount = 0;
  const selfHealAttemptedKeys = new Set<string>();
  const completionCheckCache = new Map<string, CompletionCheck | null>();

  function recordUsage(usage: ModelUsage) {
    tokenUsage.promptTokens += usage.promptTokens;
    tokenUsage.completionTokens += usage.completionTokens;
    tokenUsage.totalTokens += usage.totalTokens;
    tokenUsage.callCount += 1;
  }

  function recordBlockerEvent(kind: string, step: number, detail: string, extra: Record<string, any> = {}) {
    blockerEvents.push({
      ts: Date.now(),
      step,
      kind,
      detail,
      ...extra,
    });
  }

  function recordRecoveryTransition(kind: string, step: number, detail: string, extra: Record<string, any> = {}) {
    recoveryTransitions.push({
      ts: Date.now(),
      step,
      kind,
      detail,
      ...extra,
    });
  }

  function roundMetric(value: number, digits = 3) {
    if (!Number.isFinite(value)) return 0;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function computePartialSuccess(success: boolean) {
    if (success) return 1;

    const totalSubtasks = goalSpec?.subtasks.length ?? 0;
    const completedSubtaskCount = completedSubtasks.size;
    const subtaskRatio = totalSubtasks > 0 ? completedSubtaskCount / totalSubtasks : 0;

    const totalFinalRequirements = latestDeterministicFinalGate?.finalRequirements.length ?? 0;
    const fulfilledFinalRequirements = latestDeterministicFinalGate?.fulfilled.length ?? 0;
    const requirementRatio = totalFinalRequirements > 0 ? fulfilledFinalRequirements / totalFinalRequirements : 0;

    return roundMetric(Math.max(subtaskRatio, requirementRatio), 3);
  }

  function deriveFailureSubtype(failureType: string, finalError?: string) {
    if (failureType === "completed") return null;

    const normalizedStopReason = String(stopReason ?? "").trim();
    if (failureType === "user_control") return normalizedStopReason || String(finalError ?? "").trim() || "user_control";
    if (failureType === "max_steps") return normalizedStopReason || "max_steps_reached";
    if (failureType === "execution_failure") return normalizedStopReason || String(finalError ?? "").trim() || "execution_failure";

    if (failureType === "blocker_loop_guard") {
      const lastLoopGuard = [...blockerEvents].reverse().find((event) => event.kind === "loop_guard");
      return String((lastLoopGuard?.detail ?? lastLoopGuard?.kind ?? normalizedStopReason) || "loop_guard");
    }

    if (failureType === "recovery_exhausted") {
      const lastRecovery = recoveryTransitions[recoveryTransitions.length - 1];
      return String((lastRecovery?.kind ?? lastRecovery?.detail ?? normalizedStopReason) || "recovery_exhausted");
    }

    if (failureType === "final_gate_missing") {
      const missing = latestDeterministicFinalGate?.missing ?? [];
      if (missing.length === 1) return missing[0];
      if (missing.length > 1) return `missing:${missing.join(" | ")}`;
      return normalizedStopReason || "final_gate_missing";
    }

    return normalizedStopReason || String(finalError ?? "").trim() || null;
  }

  function visionOverlayBlocksInteraction(visionNotes: VisionNotes | null) {
    const overlay = visionNotes?.overlay;
    if (!overlay?.present) return false;
    const blocksRaw = (overlay as any).blocksInteraction;
    const areaRaw = (overlay as any).approxAreaPct;
    const blocks = typeof blocksRaw === "boolean" ? blocksRaw : true;
    const area = typeof areaRaw === "number" ? areaRaw : null;
    if (!blocks) return false;
    if (area !== null && area < 12) return false;
    if (cookieBannerSuppressed && overlay.type === "cookie_consent") return false;
    return true;
  }

  function hasVisibleBlockerOrError(snapshot: any, visionNotes: VisionNotes | null) {
    const cookieLike = Boolean(snapshot?.pageMeta?.cookieLikeOverlay);
    const cookieFromVision = visionNotes?.overlay?.type === "cookie_consent";
    const cookieSuppressed = cookieBannerSuppressed && (cookieLike || cookieFromVision);
    return Boolean(
      snapshot?.pageMeta?.modalOpen ||
      (!cookieSuppressed && cookieLike) ||
      visionOverlayBlocksInteraction(visionNotes) ||
      visionNotes?.error?.present
    );
  }

  function getRecentVerificationSlice(step: number, window = 3) {
    const minStep = Math.max(0, step - window);
    return actionVerifications.filter((item) => {
      const itemStep = Number(item?.step);
      return Number.isFinite(itemStep) && itemStep >= minStep && itemStep <= step;
    });
  }

  function shouldAcceptSoftCompletion(args: {
    step: number;
    snapshot: any;
    visionNotes: VisionNotes | null;
    pageKind: PageKind;
    completionCheck: CompletionCheck | null;
  }) {
    if (!args.completionCheck?.done) {
      return { accept: false, reason: "Completion check is not done." };
    }

    if (latestVisualFinalVerdict?.verdict === "contradicted") {
      return { accept: false, reason: "Vision contradicts the current completion state." };
    }

    if (hasVisibleBlockerOrError(args.snapshot, args.visionNotes)) {
      return { accept: false, reason: "A visible blocker or page error is still present." };
    }

    const recentVerifications = getRecentVerificationSlice(args.step, 3);
    const recentFailed = recentVerifications.some((item) => item?.verification?.outcome === "failed");
    if (recentFailed) {
      return { accept: false, reason: "A recent action verification still failed." };
    }

    const supportSignals = [
      (args.completionCheck.evidence ?? []).filter(Boolean).length > 0,
      completedSubtasks.size > 0,
      (latestDeterministicFinalGate?.fulfilled.length ?? 0) > 0,
      args.pageKind !== "unknown",
      recentVerifications.some((item) => item?.verification?.outcome === "confirmed"),
    ];
    const supportCount = supportSignals.filter(Boolean).length;

    if (supportCount < 2) {
      return {
        accept: false,
        reason: `Completion check lacks enough supporting signals (${supportCount}/2).`,
      };
    }

    return {
      accept: true,
      reason: `Completion check is supported by ${supportCount} non-contradictory signals.`,
    };
  }

  // TOTO NASILNE SCHOVA COOKIE OVERLAY POMOCOU CSS
  async function forceHideCookieOverlay(): Promise<{ removed: number; reason: string }> {
    try {
      const page = await getPage();
      const result = await page.evaluate(() => {
        const looksCookieish = (s: string) => /cookie|consent|gdpr|privacy|tracking|suhlas|akzept|zustimm/i.test(s);
        const candidates: any[] = [];
        const queue: any[] = [document];
        const seen = new Set<any>();
        while (queue.length) {
          const root: any = queue.shift();
          if (!root || seen.has(root)) continue;
          seen.add(root);
          let nodes: any[] = [];
          try { nodes = Array.from((root.querySelectorAll?.("*") as any) ?? []); } catch { nodes = []; }
          for (const node of nodes) {
            if ((node as any).shadowRoot) queue.push((node as any).shadowRoot);
            const tag = String(node.tagName || "").toLowerCase();
            const id = String(node.id || "");
            const cls = String(node.className || "");
            const role = String(node.getAttribute?.("role") || "").toLowerCase();
            const ariaModal = node.getAttribute?.("aria-modal") === "true";
            const text = String(node.innerText || node.textContent || "").slice(0, 400);
            const looksLike =
              looksCookieish(`${id} ${cls}`) ||
              (role === "dialog" && looksCookieish(text)) ||
              (ariaModal && looksCookieish(text)) ||
              tag === "dialog";
            if (!looksLike) continue;
            const rect = node.getBoundingClientRect?.();
            if (!rect || rect.width < 80 || rect.height < 40) continue;
            candidates.push(node);
          }
        }

        let removed = 0;
        for (const node of candidates) {
          try {
            (node as HTMLElement).style.setProperty("display", "none", "important");
            (node as HTMLElement).setAttribute("aria-hidden", "true");
            removed += 1;
          } catch {}
        }
        try {
          document.documentElement.style.removeProperty("overflow");
          document.body.style.removeProperty("overflow");
        } catch {}
        return removed;
      });
      return { removed: Number(result) || 0, reason: "force_hide_cookie_overlay" };
    } catch (e: any) {
      return { removed: 0, reason: `force_hide_cookie_overlay_failed: ${e?.message ?? String(e)}` };
    }
  }

  function tryAcceptAgentAnswer(args: {
    decision: any;
    snapshot: any;
    visionNotes: VisionNotes | null;
    pageKind: PageKind;
    step: number;
  }): { accept: boolean; reason: string; answer?: string } {
    if (!args.decision?.done) return { accept: false, reason: "Decision is not done." };
    if (latestVisualFinalVerdict?.verdict === "contradicted") {
      return { accept: false, reason: "Vision verdict contradicts completion." };
    }
    if (args.visionNotes?.error?.present) {
      return { accept: false, reason: "Visible page error blocks answer acceptance." };
    }
    if (args.snapshot?.pageMeta?.modalOpen || args.snapshot?.pageMeta?.cookieLikeOverlay) {
      return { accept: false, reason: "DOM-confirmed blocker still present." };
    }

    const recentVerifications = getRecentVerificationSlice(args.step, 3);
    if (recentVerifications.some((item) => item?.verification?.outcome === "failed")) {
      return { accept: false, reason: "A recent action verification failed." };
    }

    const candidateRaw = [
      args.decision?.progressNote,
      args.decision?.reason,
      args.decision?.text,
    ]
      .map((v) => String(v ?? "").trim())
      .filter(Boolean)
      .join("\n");

    if (candidateRaw.length < 12) return { accept: false, reason: "Agent payload has no answer-like content." };

    const hasNumericToken = /\d/.test(candidateRaw);
    const hasStructuredAnswer =
      /(\d{1,2}[:.]\d{2})|(\d{1,2}\.\s?\d{1,2})|(€|\$|£|usd|eur|czk|kč)|(\b\d{2,4}\b)/i.test(candidateRaw);
    if (!hasNumericToken || !hasStructuredAnswer) {
      return { accept: false, reason: "Agent payload lacks structured numeric/answer-like content." };
    }

    const sameSigClaims = doneClaimWindow.filter((claim) => claim.pageSig === pageSignature(args.snapshot, args.visionNotes));
    const positives = sameSigClaims.filter((claim) => claim.done).length;
    const supportSignals = [
      positives >= 1,
      completedSubtasks.size > 0,
      (latestDeterministicFinalGate?.fulfilled.length ?? 0) > 0,
      args.pageKind !== "unknown",
      recentVerifications.some((item) => item?.verification?.outcome === "confirmed"),
    ].filter(Boolean).length;

    if (supportSignals < 2) {
      return {
        accept: false,
        reason: `Answer-like payload lacks supporting context (${supportSignals}/2 signals).`,
      };
    }

    return {
      accept: true,
      reason: `Agent answer accepted (numeric/structured content with ${supportSignals} supporting signals).`,
      answer: candidateRaw,
    };
  }

  function recordDoneClaimAndCheckConsensus(args: {
    pageSig: string;
    completionDone: boolean;
    snapshot: any;
    visionNotes: VisionNotes | null;
    step: number;
  }): { accept: boolean; reason: string; count: number } {
    const alreadyRecordedThisStep =
      lastDoneClaimRecordedAtStep === args.step &&
      doneClaimWindow.length > 0 &&
      doneClaimWindow[doneClaimWindow.length - 1].step === args.step;

    if (!alreadyRecordedThisStep) {
      doneClaimWindow.push({ step: args.step, pageSig: args.pageSig, done: args.completionDone });
      while (doneClaimWindow.length > CONSENSUS_WINDOW) doneClaimWindow.shift();
      lastDoneClaimRecordedAtStep = args.step;
    }

    const sameSigClaims = doneClaimWindow.filter((claim) => claim.pageSig === args.pageSig);
    const positives = sameSigClaims.filter((claim) => claim.done).length;
    const negatives = sameSigClaims.length - positives;

    if (!args.completionDone && positives < CONSENSUS_REQUIRED_HITS) {
      return {
        accept: false,
        reason: `Consensus negative claim recorded (${positives}/${CONSENSUS_REQUIRED_HITS} positives in window of ${sameSigClaims.length}).`,
        count: positives,
      };
    }

    if (positives < CONSENSUS_REQUIRED_HITS) {
      return {
        accept: false,
        reason: `Consensus building (${positives}/${CONSENSUS_REQUIRED_HITS} positives in window of ${sameSigClaims.length}, ${negatives} negatives).`,
        count: positives,
      };
    }

    if (latestVisualFinalVerdict?.verdict === "contradicted") {
      return { accept: false, reason: "Vision verdict contradicts completion; consensus blocked.", count: positives };
    }

    if (args.visionNotes?.error?.present) {
      return { accept: false, reason: "Visible page error blocks consensus completion.", count: positives };
    }

    if (args.snapshot?.pageMeta?.modalOpen || args.snapshot?.pageMeta?.cookieLikeOverlay) {
      return { accept: false, reason: "DOM-confirmed blocker still present; consensus blocked.", count: positives };
    }

    const recentVerifications = getRecentVerificationSlice(args.step, 3);
    const recentFailed = recentVerifications.some((item) => item?.verification?.outcome === "failed");
    if (recentFailed) {
      return { accept: false, reason: "A recent action verification failed; consensus blocked.", count: positives };
    }

    return {
      accept: true,
      reason: `Consensus reached: ${positives}/${sameSigClaims.length} positive done-claims on the same page signature within window of ${CONSENSUS_WINDOW}.`,
      count: positives,
    };
  }

  function getVisionReason(args: {
    snapshot: any;
    pageKind: PageKind;
    forceReason?: string;
    infoAnswerUnclear?: boolean;
    failedEffect?: boolean;
  }) {
    if (args.forceReason) return args.forceReason;
    if (args.failedEffect) return "failed_expected_effect";
    if (args.snapshot?.pageMeta?.cookieLikeOverlay || args.snapshot?.pageMeta?.modalOpen) return "blocker_or_overlay";
    if (args.pageKind === "unknown") return "uncertain_page_state";
    if (stalePageCount > 0 || pendingSelfHeal) return "repeated_stagnation";
    if (args.infoAnswerUnclear) return "information_answer_unclear";
    return null;
  }

  async function runVisionIfNeeded(args: {
    snapshot: any;
    pageKind: PageKind;
    step: number;
    forceReason?: string;
    infoAnswerUnclear?: boolean;
    failedEffect?: boolean;
  }) {
    const reason = getVisionReason(args);
    if (!reason) return { visionNotes: null as VisionNotes | null, reason: null as string | null };

    emit({
      type: "log",
      runId,
      ts: Date.now(),
      message: `VisionReason[step=${args.step}]: ${reason}`,
    });

    try {
      const visionNotes = await visionPass(undefined, recordUsage);
      emit({
        type: "log",
        runId,
        ts: Date.now(),
        message: safeLogMessage(`VisionNotes[${reason}]: ${JSON.stringify(visionNotes)}`),
      });
      return { visionNotes, reason };
    } catch (e: any) {
      emit({
        type: "log",
        runId,
        ts: Date.now(),
        message: safeLogMessage(`Vision pass failed [${reason}]: ${e?.message ?? String(e)}`),
      });
      return { visionNotes: null as VisionNotes | null, reason };
    }
  }

  function findExpandableAction(snapshot: any): AgentAction | null {
    const items = [
      ...(Array.isArray(snapshot?.buttons) ? snapshot.buttons : []),
      ...(Array.isArray(snapshot?.clickables) ? snapshot.clickables : []),
    ];

    for (const item of items) {
      const label = String(item?.text ?? item?.ariaLabel ?? "").replace(/\s+/g, " ").trim();
      if (!label) continue;
      if (!includesAny(label, ["more", "show", "expand", "details", "detail", "summary", "filter", "menu"])) continue;
      if (includesAny(label, ["add to cart", "checkout", "login", "accept", "reject"])) continue;

      const selector = String(item?.selector ?? "").trim();
      if (selector) {
        return {
          action: "click",
          selector: normalizeCssSelector(selector),
          text: null,
          mayNavigate: false,
          expectedEffect: "A collapsed or hidden section expands.",
          successSignal: "New content or controls become visible in the current page state.",
          failureSignal: "The same section remains collapsed with no visible change.",
          fallbackHint: "Try a short scroll or a different visible expand control.",
        };
      }
    }

    return null;
  }

  async function trySafeFallback(step: number, snapshot: any, visionNotes: VisionNotes | null, pageKind: PageKind, reason: string) {
    const pageSig = pageSignature(snapshot, visionNotes);
    const attemptKey = `${reason}::${pageSig}`;
    if (safeFallbackAttemptedKeys.has(attemptKey)) return false;
    safeFallbackAttemptedKeys.add(attemptKey);

    try {
      if (visionNotes?.overlay?.present && visionNotes?.overlay?.acceptText) {
        const acceptText = visionNotes.overlay.acceptText;
        const vKey = `safe_fallback_vision::${pageSig}::${acceptText}`;
        if (!blockerAttemptedKeys.has(vKey)) {
          blockerAttemptedKeys.add(vKey);
          recordRecoveryTransition("safe_fallback", step, `Vision sees overlay, trying clickByText("${acceptText}").`, { reason, pageKind });
          await tools.clickByTextTool.execute({ context: { text: acceptText, exact: false } } as any);
          return true;
        }
      }

      const expandAction = findExpandableAction(snapshot);
      if (expandAction?.selector) {
        recordRecoveryTransition("safe_fallback", step, "Trying generic expand action before human help.", { reason, pageKind });
        await tools.clickTool.execute({ context: { selector: expandAction.selector } } as any);
        return true;
      }

      if (!snapshot?.pageMeta?.nearBottom) {
        recordRecoveryTransition("safe_fallback", step, "Trying generic short scroll before human help.", { reason, pageKind });
        await tools.scrollTool.execute({ context: { direction: "down", amount: 700 } } as any);
        return true;
      }

      if (initialSnapshot?.url && snapshot?.url && String(snapshot.url) !== String(initialSnapshot.url)) {
        recordRecoveryTransition("safe_fallback", step, "Trying browser back before human help.", { reason, pageKind });
        const page = await getPage();
        await page.goBack({ timeout: 4000 }).catch(() => {});
        return true;
      }

      recordRecoveryTransition("safe_fallback", step, "Trying short wait before human help.", { reason, pageKind });
      await miniStabilize(500);
      return true;
    } catch (error: any) {
      emit({
        type: "log",
        runId,
        ts: Date.now(),
        message: safeLogMessage(`Safe fallback failed: ${error?.message ?? String(error)}`),
      });
      return false;
    }
  }

  async function observeAfterAction(step: number, forceReason: string | undefined, snapshot: any) {
    const refreshedSnapshot = await tools.getSnapshotTool.execute({ context: { mode: "recovery" } } as any);
    const provisionalPageKind = detectPageKind(refreshedSnapshot, null);
    const infoAssessment = assessInformationAnswer({
      task,
      goalSpec,
      snapshot: refreshedSnapshot,
      visionNotes: null,
    });
    const vision = await runVisionIfNeeded({
      snapshot: refreshedSnapshot,
      pageKind: provisionalPageKind,
      step,
      forceReason,
      failedEffect: forceReason === "failed_expected_effect",
      infoAnswerUnclear: Boolean(infoAssessment?.pageRelevant && !infoAssessment?.answerVisible),
    });
    const refreshedVision = vision.visionNotes;
    const refreshedPageKind = detectPageKind(refreshedSnapshot, refreshedVision);
    latestSnapshot = refreshedSnapshot;
    latestVisionNotes = refreshedVision;
    latestPageKind = refreshedPageKind;
    return {
      snapshot: refreshedSnapshot,
      visionNotes: refreshedVision,
      pageKind: refreshedPageKind,
    };
  }

  async function pauseRunForUserDirective(step?: number, pageKind?: PageKind, activeSubtaskId?: string | null) {
    const control = getRunControl(runId);
    if (!control || control.state !== "stop_requested") return;

    markRunPaused(runId, control.reason ?? "paused_by_user");
    emit({
      type: "run_control",
      runId,
      ts: Date.now(),
      state: "paused",
      reason: control.reason ?? "paused_by_user",
    });

    helpRound++;
    const helpId = crypto.randomUUID();
    const effectiveStep = typeof step === "number" ? step : stepsExecuted > 0 ? stepsExecuted - 1 : 0;
    const effectivePageKind = pageKind ?? latestPageKind;

    const { question: generatedQuestion, quickReplies: generatedReplies } = await generateClarificationQuestion({
      task,
      reason: "resume_after_stop",
      snapshot: latestSnapshot,
      pageKind: effectivePageKind,
      visionNotes: latestVisionNotes,
      options: summarizeOptions(latestSnapshot, 8),
      activeSubtaskTitle: getSubtaskTitle(goalSpec, activeSubtaskId ?? latestActiveSubtaskId),
      completedSubtasks: [...completedSubtasks],
      pendingHumanDirective,
      onUsage: recordUsage,
    });
    const question = generatedQuestion;

    emit({
      type: "log",
      runId,
      ts: Date.now(),
      message: "Run paused by user. Waiting for clarification to continue.",
    });

    emitPhase({
      stage: "waiting_for_human",
      label: "Beh je pozastaveny",
      detail: question,
      step: effectiveStep,
      pageKind: effectivePageKind,
      activeSubtaskId: activeSubtaskId ?? latestActiveSubtaskId,
    });

    emit({
      type: "need_help",
      runId,
      ts: Date.now(),
      step: effectiveStep,
      helpId,
      reason: "resume_after_stop",
      question,
      context: {
        kind: "resume_after_stop",
        quickReplies: generatedReplies.length ? generatedReplies : undefined,
      },
    });

    let text = "";
    try {
      text = await waitForHelp(runId, helpId, 1_800_000);
    } catch (error) {
      throwIfRunInterrupted(runId);
      throw error;
    }

    helpHistory.push(text);
    emit({ type: "help_received", runId, ts: Date.now(), helpId, text });
    emit({ type: "log", runId, ts: Date.now(), message: safeLogMessage(`ResumeAfterStop: ${text}`) });

    pendingHumanDirective = {
      text,
      sourceReason: "resume_after_stop",
      createdAtStep: effectiveStep,
      appliedCount: 0,
      appliedOnSignatures: [],
    };
    pendingSelfHeal = null;
    lastDecisionSig = null;
    sameDecisionCount = 0;
    stalePageCount = 0;

    resumeRun(runId, "resumed_after_stop");
    emit({
      type: "run_control",
      runId,
      ts: Date.now(),
      state: "running",
      reason: "resumed_after_stop",
    });
    emit({
      type: "log",
      runId,
      ts: Date.now(),
      message: "Run resumed after clarification from the user.",
    });
  }

  async function checkControlPoint(step?: number, pageKind?: PageKind, activeSubtaskId?: string | null) {
    const control = getRunControl(runId);
    if (control?.state === "stop_requested") {
      await pauseRunForUserDirective(step, pageKind, activeSubtaskId);
    }

    throwIfRunInterrupted(runId);
  }

  emit({ type: "run_started", runId, ts: Date.now(), url, task });
  emit({ type: "run_control", runId, ts: Date.now(), state: "running", reason: "run_started" });
  emit({ type: "log", runId, ts: Date.now(), message: `Starting run... humanHelp=${allowHumanHelp}` });
  emitPhase({
    stage: "starting",
    label: "Spustam agenta",
    detail: "Otvaram cielovu stranku a pripravujem prve snimky stavu.",
  });

  function emitPhase(args: {
    stage: JourneyStage;
    label: string;
    detail: string;
    step?: number;
    pageKind?: PageKind;
    activeSubtaskId?: string | null;
    decisionSource?: DecisionSource;
    verdict?: string | null;
  }) {
    const activeSubtaskId = args.activeSubtaskId ?? null;

    emit({
      type: "phase",
      runId,
      ts: Date.now(),
      stage: args.stage,
      label: args.label,
      detail: args.detail,
      step: args.step,
      pageKind: args.pageKind,
      activeSubtaskId,
      activeSubtaskTitle: getSubtaskTitle(goalSpec, activeSubtaskId),
      decisionSource: args.decisionSource,
      verdict: args.verdict ?? undefined,
    });
  }

  function markSubtasksDone(ids: string[] | undefined, source: string) {
    if (!goalSpec || !ids?.length) return;
    const known = getKnownSubtaskIds(goalSpec);
    for (const id of ids) {
      if (!known.has(id) || completedSubtasks.has(id)) continue;
      completedSubtasks.add(id);
      emit({ type: "log", runId, ts: Date.now(), message: `Subtask completed [${source}]: ${id}` });
    }
  }

  function markReplan(reason: ReplanReason) {
    replanCount++;
    replanReasons[reason]++;
  }

  function buildSelfHealKey(source: SelfHealSource, pageSig: string) {
    return `${source}::${pageSig}`;
  }

  function scheduleSelfHeal(args: {
    source: SelfHealSource;
    reason: string;
    step: number;
    pageSig: string;
    lastDecisionSig?: string | null;
    lastError?: string;
  }) {
    const key = buildSelfHealKey(args.source, args.pageSig);
    if (selfHealAttemptedKeys.has(key)) {
      return false;
    }

    selfHealAttemptedKeys.add(key);
    selfHealAttempts++;
    pendingSelfHeal = {
      source: args.source,
      reason: args.reason,
      createdAtStep: args.step,
      lastError: args.lastError,
      lastDecisionSig: args.lastDecisionSig ?? undefined,
      originatingPageSig: args.pageSig,
    };
    emit({
      type: "log",
      runId,
      ts: Date.now(),
      message: safeLogMessage(`Self-heal scheduled [${args.source}]: ${args.reason}`),
    });
    return true;
  }

  async function writeSummary(success: boolean, finalError?: string) {
    let finalUrl: string | null = null;

    try {
      const page = await getPage();
      finalUrl = page.url();
    } catch {
      finalUrl = null;
    }

    const failureType = classifyFailure({
      success,
      stopReason,
      finalGate: latestDeterministicFinalGate,
      blockerEvents,
      recoveryTransitions,
    });
    const failureSubtype = deriveFailureSubtype(failureType, finalError);
    const totalSubtasks = goalSpec?.subtasks.length ?? 0;
    const completedSubtasksCount = completedSubtasks.size;
    const partialSuccess = computePartialSuccess(success);
    const durationSeconds = roundMetric((Date.now() - runStartedAt) / 1000, 3);
    const benchmarkRow = {
      Model: configuredModel,
      Difficulty: normalizedDifficulty,
      Run: normalizedRunLabel,
      "Success 0/1": success ? 1 : 0,
      Completed_Subtasks: completedSubtasksCount,
      Total_Subtasks: totalSubtasks,
      Partial_Success: partialSuccess,
      Steps: stepsExecuted,
      Replans: replanCount,
      Duration_seconds: durationSeconds,
      HumanHelp_Verbal: helpHistory.length,
      HumanHelp_Actions: humanGuidedStepCount,
      Tokens_Total: tokenUsage.totalTokens,
      Failure_Type: failureType,
      Failure_Subtype: failureSubtype,
      Final_URL: finalUrl,
      Final_Verdict: finalVerdict || null,
    };

    const summary = {
      runId,
      url,
      task,
      runMeta: {
        model: configuredModel,
        difficulty: normalizedDifficulty,
        run: normalizedRunLabel,
      },
      goalSpec,
      success,
      successMode,
      stopReason,
      finalVerdict: finalVerdict || undefined,
      error: finalError || undefined,
      failureClassification: failureType,
      failureSubtype,
      allowHumanHelp,
      finalGate: latestDeterministicFinalGate,
      completionCheck: latestCompletionCheck,
      visualFinalVerdict: latestVisualFinalVerdict,
      benchmarkRow,
      metrics: {
        humanHelpRequests: helpRound,
        humanHelpResponses: helpHistory.length,
        humanHelpActions: humanGuidedStepCount,
        selfHealAttempts,
        replanCount,
        replanReasons,
        stepsExecuted,
        durationSeconds,
        partialSuccess,
        completedSubtasksCount,
        totalSubtasks,
        deterministicGateSatisfied: Boolean(latestDeterministicFinalGate?.satisfied),
        llmCompletionDone: Boolean(latestCompletionCheck?.done),
        tokenUsage,
      },
      helpRound,
      completedSubtasks: [...completedSubtasks],
      stepsExecuted,
      finalUrl,
      helpHistory,
      blockerEvents,
      recoveryTransitions,
      actionVerifications,
      stepTrace,
    };

    await fs.writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  }

  async function resolveFinalVerdict(success: boolean) {
    if (finalVerdict?.trim()) {
      return finalVerdict.trim();
    }

    if (!success) {
      finalVerdict = fallbackFinalVerdict({ success, stopReason });
      return finalVerdict;
    }

    const derived = await deriveFinalVerdict({
      task,
      goalSpec,
      snapshot: latestSnapshot,
      visionNotes: latestVisionNotes,
      completedSubtasks,
      pageKind: latestPageKind,
      success,
      stopReason,
      currentDate,
      onUsage: recordUsage,
    });

    finalVerdict = derived?.trim() || fallbackFinalVerdict({ success, stopReason });
    return finalVerdict;
  }

  async function requestUserHelp(
    step: number,
    reason: string,
    snapshot: any,
    visionNotes: VisionNotes | null,
    pageKind: PageKind,
    activeSubtaskId?: string | null,
    lastSig?: string,
    lastError?: string
  ) {
    if (!allowHumanHelp) {
      throw new Error(`Human help disabled. Blocked reason: ${reason}`);
    }

    helpRound++;
    const helpId = crypto.randomUUID();
    const optionsList = summarizeOptions(snapshot, 8);
    const activeSubtaskTitle = getSubtaskTitle(goalSpec, activeSubtaskId);

    const { question, quickReplies } = await generateClarificationQuestion({
      task,
      reason,
      lastError,
      snapshot,
      pageKind,
      visionNotes,
      options: optionsList,
      activeSubtaskTitle,
      completedSubtasks: [...completedSubtasks],
      pendingHumanDirective,
      onUsage: recordUsage,
    });

    if (lastSig) {
      emit({ type: "log", runId, ts: Date.now(), message: safeLogMessage(`HelpDebug lastSig: ${lastSig}`) });
    }
    if (lastError) {
      emit({ type: "log", runId, ts: Date.now(), message: safeLogMessage(`HelpDebug lastError: ${lastError}`) });
    }

    emitPhase({
      stage: "waiting_for_human",
      label: "Cakam na odpoved cloveka",
      detail: question,
      step,
      pageKind,
      activeSubtaskId,
    });

    emit({
      type: "need_help",
      runId,
      ts: Date.now(),
      step,
      helpId,
      reason,
      question,
      context: {
        url: snapshot?.url ?? null,
        pageKind,
        title: snapshot?.title ?? null,
        activeSubtaskId: activeSubtaskId ?? null,
        activeSubtaskTitle,
        visionError: visionNotes?.error?.text ?? null,
        options: optionsList,
        quickReplies: quickReplies.length ? quickReplies : undefined,
      },
    });

    let text = "";
    try {
      text = await waitForHelp(runId, helpId, 180_000);
    } catch (error) {
      const control = getRunControl(runId);
      if (control?.state === "stop_requested") {
        await pauseRunForUserDirective(step, pageKind, activeSubtaskId);
        return "";
      }
      throw error;
    }

    helpHistory.push(text);
    emit({ type: "help_received", runId, ts: Date.now(), helpId, text });
    emit({ type: "log", runId, ts: Date.now(), message: safeLogMessage(`UserHelp: ${text}`) });

    pendingHumanDirective = {
      text,
      sourceReason: reason,
      createdAtStep: step,
      appliedCount: 0,
      appliedOnSignatures: [],
    };
    pendingSelfHeal = null;

    lastDecisionSig = null;
    sameDecisionCount = 0;
    stalePageCount = 0;

    return text;
  }

  try {
    const { openPageTool } = await import("../../mastra/tools/openPage");
    const { getSnapshotTool } = await import("../../mastra/tools/getSnapshot");
    const { clickTool } = await import("../../mastra/tools/click");
    const { typeTool } = await import("../../mastra/tools/type");
    const { clickByTextTool } = await import("../../mastra/tools/clickByText");
    const { clickAtPointTool } = await import("../../mastra/tools/clickAtPoint");
    const { pressKeyTool } = await import("../../mastra/tools/pressKey");
    const { scrollTool } = await import("../../mastra/tools/scroll");
    const { waitForTool } = await import("../../mastra/tools/waitFor");

    tools = { clickTool, typeTool, clickByTextTool, clickAtPointTool, pressKeyTool, scrollTool, waitForTool, getSnapshotTool };

    await checkControlPoint();
    emitPhase({
      stage: "starting",
      label: "Otvaram cielovu stranku",
      detail: `Navigujem na ${url}.`,
    });
    await openPageTool.execute({ context: { url } } as any);
    await screenshotFullPage(runDir, runId, `step-${String(0).padStart(3, "0")}.png`);
    emit({ type: "log", runId, ts: Date.now(), message: `Opened ${url}` });

    const initialScreenshotDataUrl = await getViewportScreenshotDataUrl();

    try {
      initialVisionNotes = await visionPass(initialScreenshotDataUrl, recordUsage);
      emit({
        type: "log",
        runId,
        ts: Date.now(),
        message: safeLogMessage(`InitialVisionNotes: ${JSON.stringify(initialVisionNotes)}`),
      });
    } catch (e: any) {
      emit({
        type: "log",
        runId,
        ts: Date.now(),
        message: safeLogMessage(`Initial vision failed: ${e?.message ?? String(e)}`),
      });
      initialVisionNotes = null;
    }

    await checkControlPoint();
    emitPhase({
      stage: "planning",
      label: "LLM planuje postup",
      detail: "Z uvodnej stranky vytvaram plan subtasks pre celu ulohu.",
    });
    initialSnapshot = await getSnapshotTool.execute({ context: {} } as any);
    latestSnapshot = initialSnapshot;
    latestVisionNotes = initialVisionNotes;
    latestPageKind = detectPageKind(initialSnapshot, initialVisionNotes);

    emit({
      type: "log",
      runId,
      ts: Date.now(),
      message: "Initial page grounded. Visible blockers will now be handled automatically in the main loop when needed.",
    });

    try {
      goalSpec = await deriveGoal({
        task,
        currentDate,
        initialSnapshot,
        initialVisionNotes,
        initialScreenshotDataUrl,
        onUsage: recordUsage,
      });
      emit({ type: "plan_ready", runId, ts: Date.now(), goalSpec });
      emit({ type: "log", runId, ts: Date.now(), message: safeLogMessage(`GoalSpec: ${JSON.stringify(goalSpec)}`) });
      emitPhase({
        stage: "planning",
        label: "Plan je pripraveny",
        detail: `Plan obsahuje ${goalSpec.subtasks.length} krokov.`,
      });
    } catch (e: any) {
      emit({
        type: "log",
        runId,
        ts: Date.now(),
        message: safeLogMessage(`Goal pass failed: ${e?.message ?? String(e)}`),
      });
      goalSpec = null;
    }

    markSubtasksDone(inferAutoCompletedSubtasks(goalSpec, initialSnapshot, initialVisionNotes, completedSubtasks), "initial_state");

    for (let step = 0; step < maxSteps; step++) {
      await checkControlPoint(step, latestPageKind, latestActiveSubtaskId);
      stepsExecuted = step + 1;

      let snapshot: any = await getSnapshotTool.execute({ context: { mode: stalePageCount > 0 ? "recovery" : "fast" } } as any);
      const provisionalPageKind = detectPageKind(snapshot, null);
      const infoAssessmentBeforeVision = assessInformationAnswer({
        task,
        goalSpec,
        snapshot,
        visionNotes: null,
      });
      const initialVision = await runVisionIfNeeded({
        snapshot,
        pageKind: provisionalPageKind,
        step,
        infoAnswerUnclear: Boolean(infoAssessmentBeforeVision?.pageRelevant && !infoAssessmentBeforeVision?.answerVisible),
      });
      let visionNotes: VisionNotes | null = initialVision.visionNotes;

      await checkControlPoint(step, latestPageKind, latestActiveSubtaskId);
      markSubtasksDone(inferAutoCompletedSubtasks(goalSpec, snapshot, visionNotes, completedSubtasks), "state_inference");

      let pageKind = detectPageKind(snapshot, visionNotes);
      const currentPageSig = pageSignature(snapshot, visionNotes);
      const lastHelp = helpHistory.length ? helpHistory[helpHistory.length - 1] : null;
      latestSnapshot = snapshot;
      latestVisionNotes = visionNotes;
      latestPageKind = pageKind;

      if (
        lastCookieDismissAttemptedAtStep !== null &&
        lastCookieDismissAttemptedAtStep === step - 1 &&
        !cookieBannerSuppressed
      ) {
        const stillCookie =
          (visionNotes?.overlay?.type === "cookie_consent" && Boolean(visionNotes?.overlay?.present)) ||
          Boolean(snapshot?.pageMeta?.cookieLikeOverlay);
        if (stillCookie) {
          cookieDismissFailures += 1;
          emit({
            type: "log",
            runId,
            ts: Date.now(),
            message: safeLogMessage(
              `Cookie banner still visible after dismiss attempt (${cookieDismissFailures}/${COOKIE_DISMISS_MAX_FAILURES}).`
            ),
          });
        } else {
          cookieDismissFailures = 0;
        }
        lastCookieDismissAttemptedAtStep = null;
      }

      emit({
        type: "log",
        runId,
        ts: Date.now(),
        message: safeLogMessage(
          `PageGrounding: kind=${pageKind} url=${String(snapshot?.url ?? "")} title=${String(snapshot?.title ?? "")}`
        ),
      });

      emitPhase({
        stage: "analyzing",
        label: "Analyzujem aktualnu stranku",
        detail: `Krok ${step + 1}: citam stav UI a hladam najbezpecnejsie pokracovanie.`,
        step,
        pageKind,
      });

      if (lastPageSig && lastPageSig === currentPageSig) stalePageCount++;
      else stalePageCount = 0;
      lastPageSig = currentPageSig;

      latestDeterministicFinalGate = buildDeterministicFinalGate({
        task,
        goalSpec,
        snapshot,
        visionNotes,
        pageKind,
      });
      latestVisualFinalVerdict = deriveVisualFinalVerdict({
        snapshot,
        visionNotes,
        finalGate: latestDeterministicFinalGate,
      });

      if (latestDeterministicFinalGate.satisfied && latestVisualFinalVerdict.verdict !== "contradicted") {
        if (goalSpec) {
          markSubtasksDone(goalSpec.subtasks.map((x) => x.id), "deterministic_final_gate");
        }
        emit({
          type: "log",
          runId,
          ts: Date.now(),
          message: safeLogMessage(`DeterministicFinalGate: ${JSON.stringify(latestDeterministicFinalGate)}`),
        });
        emit({
          type: "log",
          runId,
          ts: Date.now(),
          message: safeLogMessage(`VisualFinalVerdict: ${JSON.stringify(latestVisualFinalVerdict)}`),
        });
        completed = true;
        successMode = "strict";
        stopReason =
          latestDeterministicFinalGate.answerAssessment?.answerVisible && latestDeterministicFinalGate.answerAssessment.answer
            ? `Visible answer found: ${latestDeterministicFinalGate.answerAssessment.answer}`
            : "Deterministic final requirements satisfied on the current page.";
        finalVerdict = await resolveFinalVerdict(true);
        await screenshotFullPage(runDir, runId, `final.png`);
        break;
      }

      if (latestDeterministicFinalGate.satisfied && latestVisualFinalVerdict.verdict === "contradicted") {
        emit({
          type: "log",
          runId,
          ts: Date.now(),
          message: safeLogMessage(`Final gate contradicted by vision: ${latestVisualFinalVerdict.reason}`),
        });
      }

      if (goalSpec) {
        const completionCacheKey = `${goalSpec.stopCondition}::${currentPageSig}::${[...completedSubtasks].sort().join(",")}`;
        let completionCheck = completionCheckCache.get(completionCacheKey) ?? null;

        if (!completionCheckCache.has(completionCacheKey)) {
          emitPhase({
            stage: "checking_completion",
            label: "Kontrolujem vysledok",
            detail: "Overujem, ci uz aktualna stranka splna zadanie bez dalsich akcii.",
            step,
            pageKind,
          });
          completionCheck = await deriveCompletionCheck({
            task,
            goalSpec,
            snapshot,
            visionNotes,
            completedSubtasks,
            pageKind,
            lastHelp,
            onUsage: recordUsage,
          });
          completionCheckCache.set(completionCacheKey, completionCheck);
        }
        latestCompletionCheck = completionCheck;

        if (completionCheck?.done) {
          emit({
            type: "log",
            runId,
            ts: Date.now(),
            message: safeLogMessage(`CompletionCheck advisory only: ${JSON.stringify(completionCheck)}`),
          });
          if (!latestDeterministicFinalGate.satisfied) {
            const softCompletion = shouldAcceptSoftCompletion({
              step,
              snapshot,
              visionNotes,
              pageKind,
              completionCheck,
            });

            if (softCompletion.accept) {
              emit({
                type: "log",
                runId,
                ts: Date.now(),
                message: safeLogMessage(
                  `SoftSuccess accepted from CompletionCheck: ${softCompletion.reason}. Evidence: ${JSON.stringify(completionCheck.evidence)}`
                ),
              });
              if (goalSpec) {
                markSubtasksDone(goalSpec.subtasks.map((x) => x.id), "completion_check_soft_success");
              }
              completed = true;
              successMode = "llm_soft";
              stopReason = "LLM completion check confirmed task completion despite missing strict deterministic evidence.";
              finalVerdict = await resolveFinalVerdict(true);
              await screenshotFullPage(runDir, runId, `final.png`);
              break;
            }

            const consensus = recordDoneClaimAndCheckConsensus({
              pageSig: currentPageSig,
              completionDone: true,
              snapshot,
              visionNotes,
              step,
            });

            if (consensus.accept) {
              emit({
                type: "log",
                runId,
                ts: Date.now(),
                message: safeLogMessage(
                  `ConsensusSuccess accepted from CompletionCheck: ${consensus.reason}. Evidence: ${JSON.stringify(completionCheck.evidence)}`
                ),
              });
              if (goalSpec) {
                markSubtasksDone(goalSpec.subtasks.map((x) => x.id), "completion_check_consensus_success");
              }
              completed = true;
              successMode = "llm_soft";
              stopReason = `Consensus completion (${consensus.count} stable done-claims) accepted despite missing strict deterministic evidence.`;
              finalVerdict = await resolveFinalVerdict(true);
              await screenshotFullPage(runDir, runId, `final.png`);
              break;
            }

            emit({
              type: "log",
              runId,
              ts: Date.now(),
              message: safeLogMessage(
                `LLM completion check says done, but deterministic final gate is still missing visible evidence. Continuing. SoftSuccess rejected: ${softCompletion.reason}. Consensus: ${consensus.reason}`
              ),
            });
          }
        } else if (completionCheck && completionCheck.done === false) {
          recordDoneClaimAndCheckConsensus({
            pageSig: currentPageSig,
            completionDone: false,
            snapshot,
            visionNotes,
            step,
          });
        }
      }

      const currentDirective = pendingHumanDirective;
      const helpApplySig = currentDirective
        ? `${currentPageSig}::${currentDirective.text}`
        : null;
      const helpAppliedOnCurrentState =
        Boolean(currentDirective && helpApplySig && currentDirective.appliedOnSignatures.includes(helpApplySig));

      let decision: AgentDecision | null = null;
      let decisionSource: DecisionSource = "agent";

      // TOTO RIESI COOKIES A OVERLAYE PODLA VIZUALNYCH SIGNALOV
      const visionSeesOverlay = Boolean(visionNotes?.overlay?.present);
      const visionSeesCookieOverlay =
        visionSeesOverlay && visionNotes?.overlay?.type === "cookie_consent";

      if (
        visionSeesCookieOverlay &&
        !decision &&
        !cookieBannerSuppressed &&
        cookieDismissFailures < COOKIE_DISMISS_MAX_FAILURES &&
        visionNotes?.overlay?.acceptText
      ) {
        const acceptText = visionNotes.overlay.acceptText;
        recordBlockerEvent("vision_overlay", step, `Vision sees cookie_consent overlay.`, {
          overlayType: "cookie_consent",
          acceptText,
          attempt: cookieDismissFailures + 1,
        });
        emit({
          type: "log",
          runId,
          ts: Date.now(),
          message: safeLogMessage(
            `Auto-dismissing cookie consent with "${acceptText}" (attempt ${cookieDismissFailures + 1}/${COOKIE_DISMISS_MAX_FAILURES}).`
          ),
        });
        lastCookieDismissAttemptedAtStep = step;
        decision = {
          done: false,
          reason: `Dismissing cookie consent overlay by clicking "${acceptText}".`,
          activeSubtaskId: null,
          markSubtasksDone: [],
          progressNote: `Zatvaram cookies kliknutim na "${acceptText}".`,
          needHelp: false,
          action: "clickByText",
          selector: null,
          text: acceptText,
          mayNavigate: false,
          expectedEffect: "The cookie overlay disappears.",
          successSignal: "The overlay is no longer visible.",
          failureSignal: "The overlay remains visible.",
          fallbackHint: "Let the agent handle it normally.",
        };
        decisionSource = "self_heal";
      } else if (
        visionSeesCookieOverlay &&
        !decision &&
        !cookieBannerSuppressed &&
        cookieDismissFailures >= COOKIE_DISMISS_MAX_FAILURES
      ) {
        const result = await forceHideCookieOverlay();
        cookieBannerSuppressed = true;
        recordBlockerEvent("vision_overlay_force_hidden", step, result.reason, {
          removed: result.removed,
        });
        emit({
          type: "log",
          runId,
          ts: Date.now(),
          message: safeLogMessage(
            `Cookie banner force-hidden after ${cookieDismissFailures} failed dismiss attempts. Removed ${result.removed} overlay nodes; cookie signals will be ignored from now on.`
          ),
        });
        snapshot = await getSnapshotTool.execute({ context: { mode: "recovery" } } as any);
        latestSnapshot = snapshot;
        pageKind = detectPageKind(snapshot, visionNotes);
        latestPageKind = pageKind;
      }

      if (!decision && pendingSelfHeal) {
        emitPhase({
          stage: "self_healing",
          label: "Agent sa opravuje",
          detail: pendingSelfHeal.reason,
          step,
          pageKind,
        });
        const recovered = await deriveSelfHealDecision({
          task,
          currentDate,
          goalSpec,
          snapshot,
          visionNotes,
          initialSnapshot,
          initialVisionNotes,
          completedSubtasks,
          pageKind,
          pendingHumanDirective,
          pendingSelfHeal,
          helpHistory,
          stalePageCount,
          recentActionSigs,
          onUsage: recordUsage,
        });

        pendingSelfHeal = null;

        if (recovered) {
          decision = recovered;
          decisionSource = "self_heal";
          emit({
            type: "log",
            runId,
            ts: Date.now(),
            message: safeLogMessage(`SelfHealDecision: ${JSON.stringify(recovered)}`),
          });
        }
      }

      if (!decision && currentDirective && !helpAppliedOnCurrentState) {
        emitPhase({
          stage: "applying_human_input",
          label: "Pouzivam odpoved cloveka",
          detail: "Zapracovavam poslednu radu od pouzivatela do dalsieho kroku.",
          step,
          pageKind,
        });
        const guided = await deriveHumanGuidedDecision({
          task,
          currentDate,
          goalSpec,
          snapshot,
          visionNotes,
          humanDirective: currentDirective,
          completedSubtasks,
          pageKind,
          lastHelp,
          onUsage: recordUsage,
        });

        if (guided) {
          decision = guided;
          decisionSource = "human_guided";
          emit({
            type: "log",
            runId,
            ts: Date.now(),
            message: safeLogMessage(`HumanGuidedDecision: ${JSON.stringify(guided)}`),
          });
        }
      }

      if (!decision) {
        emitPhase({
          stage: "thinking",
          label: "LLM premysla dalsi krok",
          detail: "Model vyhodnocuje aktualny stav a vybera dalsiu bezpecnu akciu.",
          step,
          pageKind,
        });

        const agentScreenshot = await getViewportScreenshotDataUrl();

        const agentPayload: any = {
          task,
          currentDate,
          goalSpec,
          snapshot: compactSnapshotForAgent(snapshot),
          visionNotes,
          progress: buildProgressPayload({
            completedSubtasks,
            recentActionSigs,
            stalePageCount,
            helpHistory,
            lastHelp,
            pageKind,
            pendingHumanDirective,
            helpAppliedOnCurrentState,
          }),
          pendingHumanDirective: currentDirective
            ? {
                text: currentDirective.text,
                sourceReason: currentDirective.sourceReason,
                appliedCount: currentDirective.appliedCount,
              }
            : null,
        };

        if (step === 0 || stalePageCount > 0) {
          agentPayload.initialSnapshot = compactSnapshotForPlanner(initialSnapshot);
          agentPayload.initialVisionNotes = initialVisionNotes;
        }

        await checkControlPoint(step, pageKind, latestActiveSubtaskId);

        const agentMessages: any[] = [
          {
            role: "user",
            content: [
              { type: "text", text: JSON.stringify(agentPayload) },
              { type: "image", image: agentScreenshot },
            ],
          },
        ];

        const { generateText: agentGenerateText } = await import("ai");
        const agentModel = createLanguageModel(configuredModel);
        const agentSystemPrompt = (uiAgent as any).instructions ?? "";

        const res = await agentGenerateText({
          model: agentModel,
          system: agentSystemPrompt,
          messages: agentMessages,
        });

        try {
          recordUsage(extractModelUsage(res));
        } catch {}

        const rawText =
          typeof res === "string"
            ? res
            : res?.text ?? res?.output_text ?? res?.output ?? res?.content ?? res?.message?.content ?? res?.result?.text ?? "";

        if (!rawText) throw new Error("Agent returned empty output.");

        const parsed = normalizeParsedDecisionLike(JSON.parse(cleanJsonMaybe(rawText)));
        decision = AgentDecisionSchema.parse(parsed);
      }

      await checkControlPoint(step, pageKind, latestActiveSubtaskId);

      latestActiveSubtaskId = (decision as any).activeSubtaskId ?? null;

      emit({ type: "step", runId, ts: Date.now(), step, decision });
      markSubtasksDone((decision as any).markSubtasksDone, "agent");
      markSubtasksDone(inferAutoCompletedSubtasks(goalSpec, snapshot, visionNotes, completedSubtasks), "pre_guard");

      emit({
        type: "progress",
        runId,
        ts: Date.now(),
        step,
        activeSubtaskId: (decision as any).activeSubtaskId ?? null,
        activeSubtaskTitle: getSubtaskTitle(goalSpec, (decision as any).activeSubtaskId ?? null),
        completedSubtasks: [...completedSubtasks],
        stalePageCount,
        helpRound,
        pageKind,
        decisionSource,
        progressNote: (decision as any).progressNote ?? undefined,
        reason: String((decision as any).reason ?? ""),
      });

      emitPhase({
        stage: "executing",
        label: "Vykonavam akciu v UI",
        detail: String((decision as any).progressNote ?? (decision as any).reason ?? "Pokracujem podla aktualneho planu."),
        step,
        pageKind,
        activeSubtaskId: (decision as any).activeSubtaskId ?? null,
        decisionSource,
      });

      if (isBackwardSubtask(pageKind, (decision as any).activeSubtaskId ?? null, goalSpec)) {
        emit({
          type: "log",
          runId,
          ts: Date.now(),
          message: `Blocked backward subtask ${(decision as any).activeSubtaskId ?? "unknown"} on pageKind=${pageKind}. Replanning.`,
        });

        markReplan("backward_subtask_blocked");
        lastDecisionSig = null;
        sameDecisionCount = 0;
        stalePageCount = 0;
        continue;
      }

      const sig = decisionSignature(decision);
      if (sig === lastDecisionSig && stalePageCount > 0) sameDecisionCount++;
      else sameDecisionCount = 0;
      lastDecisionSig = sig;

      if ((decision as any).needHelp) {
        const unappliedDirective = pendingHumanDirective;
        if (unappliedDirective && !helpAppliedOnCurrentState) {
          emit({
            type: "log",
            runId,
            ts: Date.now(),
            message: "Suppressed immediate needHelp because there is unapplied human guidance. Replanning once more.",
          });

          recordAppliedHumanDirective(unappliedDirective, helpApplySig);
          markReplan("pending_human_guidance_replan");
          lastDecisionSig = null;
          sameDecisionCount = 0;
          stalePageCount = 0;
          continue;
        }

        markSubtasksDone(inferAutoCompletedSubtasks(goalSpec, snapshot, visionNotes, completedSubtasks), "need_help_recheck");

        if (isBackwardSubtask(pageKind, (decision as any).activeSubtaskId ?? null, goalSpec)) {
          emit({
            type: "log",
            runId,
            ts: Date.now(),
            message: "needHelp suppressed because current page is already later in the workflow. Replanning.",
          });
          markReplan("need_help_suppressed_later_workflow");
          lastDecisionSig = null;
          sameDecisionCount = 0;
          stalePageCount = 0;
          continue;
        }

        if (
          decisionSource !== "self_heal" &&
          scheduleSelfHeal({
            source: "planner_need_help",
            reason: String((decision as any).helpReason ?? (decision as any).reason ?? "Agent requested help."),
            step,
            pageSig: currentPageSig,
            lastDecisionSig: sig,
          })
        ) {
          lastDecisionSig = null;
          sameDecisionCount = 0;
          stalePageCount = 0;
          continue;
        }

        await requestUserHelp(
          step,
          String((decision as any).helpReason ?? (decision as any).reason ?? "Agent requested help."),
          snapshot,
          visionNotes,
          pageKind,
          (decision as any).activeSubtaskId ?? null,
          sig
        );
        await checkControlPoint(step, pageKind, (decision as any).activeSubtaskId ?? null);
        continue;
      }

      if (sameDecisionCount >= 2) {
        if (
          scheduleSelfHeal({
            source: "same_decision_loop",
            reason: "Loop detected with the same decision on an unchanged page.",
            step,
            pageSig: currentPageSig,
            lastDecisionSig: sig,
          })
        ) {
          lastDecisionSig = null;
          sameDecisionCount = 0;
          stalePageCount = 0;
          continue;
        }

        if (await trySafeFallback(step, snapshot, visionNotes, pageKind, "same_decision_loop")) {
          lastDecisionSig = null;
          sameDecisionCount = 0;
          stalePageCount = 0;
          continue;
        }

        await requestUserHelp(
          step,
          "Loop detected (rovnakÃ© rozhodnutie na nezmenenej strÃ¡nke 3x)",
          snapshot,
          visionNotes,
          pageKind,
          (decision as any).activeSubtaskId ?? null,
          sig
        );
        await checkControlPoint(step, pageKind, (decision as any).activeSubtaskId ?? null);
        continue;
      }

      if (stalePageCount >= 3) {
        if (
          scheduleSelfHeal({
            source: "stale_page",
            reason: "Page state stayed unchanged for too long and the agent is not progressing.",
            step,
            pageSig: currentPageSig,
            lastDecisionSig: sig,
          })
        ) {
          lastDecisionSig = null;
          sameDecisionCount = 0;
          stalePageCount = 0;
          continue;
        }

        if (await trySafeFallback(step, snapshot, visionNotes, pageKind, "stale_page")) {
          lastDecisionSig = null;
          sameDecisionCount = 0;
          stalePageCount = 0;
          continue;
        }

        await requestUserHelp(
          step,
          "DlhÅ¡ie sa niÄ nemenÃ­ na strÃ¡nke a agent nepostupuje Äalej.",
          snapshot,
          visionNotes,
          pageKind,
          (decision as any).activeSubtaskId ?? null,
          sig
        );
        await checkControlPoint(step, pageKind, (decision as any).activeSubtaskId ?? null);
        continue;
      }

      if ((decision as any).done) {
        emit({
          type: "log",
          runId,
          ts: Date.now(),
          message: safeLogMessage(`Agent reported done=true: ${(decision as any).reason ?? "done=true"}`),
        });

        if (latestDeterministicFinalGate?.satisfied && latestVisualFinalVerdict?.verdict !== "contradicted") {
          completed = true;
          successMode = "strict";
          stopReason = (decision as any).reason ?? "done=true";
          if (goalSpec) {
            markSubtasksDone(goalSpec.subtasks.map((x) => x.id), "done_flag");
          }
          finalVerdict = await resolveFinalVerdict(true);
          await screenshotFullPage(runDir, runId, `final.png`);
          break;
        }

        const completionConfirm = goalSpec ? await deriveCompletionCheck({
          task,
          goalSpec,
          snapshot,
          visionNotes,
          completedSubtasks,
          pageKind,
          lastHelp: helpHistory.length ? helpHistory[helpHistory.length - 1] : null,
          onUsage: recordUsage,
        }) : null;
        latestCompletionCheck = completionConfirm;

        const softCompletion = shouldAcceptSoftCompletion({
          step,
          snapshot,
          visionNotes,
          pageKind,
          completionCheck: completionConfirm,
        });

        if (softCompletion.accept && completionConfirm?.done) {
          emit({
            type: "log",
            runId,
            ts: Date.now(),
            message: safeLogMessage(
              `Agent and CompletionCheck both confirm done. Accepting soft success: ${softCompletion.reason}. Evidence: ${JSON.stringify(completionConfirm.evidence)}`
            ),
          });
          completed = true;
          successMode = "llm_soft";
          stopReason = (decision as any).reason ?? "done=true (LLM confirmed)";
          if (goalSpec) {
            markSubtasksDone(goalSpec.subtasks.map((x) => x.id), "llm_confirmed_done");
          }
          finalVerdict = await resolveFinalVerdict(true);
          await screenshotFullPage(runDir, runId, `final.png`);
          break;
        }

        const consensus = recordDoneClaimAndCheckConsensus({
          pageSig: currentPageSig,
          completionDone: Boolean(completionConfirm?.done),
          snapshot,
          visionNotes,
          step,
        });

        if (consensus.accept && completionConfirm?.done) {
          emit({
            type: "log",
            runId,
            ts: Date.now(),
            message: safeLogMessage(
              `Agent and CompletionCheck reached stability consensus. Accepting consensus success: ${consensus.reason}. Evidence: ${JSON.stringify(completionConfirm.evidence)}`
            ),
          });
          completed = true;
          successMode = "llm_soft";
          stopReason = (decision as any).reason ?? `done=true (consensus after ${consensus.count} stable claims)`;
          if (goalSpec) {
            markSubtasksDone(goalSpec.subtasks.map((x) => x.id), "consensus_confirmed_done");
          }
          finalVerdict = await resolveFinalVerdict(true);
          await screenshotFullPage(runDir, runId, `final.png`);
          break;
        }

        const answerAcceptance = tryAcceptAgentAnswer({
          decision,
          snapshot,
          visionNotes,
          pageKind,
          step,
        });

        if (answerAcceptance.accept) {
          emit({
            type: "log",
            runId,
            ts: Date.now(),
            message: safeLogMessage(
              `Agent answer accepted as task completion: ${answerAcceptance.reason}. Answer: ${answerAcceptance.answer}`
            ),
          });
          completed = true;
          successMode = "llm_soft";
          stopReason = `Answer extracted: ${answerAcceptance.answer}`;
          if (goalSpec) {
            markSubtasksDone(goalSpec.subtasks.map((x) => x.id), "answer_extraction_accepted");
          }
          finalVerdict = await resolveFinalVerdict(true);
          await screenshotFullPage(runDir, runId, `final.png`);
          break;
        }

        emit({
          type: "log",
          runId,
          ts: Date.now(),
          message: safeLogMessage(
            `Ignoring done=true because neither deterministic gate nor soft completion policy nor consensus nor answer-extraction confirmed success. Soft: ${softCompletion.reason}. Consensus: ${consensus.reason}. Answer: ${answerAcceptance.reason}`
          ),
        });
      }

      const actions: AgentAction[] =
        Array.isArray((decision as any).actions) && (decision as any).actions.length
          ? (decision as any).actions
          : [
              {
                action: (decision as any).action,
                selector: (decision as any).selector,
                text: (decision as any).text,
                reason: (decision as any).reason,
                mayNavigate: (decision as any).mayNavigate,
                expectedEffect: (decision as any).expectedEffect,
                successSignal: (decision as any).successSignal,
                failureSignal: (decision as any).failureSignal,
                fallbackHint: (decision as any).fallbackHint,
              } as any,
            ];

      const limited = actions.slice(0, 5);

      try {
        let executedSomething = false;
        let recoveryContinue = false;
        let usedHumanDirectiveThisStep = decisionSource === "human_guided";

        const directiveUsedThisStep = pendingHumanDirective;
        if (usedHumanDirectiveThisStep && directiveUsedThisStep && helpApplySig) {
          humanGuidedStepCount++;
          recordAppliedHumanDirective(directiveUsedThisStep, helpApplySig);
        }

        const verifyExecutedAction = async (executedAction: AgentAction, forceVisionReason?: string) => {
          const beforeSnapshot = snapshot;
          const beforeVisionNotes = visionNotes;
          const beforePageKind = pageKind;
          await afterActionStabilize();
          const observed = await observeAfterAction(step, forceVisionReason, snapshot);
          const verification = verifyActionOutcome({
            action: executedAction,
            beforeSnapshot,
            beforeVisionNotes,
            afterSnapshot: observed.snapshot,
            afterVisionNotes: observed.visionNotes,
            beforePageKind,
            afterPageKind: observed.pageKind,
          });

          actionVerifications.push({
            step,
            action: executedAction,
            verification,
          });
          emit({
            type: "log",
            runId,
            ts: Date.now(),
            message: safeLogMessage(`ActionOutcome[${verification.outcome}]: ${verification.reason}`),
          });

          snapshot = observed.snapshot;
          visionNotes = observed.visionNotes;
          pageKind = observed.pageKind;

          if (verification.outcome === "failed") {
            recordRecoveryTransition("post_action_verification", step, verification.reason, {
              action: executedAction,
              pageKind,
            });
            const observedPageSig = pageSignature(snapshot, visionNotes);
            if (
              scheduleSelfHeal({
                source: "failed_expected_effect",
                reason: verification.reason,
                step,
                pageSig: observedPageSig,
                lastDecisionSig: actionSignature(executedAction),
              })
            ) {
              lastDecisionSig = null;
              sameDecisionCount = 0;
              stalePageCount = 0;
              recoveryContinue = true;
            } else if (await trySafeFallback(step, snapshot, visionNotes, pageKind, "failed_expected_effect")) {
              lastDecisionSig = null;
              sameDecisionCount = 0;
              stalePageCount = 0;
              recoveryContinue = true;
            }
          }

          return verification;
        };

        for (let i = 0; i < limited.length; i++) {
          await checkControlPoint(step, pageKind, (decision as any).activeSubtaskId ?? null);

          let a: any = synthesizeActionMetadata(limited[i], snapshot, visionNotes);
          const isLast = i === limited.length - 1;
          const normalizedAction = normalizeActionAgainstSnapshot(a, snapshot);
          for (const logLine of normalizedAction.logs) {
            emit({ type: "log", runId, ts: Date.now(), message: logLine });
          }
          if (normalizedAction.errors.length) {
            emit({
              type: "log",
              runId,
              ts: Date.now(),
              message: safeLogMessage(`Selector safety rejected action: ${normalizedAction.errors.join(" | ")}`),
            });
            recordRecoveryTransition("selector_safety", step, normalizedAction.errors.join(" | "), {
              action: a,
              pageKind,
            });
            if (
              scheduleSelfHeal({
                source: "selector_missing",
                reason: normalizedAction.errors.join(" | "),
                step,
                pageSig: currentPageSig,
                lastDecisionSig: actionSignature(a),
              })
            ) {
              lastDecisionSig = null;
              sameDecisionCount = 0;
              stalePageCount = 0;
              recoveryContinue = true;
              break;
            }

            if (await trySafeFallback(step, snapshot, visionNotes, pageKind, "selector_safety")) {
              lastDecisionSig = null;
              sameDecisionCount = 0;
              stalePageCount = 0;
              recoveryContinue = true;
              break;
            }

            recoveryContinue = true;
            break;
          }
          a = normalizedAction.action;
          const aSig = actionSignature(a);

          emit({
            type: "log",
            runId,
            ts: Date.now(),
            message: safeLogMessage(`SubAction ${i + 1}/${limited.length}: ${JSON.stringify(a)}`),
          });

          const sameRecentCount = recentActionSigs.filter((x) => x === aSig).length;
          if (sameRecentCount >= 2 && stalePageCount > 0) {
            if (
              scheduleSelfHeal({
                source: "same_decision_loop",
                reason: "Agent keeps attempting the same action without progress.",
                step,
                pageSig: currentPageSig,
                lastDecisionSig: aSig,
              })
            ) {
              lastDecisionSig = null;
              sameDecisionCount = 0;
              stalePageCount = 0;
              executedSomething = false;
              break;
            }

            if (await trySafeFallback(step, snapshot, visionNotes, pageKind, "same_action_without_progress")) {
              lastDecisionSig = null;
              sameDecisionCount = 0;
              stalePageCount = 0;
              recoveryContinue = true;
              break;
            }

            await requestUserHelp(
              step,
              "Agent sa opakovane snaÅ¾Ã­ urobiÅ¥ rovnakÃº akciu bez postupu.",
              snapshot,
              visionNotes,
              pageKind,
              (decision as any).activeSubtaskId ?? null,
              aSig
            );
            await checkControlPoint(step, pageKind, (decision as any).activeSubtaskId ?? null);
            executedSomething = false;
            break;
          }

          if ((a.action === "type" || a.action === "click" || a.action === "wait") && a.selector) {
            const selNorm = normalizeCssSelector(String(a.selector));
            if (!selectorInSnapshot(snapshot, selNorm)) {
              const recoverySnapshot = await getSnapshotTool.execute({ context: { mode: "recovery" } } as any);
              if (selectorInSnapshot(recoverySnapshot, selNorm)) {
                snapshot = recoverySnapshot;
                visionNotes = null;
              } else {
                emit({
                  type: "log",
                  runId,
                  ts: Date.now(),
                  message: safeLogMessage(`Selector not in current snapshot -> replan: ${selNorm}`),
                });

                markSubtasksDone(inferAutoCompletedSubtasks(goalSpec, snapshot, visionNotes, completedSubtasks), "selector_missing_replan");
                markReplan("selector_missing");
                scheduleSelfHeal({
                  source: "selector_missing",
                  reason: `Expected selector is no longer present: ${selNorm}`,
                  step,
                  pageSig: currentPageSig,
                  lastDecisionSig: aSig,
                });
                lastDecisionSig = null;
                sameDecisionCount = 0;
                stalePageCount = 0;
                executedSomething = false;
                break;
              }
            }
          }

          if (a.action === "clickByText" && a.text != null) {
            if (!textInSnapshot(snapshot, String(a.text))) {
              const recoverySnapshot = await getSnapshotTool.execute({ context: { mode: "recovery" } } as any);
              if (textInSnapshot(recoverySnapshot, String(a.text))) {
                snapshot = recoverySnapshot;
                visionNotes = null;
              } else {
                emit({
                  type: "log",
                  runId,
                  ts: Date.now(),
                  message: safeLogMessage(`clickByText text missing in snapshot -> replan: ${String(a.text)}`),
                });
                markReplan("click_text_missing");
                scheduleSelfHeal({
                  source: "click_text_missing",
                  reason: `Expected button/text is no longer visible: ${String(a.text)}`,
                  step,
                  pageSig: currentPageSig,
                  lastDecisionSig: aSig,
                });
                lastDecisionSig = null;
                sameDecisionCount = 0;
                stalePageCount = 0;
                executedSomething = false;
                break;
              }
            }
          }

          if (a.action === "type") {
            if (!a.selector || a.text == null) throw new Error("type requires selector+text");
            const selector = normalizeCssSelector(String(a.selector));
            const typedPlan = planDynamicTypeInput(snapshot, selector, String(a.text));
            const textToType = typedPlan.textToType || String(a.text);

            if (typedPlan.prefixApplied) {
              emit({
                type: "log",
                runId,
                ts: Date.now(),
                message: safeLogMessage(
                  `Dynamic input adaptation: typing prefix "${textToType}" first instead of full value "${typedPlan.originalText}".`
                ),
              });
            }

            await tools.typeTool.execute({
              context: {
                selector,
                text: textToType,
                clear: true,
                allowSubstringMatch: typedPlan.allowSubstringMatch,
              },
            } as any);
            pushRecent(recentActionSigs, actionSignature({ ...a, text: textToType }));
            executedSomething = true;
            await miniStabilize(typedPlan.waitMs);

            if (typedPlan.shouldRefresh) {
              snapshot = await getSnapshotTool.execute({ context: { mode: "recovery" } } as any);
              visionNotes = null;

              const suggestion = typedPlan.likelyDynamic
                ? findDynamicSuggestionCandidate(snapshot, typedPlan.originalText, textToType, selector)
                : null;

              let suggestionClicked = false;

              if (suggestion?.selector) {
                emit({
                  type: "log",
                  runId,
                  ts: Date.now(),
                  message: safeLogMessage(`Dynamic suggestion matched in DOM after typing: ${suggestion.text}`),
                });
                try {
                  await tools.clickTool.execute({ context: { selector: normalizeCssSelector(suggestion.selector) } } as any);
                  suggestionClicked = true;
                } catch {
                  emit({ type: "log", runId, ts: Date.now(), message: `DOM click on suggestion failed, trying clickByText.` });
                }
              }

              if (!suggestionClicked && typedPlan.likelyDynamic) {
                const dropdownOpen = snapshot?.pageMeta?.dropdownOpen ||
                  (Array.isArray(snapshot?.clickables) && snapshot.clickables.some((c: any) =>
                    String(c?.role ?? "").toLowerCase() === "option"
                  ));

                if (dropdownOpen || suggestion) {
                  const textToClick = suggestion?.text ?? typedPlan.originalText;
                  emit({
                    type: "log",
                    runId,
                    ts: Date.now(),
                    message: safeLogMessage(`Trying clickByText("${textToClick}") for autocomplete suggestion.`),
                  });
                  try {
                    await tools.clickByTextTool.execute({
                      context: { text: textToClick, exact: false },
                    } as any);
                    suggestionClicked = true;
                  } catch {
                    emit({ type: "log", runId, ts: Date.now(), message: `clickByText for suggestion also failed.` });
                  }
                }
              }

              if (!suggestionClicked && typedPlan.likelyDynamic) {
                const visionAfterType = await runVisionIfNeeded({
                  snapshot,
                  pageKind: detectPageKind(snapshot, null),
                  step,
                  forceReason: "autocomplete_suggestion_check",
                });
                const inputItem = findSnapshotItemBySelector(snapshot, selector);
                if (inputItem?.bbox && inputItem.bbox.y > 0) {
                  const clickX = Math.round(inputItem.bbox.x + inputItem.bbox.width / 2);
                  const clickY = Math.round(inputItem.bbox.y + inputItem.bbox.height + 30);
                  emit({
                    type: "log",
                    runId,
                    ts: Date.now(),
                    message: `Trying clickAtPoint(${clickX}, ${clickY}) for first autocomplete suggestion below input.`,
                  });
                  try {
                    await tools.clickAtPointTool.execute({
                      context: { x: clickX, y: clickY, description: "First autocomplete suggestion" },
                    } as any);
                    suggestionClicked = true;
                  } catch (e: any) {
                    emit({ type: "log", runId, ts: Date.now(), message: safeLogMessage(`clickAtPoint fallback failed: ${e?.message}`) });
                  }
                }
              }

              if (suggestionClicked) {
                pushRecent(
                  recentActionSigs,
                  actionSignature({ action: "click", selector: suggestion?.selector ?? null, text: suggestion?.text ?? typedPlan.originalText, mayNavigate: false })
                );
                await miniStabilize(250);
                snapshot = await getSnapshotTool.execute({ context: { mode: "recovery" } } as any);
                visionNotes = null;
              }

              if (!isLast) {
                emit({
                  type: "log",
                  runId,
                  ts: Date.now(),
                  message: "Batch interrupted early after dynamic type step to re-ground on refreshed suggestions/state.",
                });
                await verifyExecutedAction({ ...a, text: textToType }, "uncertain_page_state");
                break;
              }
            }

            await verifyExecutedAction({ ...a, text: textToType }, typedPlan.shouldRefresh ? "uncertain_page_state" : undefined);
            if (recoveryContinue) break;
            continue;
          }

          if (a.action === "click") {
            if (!a.selector) throw new Error("click requires selector");
            const sel = normalizeCssSelector(String(a.selector).trim());
            let clickSucceeded = false;

            if (looksLikeCssSelector(sel)) {
              try {
                await tools.clickTool.execute({ context: { selector: sel } } as any);
                clickSucceeded = true;
              } catch (clickErr: any) {
                const fallbackText = String(a.text ?? "").trim();
                if (fallbackText) {
                  emit({
                    type: "log",
                    runId,
                    ts: Date.now(),
                    message: safeLogMessage(`Click selector "${sel}" failed. Trying clickByText("${fallbackText}") as fallback.`),
                  });
                  try {
                    await tools.clickByTextTool.execute({ context: { text: fallbackText, exact: false } } as any);
                    clickSucceeded = true;
                  } catch {
                    throw clickErr;
                  }
                } else {
                  throw clickErr;
                }
              }
            } else {
              await tools.clickByTextTool.execute({ context: { text: sel, exact: shouldClickByTextExact(sel) } } as any);
              clickSucceeded = true;
            }

            if (clickSucceeded) {
              pushRecent(recentActionSigs, aSig);
              executedSomething = true;
              await miniStabilize();
              await verifyExecutedAction(a, visionSeesOverlay ? "blocker_or_overlay" : undefined);
              if (recoveryContinue) break;

              const mayNavigateFlag = a.mayNavigate;
              const fallbackNonNav = isNonNavigationalClickFallback(sel);
              const isNonNav = mayNavigateFlag === false ? true : mayNavigateFlag === true ? false : fallbackNonNav;

              if (!isLast && !isNonNav) {
                emit({
                  type: "log",
                  runId,
                  ts: Date.now(),
                  message: "Batch interrupted early: click action was not last (safety).",
                });
                break;
              }

              if (!isLast && isNonNav) {
                continue;
              }
            }

            break;
          }

          if (a.action === "clickByText") {
            if (a.text == null) throw new Error("clickByText requires text");
            const txt = String(a.text);

            await tools.clickByTextTool.execute({ context: { text: txt, exact: shouldClickByTextExact(txt) } } as any);
            pushRecent(recentActionSigs, aSig);
            executedSomething = true;
            await miniStabilize();
            await verifyExecutedAction(a, visionSeesOverlay ? "blocker_or_overlay" : undefined);
            if (recoveryContinue) break;

            const mayNavigateFlag = a.mayNavigate;
            const fallbackNonNav = isNonNavigationalClickFallback(txt);
            const isNonNav = mayNavigateFlag === false ? true : mayNavigateFlag === true ? false : fallbackNonNav;

            if (!isLast && !isNonNav) {
              emit({
                type: "log",
                runId,
                ts: Date.now(),
                message: "Batch interrupted early: clickByText was not last (safety).",
              });
              break;
            }

            if (!isLast && isNonNav) {
              continue;
            }

            break;
          }

          if (a.action === "wait") {
            if (!a.selector) throw new Error("wait requires selector");
            const selector = normalizeCssSelector(String(a.selector));
            await tools.waitForTool.execute({ context: { selector, timeoutMs: 4000, state: "attached" } } as any);
            pushRecent(recentActionSigs, aSig);
            executedSomething = true;
            await miniStabilize();
            await verifyExecutedAction(a, "uncertain_page_state");
            if (recoveryContinue) break;
            continue;
          }

          if (a.action === "scroll") {
            await tools.scrollTool.execute({ context: { direction: "down", amount: 800 } } as any);
            pushRecent(recentActionSigs, aSig);
            executedSomething = true;
            await miniStabilize();
            await verifyExecutedAction(a, "uncertain_page_state");
            if (recoveryContinue) break;
            continue;
          }

          if (a.action === "pressKey") {
            const key = String(a.text ?? a.selector ?? "Enter");
            await tools.pressKeyTool.execute({ context: { key } } as any);
            pushRecent(recentActionSigs, aSig);
            executedSomething = true;
            await miniStabilize(300);
            await verifyExecutedAction(a, "uncertain_page_state");
            if (recoveryContinue) break;
            continue;
          }

          if (a.action === "none") break;

          throw new Error(`Unknown action: ${a.action}`);
        }

        if (recoveryContinue) {
          continue;
        }

        if (!executedSomething) {
          emit({
            type: "log",
            runId,
            ts: Date.now(),
            message: "No action executed from current decision. Replanning from fresh state.",
          });

          if (!allowHumanHelp) {
            throw new Error("Agent did not execute anything useful and human help is disabled.");
          }

          markReplan("no_action_executed");
          const scheduledSelfHeal = scheduleSelfHeal({
            source: "no_action_executed",
            reason: "Planner produced no executable action after re-evaluating the page.",
            step,
            pageSig: currentPageSig,
            lastDecisionSig,
          });
          if (!scheduledSelfHeal) {
            if (await trySafeFallback(step, snapshot, visionNotes, pageKind, "no_action_executed")) {
              continue;
            }
            await requestUserHelp(
              step,
              "Agent nenaÅ¡iel vykonateÄ¾nÃº ÄalÅ¡iu akciu ani po opÃ¤tovnom vyhodnotenÃ­ strÃ¡nky.",
              snapshot,
              visionNotes,
              pageKind,
              (decision as any).activeSubtaskId ?? null,
              lastDecisionSig ?? undefined
            );
            await checkControlPoint(step, pageKind, (decision as any).activeSubtaskId ?? null);
          }
          continue;
        }

        if (usedHumanDirectiveThisStep) {
          emit({
            type: "log",
            runId,
            ts: Date.now(),
            message: "Human directive was executed. Clearing pending directive and continuing normally.",
          });
          pendingHumanDirective = null;
        }
      } catch (e: any) {
        const msg = safeLogMessage(e?.message ?? String(e), 900);

        if (lastCookieDismissAttemptedAtStep === step) {
          cookieDismissFailures += 1;
          emit({
            type: "log",
            runId,
            ts: Date.now(),
            message: safeLogMessage(
              `Cookie dismiss attempt failed (${cookieDismissFailures}/${COOKIE_DISMISS_MAX_FAILURES}): ${msg}`
            ),
          });
        }

        if (pendingHumanDirective) {
          emit({
            type: "log",
            runId,
            ts: Date.now(),
            message: safeLogMessage(`Execution failed after human guidance: ${msg}`),
          });
        }

        if (
          scheduleSelfHeal({
            source: "execution_error",
            reason: "Execution of the chosen UI action failed.",
            step,
            pageSig: currentPageSig,
            lastDecisionSig,
            lastError: msg,
          })
        ) {
          lastDecisionSig = null;
          sameDecisionCount = 0;
          stalePageCount = 0;
          continue;
        }

        if (await trySafeFallback(step, snapshot, visionNotes, pageKind, "execution_error")) {
          lastDecisionSig = null;
          sameDecisionCount = 0;
          stalePageCount = 0;
          continue;
        }

        await requestUserHelp(
          step,
          "Execution error poÄas vykonÃ¡vania akciÃ­",
          snapshot,
          visionNotes,
          pageKind,
          (decision as any).activeSubtaskId ?? null,
          lastDecisionSig ?? undefined,
          msg
        );
        await checkControlPoint(step, pageKind, (decision as any).activeSubtaskId ?? null);
        continue;
      }

      stepTrace.push({
        step,
        activeSubtaskId: (decision as any).activeSubtaskId ?? null,
        completedSubtasks: [...completedSubtasks],
        stalePageCount,
        pageKind,
        decisionSource,
        pendingHumanDirective: pendingHumanDirective
          ? {
              text: pendingHumanDirective.text,
              appliedCount: pendingHumanDirective.appliedCount,
            }
          : null,
        decision,
      });

      await checkControlPoint(step, pageKind, (decision as any).activeSubtaskId ?? null);
      await afterActionStabilize();
      await checkControlPoint(step, pageKind, (decision as any).activeSubtaskId ?? null);
      await screenshotFullPage(runDir, runId, `step-${String(step + 1).padStart(3, "0")}.png`);
    }

    if (!completed && !stopReason) {
      stopReason = "maxSteps reached without done=true";
      await screenshotFullPage(runDir, runId, `final.png`).catch(() => {});
    }

    finalVerdict = await resolveFinalVerdict(completed);

    emitPhase({
      stage: "finished",
      label: completed ? "Uloha je splnena" : "Beh sa zastavil",
      detail: finalVerdict,
      verdict: finalVerdict,
    });

    await writeSummary(completed, completed ? undefined : safeLogMessage(`Not completed. Reason: ${stopReason}`, 900));

    emit({
      type: "run_finished",
      runId,
      ts: Date.now(),
      success: completed,
      successMode: successMode ?? undefined,
      reason: stopReason,
      verdict: finalVerdict || undefined,
      error: completed ? undefined : safeLogMessage(`Not completed. Reason: ${stopReason}`, 900),
    });
  } catch (e: any) {
    const control = getRunControl(runId);

    let success = false;
    let error = safeLogMessage(e?.message ?? String(e), 900);

    if (e instanceof RunControlInterrupt) {
      success = e.success;
      completed = e.success;
      stopReason = e.message;
      error = e.success ? "" : e.message;
      if (e.success) successMode = "user_forced";

      emit({
        type: "log",
        runId,
        ts: Date.now(),
        message: `Run interrupted by user control: ${e.kind} (${e.message})`,
      });
    } else if (control?.state === "finish_requested") {
      success = true;
      completed = true;
      stopReason = control.reason ?? "finished_by_user";
      error = "";
      successMode = "user_forced";

      emit({
        type: "log",
        runId,
        ts: Date.now(),
        message: `Run finished by user control: ${stopReason}`,
      });
    } else if (control?.state === "terminate_requested") {
      success = false;
      completed = false;
      stopReason = control.reason ?? "terminated_by_user";
      error = stopReason;

      emit({
        type: "log",
        runId,
        ts: Date.now(),
        message: `Run terminated by user control: ${stopReason}`,
      });
    }

    await screenshotFullPage(runDir, runId, `final.png`).catch(() => {});
    finalVerdict = await resolveFinalVerdict(success);
    await writeSummary(success, success ? undefined : error);

    emitPhase({
      stage: "finished",
      label: success ? "Beh je ukonceny" : "Beh skoncil chybou",
      detail: finalVerdict,
      verdict: finalVerdict,
    });

    emit({
      type: "run_finished",
      runId,
      ts: Date.now(),
      success,
      successMode: successMode ?? undefined,
      reason: stopReason || undefined,
      verdict: finalVerdict || undefined,
      error: success ? undefined : error,
    });
  } finally {
    cancelPendingForRun(runId);
    markRunFinished(runId);
  }
}
