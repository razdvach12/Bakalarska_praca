import type {
  AgentAction,
  DeterministicFinalGate,
  EffectVerificationResult,
  FinalRequirement,
  GoalSpec,
  InformationAnswerAssessment,
  VisionNotes,
} from "../types";
import type { PageKind } from "./shared";
import { findSnapshotItemBySelector, getInputSemanticHaystack } from "./actions";
import { buildBlockerAssessment, actionTargetsBlocker } from "./blockers";
import { detectPageKind, isAuthenticatedish, pageSignature, snapshotSurfaceText } from "./pageState";
import { includesAny, normText } from "./shared";

const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_REGEX = /(?:\+\d{1,3}[\s-]?)?(?:\d[\s-]?){7,14}\d/g;
const INFO_TASK_WORDS = [
  "email",
  "e-mail",
  "mail",
  "phone",
  "telefon",
  "tel.",
  "contact",
  "support",
  "kontakt",
  "podpora",
  "price",
  "status",
  "answer",
  "visible",
  "find",
  "extract",
];
const ERROR_WORDS = ["error", "invalid", "failed", "problem", "warning", "required", "incorrect", "forbidden"];

function uniqueMatches(regex: RegExp, text: string) {
  return [...new Set((text.match(regex) ?? []).map((value) => value.trim()))];
}

function hasCurrencyLikeText(text: string) {
  return /€|\$|£|\bczk\b|\beur\b|\busd\b|\bprice\b|\bcena\b/i.test(text);
}

function getTaskKeywords(task: string) {
  return normText(task)
    .split(/[^a-z0-9@€$£]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !["visible", "find", "page", "please", "support"].includes(token))
    .slice(0, 10);
}

function extractRelevantSnippet(text: string, keywords: string[]) {
  const source = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!source) return "";
  const lowered = source.toLowerCase();

  for (const keyword of keywords) {
    const idx = lowered.indexOf(keyword.toLowerCase());
    if (idx >= 0) {
      return source.slice(Math.max(0, idx - 80), Math.min(source.length, idx + 180)).trim();
    }
  }

  return source.slice(0, 180).trim();
}

function findInputByLabel(snapshot: any, label: string) {
  const target = normText(label);
  if (!target) return null;

  const inputs: any[] = Array.isArray(snapshot?.inputs) ? snapshot.inputs : [];
  for (const input of inputs) {
    const hay = normText(getInputSemanticHaystack(input));
    if (hay.includes(target)) return input;
  }

  return null;
}

function evaluateFinalRequirement(args: {
  requirement: FinalRequirement;
  snapshot: any;
  visionNotes: VisionNotes | null;
  pageKind: PageKind;
  answerAssessment: InformationAnswerAssessment | null;
  emails: string[];
  phones: string[];
  blockerPresent: boolean;
}) {
  const surface = snapshotSurfaceText(args.snapshot, args.visionNotes);
  const normalizedSurface = normText(surface);
  const url = normText(String(args.snapshot?.url ?? ""));
  const cartBadge = Number(args.snapshot?.cartBadge ?? 0);
  const hasCart = (Number.isFinite(cartBadge) && cartBadge > 0) || includesAny(surface, ["remove", "cart", "basket", "kosik"]);
  const productText =
    args.requirement.kind === "cart_contains_product" || args.requirement.kind === "cart_not_contains_product"
      ? String(args.requirement.product ?? "")
      : "";

  switch (args.requirement.kind) {
    case "text_visible":
      return normalizedSurface.includes(normText(args.requirement.text));
    case "text_absent":
      return !normalizedSurface.includes(normText(args.requirement.text));
    case "url_contains":
      return url.includes(normText(args.requirement.text));
    case "page_kind_is":
      return args.pageKind === args.requirement.pageKind;
    case "field_equals": {
      const expected = normText(args.requirement.value);
      if (!expected) return false;
      const inputs: any[] = Array.isArray(args.snapshot?.inputs) ? args.snapshot.inputs : [];
      const valueMatch = inputs.some((input) => {
        const value = normText(String(input?.value ?? ""));
        if (!value) return false;
        return value === expected || value.includes(expected) || expected.includes(value);
      });
      if (valueMatch) return true;
      const input = findInputByLabel(args.snapshot, args.requirement.label);
      return normText(String(input?.value ?? "")) === expected;
    }
    case "field_filled": {
      const input = findInputByLabel(args.snapshot, args.requirement.label);
      return Boolean(String(input?.value ?? "").trim());
    }
    case "answer_visible":
      return Boolean(args.answerAssessment?.answerVisible);
    case "answer_contains_email":
      return args.emails.length > 0;
    case "answer_contains_phone":
      return args.phones.length > 0;
    case "cart_contains_product":
      return productText ? hasCart && normalizedSurface.includes(normText(productText)) : hasCart;
    case "cart_not_contains_product":
      return productText ? !normalizedSurface.includes(normText(productText)) : !hasCart;
    case "overlay_absent":
      return !args.blockerPresent;
    case "confirmation_visible":
      return (
        args.pageKind === "checkout_complete" ||
        includesAny(surface, ["thank you", "success", "confirmed", "submitted", "done", "order"]) ||
        (args.requirement.text ? normalizedSurface.includes(normText(args.requirement.text)) : false)
      );
    case "login_form_absent":
      return isAuthenticatedish(args.snapshot, args.visionNotes) || !includesAny(surface, ["username", "password", "login", "sign in", "log in"]);
    case "error_absent":
      return !args.visionNotes?.error?.present && !includesAny(surface, ERROR_WORDS);
    default:
      return false;
  }
}

function inferFallbackFinalRequirements(task: string, goalSpec: GoalSpec | null): FinalRequirement[] {
  if (goalSpec?.finalRequirements?.length) return goalSpec.finalRequirements;

  const taskText = normText(task);
  const requirements: FinalRequirement[] = [];

  if (includesAny(taskText, ["email", "e-mail", "mail"])) requirements.push({ kind: "answer_contains_email" });
  if (includesAny(taskText, ["phone", "telefon", "tel."])) requirements.push({ kind: "answer_contains_phone" });
  if (includesAny(taskText, ["contact", "support", "kontakt", "podpora"])) requirements.push({ kind: "answer_visible" });
  if (includesAny(taskText, ["add to cart", "basket", "kosik"])) requirements.push({ kind: "cart_contains_product" });
  if (includesAny(taskText, ["open cart", "view cart", "your cart"])) requirements.push({ kind: "page_kind_is", pageKind: "cart" });
  if (includesAny(taskText, ["login", "log in", "sign in"])) requirements.push({ kind: "login_form_absent" });
  if (includesAny(taskText, ["form", "fill", "vypln"])) requirements.push({ kind: "error_absent" });

  return requirements.slice(0, 8);
}

// TOTO ZHODNOTI CI JE NA STRANKE INFORMACNA ODPOVED
export function assessInformationAnswer(args: {
  task: string;
  goalSpec: GoalSpec | null;
  snapshot: any;
  visionNotes: VisionNotes | null;
}): InformationAnswerAssessment | null {
  const taskText = `${args.task} ${args.goalSpec?.goal ?? ""}`.trim();
  const infoLike =
    includesAny(taskText, INFO_TASK_WORDS) ||
    Boolean(args.goalSpec?.finalRequirements?.some((requirement) =>
      ["answer_visible", "answer_contains_email", "answer_contains_phone"].includes(requirement.kind)
    ));

  if (!infoLike) return null;

  const surface = snapshotSurfaceText(args.snapshot, args.visionNotes);
  const emails = uniqueMatches(EMAIL_REGEX, surface);
  const phones = uniqueMatches(PHONE_REGEX, surface).filter((value) => value.replace(/\D/g, "").length >= 7);
  const keywords = getTaskKeywords(taskText);
  const pageSignals = `${args.snapshot?.url ?? ""} ${args.snapshot?.title ?? ""} ${surface}`;
  const pageRelevant =
    emails.length > 0 ||
    phones.length > 0 ||
    keywords.some((keyword) => normText(pageSignals).includes(normText(keyword))) ||
    includesAny(pageSignals, ["contact", "support", "kontakt", "podpora"]);

  if (emails.length > 0 && includesAny(taskText, ["email", "mail", "contact", "support", "kontakt"])) {
    return {
      pageRelevant: true,
      answerVisible: true,
      answer: emails[0],
      evidence: [`Visible email found: ${emails[0]}`],
      missing: [],
      confidence: "high",
    };
  }

  if (phones.length > 0 && includesAny(taskText, ["phone", "telefon", "contact", "support", "kontakt"])) {
    return {
      pageRelevant: true,
      answerVisible: true,
      answer: phones[0],
      evidence: [`Visible phone found: ${phones[0]}`],
      missing: [],
      confidence: "high",
    };
  }

  const snippet = extractRelevantSnippet(surface, keywords);
  const overlap = keywords.filter((keyword) => normText(snippet).includes(normText(keyword))).length;
  const answerVisible =
    overlap >= 2 &&
    (hasCurrencyLikeText(snippet) ||
      includesAny(snippet, ["contact", "support", "opening", "hours", "status", "price", "cena", "answer"]));

  return {
    pageRelevant,
    answerVisible,
    answer: answerVisible ? snippet : "",
    evidence: answerVisible ? [`Relevant visible snippet found: ${snippet}`] : [],
    missing: answerVisible ? [] : ["No high-confidence visible answer detected on the current page."],
    confidence: answerVisible ? "medium" : "low",
  };
}

export function describeFinalRequirement(requirement: FinalRequirement) {
  switch (requirement.kind) {
    case "text_visible":
      return `text_visible("${requirement.text}")`;
    case "text_absent":
      return `text_absent("${requirement.text}")`;
    case "url_contains":
      return `url_contains("${requirement.text}")`;
    case "page_kind_is":
      return `page_kind_is(${requirement.pageKind})`;
    case "field_equals":
      return `field_equals(${requirement.label}="${requirement.value}")`;
    case "field_filled":
      return `field_filled(${requirement.label})`;
    case "answer_visible":
      return "answer_visible";
    case "answer_contains_email":
      return "answer_contains_email";
    case "answer_contains_phone":
      return "answer_contains_phone";
    case "cart_contains_product":
      return `cart_contains_product(${requirement.product ?? "*"})`;
    case "cart_not_contains_product":
      return `cart_not_contains_product(${requirement.product ?? "*"})`;
    case "overlay_absent":
      return "overlay_absent";
    case "confirmation_visible":
      return requirement.text ? `confirmation_visible("${requirement.text}")` : "confirmation_visible";
    case "login_form_absent":
      return "login_form_absent";
    case "error_absent":
      return "error_absent";
    default:
      return "final_requirement";
  }
}

// TOTO POSTAVI DETERMINISTICKU KONTROLU SPLNENIA ULOHY
export function buildDeterministicFinalGate(args: {
  task: string;
  goalSpec: GoalSpec | null;
  snapshot: any;
  visionNotes: VisionNotes | null;
  pageKind?: PageKind;
}): DeterministicFinalGate {
  const finalRequirements = inferFallbackFinalRequirements(args.task, args.goalSpec);
  const pageKind = args.pageKind ?? detectPageKind(args.snapshot, args.visionNotes);
  const answerAssessment = assessInformationAnswer(args);
  const surface = snapshotSurfaceText(args.snapshot, args.visionNotes);
  const emails = uniqueMatches(EMAIL_REGEX, surface);
  const phones = uniqueMatches(PHONE_REGEX, surface).filter((value) => value.replace(/\D/g, "").length >= 7);
  const blocker = buildBlockerAssessment(args.snapshot, args.visionNotes);
  const fulfilled: string[] = [];
  const missing: string[] = [];
  const evidence: string[] = [];

  if (!finalRequirements.length && answerAssessment?.answerVisible) {
    return {
      satisfied: true,
      finalRequirements: [],
      fulfilled: ["answer_visible (fallback)"],
      missing: [],
      evidence: [...answerAssessment.evidence],
      answerAssessment,
    };
  }

  for (const requirement of finalRequirements) {
    const ok = evaluateFinalRequirement({
      requirement,
      snapshot: args.snapshot,
      visionNotes: args.visionNotes,
      pageKind,
      answerAssessment,
      emails,
      phones,
      blockerPresent: blocker.present,
    });
    const label = describeFinalRequirement(requirement);
    if (ok) {
      fulfilled.push(label);
      evidence.push(`Satisfied: ${label}`);
    } else {
      missing.push(label);
    }
  }

  if (answerAssessment?.evidence?.length) {
    evidence.push(...answerAssessment.evidence);
  }

  return {
    satisfied: finalRequirements.length > 0 && missing.length === 0,
    finalRequirements,
    fulfilled,
    missing,
    evidence: [...new Set(evidence)].slice(0, 12),
    answerAssessment,
  };
}

function signalMatches(surface: string, signal?: string) {
  const target = normText(signal ?? "");
  if (!target) return false;
  const normalized = normText(surface);
  if (normalized.includes(target)) return true;
  const tokens = target.split(" ").filter((token) => token.length >= 4);
  return tokens.length >= 2 && tokens.every((token) => normalized.includes(token));
}

// TOTO DOPLNI METAOPIS K AKCII
export function synthesizeActionMetadata(action: AgentAction, snapshot: any, visionNotes: VisionNotes | null) {
  const item = action.selector ? findSnapshotItemBySelector(snapshot, action.selector) : null;
  const label = String(action.text ?? item?.label ?? item?.ariaLabel ?? item?.placeholder ?? action.selector ?? action.action).trim();
  const blocker = buildBlockerAssessment(snapshot, visionNotes);
  const blockerTarget = actionTargetsBlocker(action, blocker);

  if (action.action === "type") {
    return {
      ...action,
      expectedEffect: action.expectedEffect ?? `The field ${label || "target input"} contains the requested value.`,
      successSignal: action.successSignal ?? `The input value for ${label || "target input"} changed.`,
      failureSignal: action.failureSignal ?? `The input value for ${label || "target input"} stayed unchanged.`,
      fallbackHint: action.fallbackHint ?? "Refresh the snapshot and reassess dynamic suggestions or alternate visible inputs.",
    };
  }

  if ((action.action === "click" || action.action === "clickByText") && blockerTarget) {
    return {
      ...action,
      expectedEffect: action.expectedEffect ?? "The visible blocker disappears or stops blocking the main page.",
      successSignal: action.successSignal ?? "The blocker overlay or its dismiss controls are no longer visible.",
      failureSignal: action.failureSignal ?? "The same blocker remains visible on the same page state.",
      fallbackHint: action.fallbackHint ?? "Try a different visible reject/close control or re-check the blocker with vision.",
    };
  }

  if (action.action === "click" || action.action === "clickByText") {
    return {
      ...action,
      expectedEffect:
        action.expectedEffect ??
        (action.mayNavigate
          ? `The page advances after clicking ${label || "the target control"}.`
          : `The visible UI changes after clicking ${label || "the target control"}.`),
      successSignal:
        action.successSignal ??
        (action.mayNavigate
          ? "A new page state, URL, title, or later workflow stage becomes visible."
          : "The targeted UI state changes or new content becomes visible."),
      failureSignal:
        action.failureSignal ??
        "The same page state remains unchanged and the same clickable control still appears available.",
      fallbackHint: action.fallbackHint ?? "Reobserve the page, then try a safer grounded action or alternate visible target.",
    };
  }

  if (action.action === "wait") {
    return {
      ...action,
      expectedEffect: action.expectedEffect ?? "The awaited selector becomes attached or visible.",
      successSignal: action.successSignal ?? "The awaited selector is present in the refreshed snapshot.",
      failureSignal: action.failureSignal ?? "The awaited selector still does not appear after waiting.",
      fallbackHint: action.fallbackHint ?? "Refresh the page state and choose a different safe action if the awaited element is still missing.",
    };
  }

  if (action.action === "scroll") {
    return {
      ...action,
      expectedEffect: action.expectedEffect ?? "A different part of the current page becomes visible.",
      successSignal: action.successSignal ?? "The visible page content or scroll position changes.",
      failureSignal: action.failureSignal ?? "The visible page state stays effectively unchanged after scrolling.",
      fallbackHint: action.fallbackHint ?? "Try one more short scroll or re-evaluate visible blocker/expand options.",
    };
  }

  return action;
}

// TOTO OVERI VYSLEDOK VYKONANEJ AKCIE
export function verifyActionOutcome(args: {
  action: AgentAction;
  beforeSnapshot: any;
  beforeVisionNotes: VisionNotes | null;
  afterSnapshot: any;
  afterVisionNotes: VisionNotes | null;
  beforePageKind: PageKind;
  afterPageKind: PageKind;
}): EffectVerificationResult {
  const action = synthesizeActionMetadata(args.action, args.beforeSnapshot, args.beforeVisionNotes);
  const beforeSurface = snapshotSurfaceText(args.beforeSnapshot, args.beforeVisionNotes);
  const afterSurface = snapshotSurfaceText(args.afterSnapshot, args.afterVisionNotes);
  const changed = pageSignature(args.beforeSnapshot, args.beforeVisionNotes) !== pageSignature(args.afterSnapshot, args.afterVisionNotes);
  const successMatched = signalMatches(afterSurface, action.successSignal);
  const failureMatched = signalMatches(afterSurface, action.failureSignal);
  const hadExpectation = Boolean(action.expectedEffect || action.successSignal || action.failureSignal);
  const beforeBlocker = buildBlockerAssessment(args.beforeSnapshot, args.beforeVisionNotes);
  const afterBlocker = buildBlockerAssessment(args.afterSnapshot, args.afterVisionNotes);

  if (failureMatched) {
    return {
      changed,
      hadExpectation,
      successMatched,
      failureMatched,
      expectationMissed: false,
      outcome: "failed",
      reason: `Failure signal matched after ${action.action}.`,
    };
  }

  if (action.action === "type") {
    const afterInput = action.selector ? findSnapshotItemBySelector(args.afterSnapshot, action.selector) : null;
    const expectedValue = normText(String(action.text ?? ""));
    const actualValue = normText(String(afterInput?.value ?? ""));
    if (expectedValue && actualValue.includes(expectedValue)) {
      return {
        changed: true,
        hadExpectation,
        successMatched: true,
        failureMatched: false,
        expectationMissed: false,
        outcome: "confirmed",
        reason: "The target input contains the expected value after typing.",
      };
    }

    return {
      changed,
      hadExpectation,
      successMatched,
      failureMatched: false,
      expectationMissed: true,
      outcome: "failed",
      reason: "The target input did not reflect the requested value after typing.",
    };
  }

  if ((action.action === "click" || action.action === "clickByText") && actionTargetsBlocker(action, beforeBlocker)) {
    if (!afterBlocker.present || afterBlocker.evidenceKey !== beforeBlocker.evidenceKey) {
      return {
        changed: true,
        hadExpectation,
        successMatched: true,
        failureMatched: false,
        expectationMissed: false,
        outcome: "confirmed",
        reason: "The blocker evidence changed or disappeared after the blocker action.",
      };
    }

    return {
      changed,
      hadExpectation,
      successMatched,
      failureMatched: false,
      expectationMissed: true,
      outcome: "failed",
      reason: "The same blocker evidence remained after the blocker action.",
    };
  }

  if (action.action === "wait") {
    const selector = String(action.selector ?? "").trim();
    const visibleNow = selector ? Boolean(findSnapshotItemBySelector(args.afterSnapshot, selector)) : false;
    return {
      changed,
      hadExpectation,
      successMatched: successMatched || visibleNow,
      failureMatched: false,
      expectationMissed: !visibleNow && hadExpectation,
      outcome: visibleNow ? "confirmed" : changed ? "unclear" : "failed",
      reason: visibleNow ? "The awaited selector appeared in the refreshed snapshot." : changed ? "The page changed while waiting." : "The awaited selector never appeared.",
    };
  }

  if (action.action === "scroll") {
    const beforeNearBottom = Boolean(args.beforeSnapshot?.pageMeta?.nearBottom);
    const afterNearBottom = Boolean(args.afterSnapshot?.pageMeta?.nearBottom);
    const moved = changed || beforeNearBottom !== afterNearBottom || beforeSurface !== afterSurface;
    return {
      changed: moved,
      hadExpectation,
      successMatched: successMatched || moved,
      failureMatched: false,
      expectationMissed: !moved && hadExpectation,
      outcome: moved ? "confirmed" : "unclear",
      reason: moved ? "Visible page content changed after scrolling." : "Scrolling produced no clear visible change.",
    };
  }

  if (action.action === "click" || action.action === "clickByText") {
    if (successMatched) {
      return {
        changed: true,
        hadExpectation,
        successMatched: true,
        failureMatched: false,
        expectationMissed: false,
        outcome: "confirmed",
        reason: "Success signal matched after clicking.",
      };
    }

    const navigated =
      args.beforePageKind !== args.afterPageKind ||
      normText(String(args.beforeSnapshot?.url ?? "")) !== normText(String(args.afterSnapshot?.url ?? ""));
    if (navigated || changed) {
      return {
        changed: true,
        hadExpectation,
        successMatched,
        failureMatched: false,
        expectationMissed: false,
        outcome: "confirmed",
        reason: navigated ? "The page visibly advanced after clicking." : "The visible page state changed after clicking.",
      };
    }

    return {
      changed: false,
      hadExpectation,
      successMatched: false,
      failureMatched: false,
      expectationMissed: hadExpectation,
      outcome: "failed",
      reason: "The page stayed unchanged after clicking and no success signal appeared.",
    };
  }

  return {
    changed,
    hadExpectation,
    successMatched,
    failureMatched: false,
    expectationMissed: hadExpectation && !changed && !successMatched,
    outcome: changed ? "confirmed" : "unclear",
    reason: changed ? "The visible page state changed." : "No strong post-action signal was detected.",
  };
}

// TOTO ZAVERI USPECH PODLA VIZUALNEHO POROVNANIA
export function deriveVisualFinalVerdict(args: {
  snapshot: any;
  visionNotes: VisionNotes | null;
  finalGate: DeterministicFinalGate | null;
}) {
  const blocker = buildBlockerAssessment(args.snapshot, args.visionNotes);
  const evidence: string[] = [];

  if (!args.finalGate?.satisfied) {
    return {
      verdict: "inconclusive" as const,
      reason: "Deterministic final gate is not yet satisfied.",
      evidence,
    };
  }

  if (args.visionNotes?.error?.present) {
    evidence.push(`Visible error: ${args.visionNotes.error.text ?? "unknown error"}`);
    return {
      verdict: "contradicted" as const,
      reason: "Vision still sees an error banner while deterministic success claims completion.",
      evidence,
    };
  }

  if (args.finalGate.finalRequirements.some((requirement) => requirement.kind === "overlay_absent") && blocker.present) {
    evidence.push(`Visible blocker still present: ${blocker.evidenceKey}`);
    return {
      verdict: "contradicted" as const,
      reason: "A blocker is still visually present although overlay_absent is required.",
      evidence,
    };
  }

  if (args.visionNotes?.page?.type === "confirmation" || args.visionNotes?.page?.type === "cart" || args.finalGate.answerAssessment?.answerVisible) {
    if (args.visionNotes?.page?.type) evidence.push(`Vision page type: ${args.visionNotes.page.type}`);
    if (args.finalGate.answerAssessment?.answerVisible) evidence.push("Visible answer assessment supports success.");
    return {
      verdict: "confirmed" as const,
      reason: "Vision signals support the deterministic success decision.",
      evidence,
    };
  }

  return {
    verdict: "inconclusive" as const,
    reason: "Vision does not contradict deterministic success, but it is not strongly confirmatory either.",
    evidence,
  };
}

// TOTO ZARADI ZLYHANIE DO KATEGORII
export function classifyFailure(args: {
  success: boolean;
  stopReason: string;
  finalGate: DeterministicFinalGate | null;
  blockerEvents: Array<Record<string, any>>;
  recoveryTransitions: Array<Record<string, any>>;
}) {
  if (args.success) return "completed";
  if (includesAny(args.stopReason, ["terminated_by_user", "paused_by_user", "finished_by_user"])) return "user_control";
  if (includesAny(args.stopReason, ["maxsteps", "max steps"])) return "max_steps";
  if (includesAny(args.stopReason, ["execution", "selector", "click", "type"])) return "execution_failure";
  if (args.blockerEvents.some((event) => event.kind === "loop_guard")) return "blocker_loop_guard";
  if (args.recoveryTransitions.length > 0) return "recovery_exhausted";
  if (args.finalGate && !args.finalGate.satisfied) return "final_gate_missing";
  return "unknown_failure";
}
