import { generateText } from "ai";

import { AgentDecisionSchema, CompletionCheckSchema, GoalSpecSchema } from "../types";
import type { CompletionCheck, GoalSpec, VisionNotes } from "../types";
import { createLanguageModel, DEFAULT_OPENAI_MODEL } from "../../shared/modelFactory";
import type { PageKind, PendingHumanDirective, PendingSelfHeal } from "./shared";
import { cleanJsonMaybe, extractModelUsage, normalizeGoalSpecLike, normalizeParsedDecisionLike, type ModelUsage } from "./shared";
import { compactSnapshotForAgent, compactSnapshotForPlanner, snapshotSurfaceText } from "./pageState";
import { getViewportScreenshotDataUrl } from "./media";
import {
  buildDynamicInputClarificationOverride,
  buildHumanDirectiveDecisionOverride,
  buildMissingFieldClarificationOverride,
} from "./clarification";


const MODEL = DEFAULT_OPENAI_MODEL;
const LANGUAGE_MODEL = createLanguageModel(MODEL);

// TOTO VYTVORI GOAL SPEC PRE ZADANU ULOHU
export async function deriveGoal(args: {
  task: string;
  initialSnapshot: any;
  initialVisionNotes: VisionNotes | null;
  initialScreenshotDataUrl: string;
  currentDate: { iso: string; local: string };
  onUsage?: (usage: ModelUsage) => void;
}): Promise<GoalSpec> {
  const compact = compactSnapshotForPlanner(args.initialSnapshot);

  const messages: any[] = [
    {
      role: "system",
      content:
        "You are a planning module for a web UI agent. " +
        "Use the user task together with the INITIAL PAGE STATE (screenshot + compact DOM snapshot). " +
        "Return ONLY valid JSON, no markdown. " +
        "Create a compact goal spec with 2 to 8 subtasks and 1 to 6 success criteria. " +
        "Also create typed finalRequirements that can be deterministically checked against visible page state. " +
        "Use stable snake_case IDs for subtasks. " +
        "If the initial page already appears authenticated, do not include a login subtask. " +
        "If the page clearly is a plain form page, create fill/submit-oriented subtasks.",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            JSON.stringify({
              task: args.task,
              currentDate: args.currentDate,
              initialSnapshot: compact,
              initialVisionNotes: args.initialVisionNotes,
            }) +
            "\n\nReturn JSON with this exact structure:\n" +
            '{"goal": string, "successCriteria": string[], "stopCondition": string, "assumptions": string[], "constraints": string[], "finalRequirements": [{"kind": "text_visible"|"text_absent"|"url_contains"|"page_kind_is"|"field_equals"|"field_filled"|"answer_visible"|"answer_contains_email"|"answer_contains_phone"|"cart_contains_product"|"cart_not_contains_product"|"overlay_absent"|"confirmation_visible"|"login_form_absent"|"error_absent", "text"?: string, "pageKind"?: string, "label"?: string, "value"?: string, "product"?: string}], "subtasks": [{"id": string, "title": string, "doneWhen": string, "dependsOn": string[]}] }',
        },
        { type: "image", image: args.initialScreenshotDataUrl },
      ],
    },
  ];

  const res = await generateText({ model: LANGUAGE_MODEL, messages });
  args.onUsage?.(extractModelUsage(res));
  const parsed = normalizeGoalSpecLike(JSON.parse(cleanJsonMaybe(res.text)));
  return GoalSpecSchema.parse(parsed);
}

// TOTO VYGENERUJE OTAZKU PRE CLOVEKA
export async function generateClarificationQuestion(args: {
  task: string;
  reason: string;
  lastError?: string;
  snapshot?: any;
  pageKind?: PageKind;
  visionNotes?: VisionNotes | null;
  options?: string[];
  activeSubtaskTitle?: string | null;
  completedSubtasks?: string[];
  pendingHumanDirective?: PendingHumanDirective | null;
  onUsage?: (usage: ModelUsage) => void;
}) {
  const missingFieldOverride = buildMissingFieldClarificationOverride(args);
  if (missingFieldOverride) return missingFieldOverride;

  const dynamicOverride = buildDynamicInputClarificationOverride(args);
  if (dynamicOverride) return dynamicOverride;

  const surfaceText = snapshotSurfaceText(args.snapshot, args.visionNotes).slice(0, 500);
  const payload = {
    task: args.task,
    reason: args.reason,
    pageKind: args.pageKind ?? "unknown",
    currentUrl: String(args.snapshot?.url ?? ""),
    currentTitle: String(args.snapshot?.title ?? ""),
    currentPageSummary: surfaceText,
    activeSubtaskTitle: args.activeSubtaskTitle ?? null,
    completedSubtasks: Array.isArray(args.completedSubtasks) ? args.completedSubtasks.slice(0, 8) : [],
    lastError: args.lastError ?? null,
    visionError: args.visionNotes?.error?.text ?? null,
    hints: Array.isArray(args.visionNotes?.hints) ? args.visionNotes?.hints.slice(0, 5) : [],
    options: Array.isArray(args.options) ? args.options.slice(0, 8) : [],
    priorHumanDirective: args.pendingHumanDirective
      ? {
          text: args.pendingHumanDirective.text,
          appliedCount: args.pendingHumanDirective.appliedCount,
        }
      : null,
  };

  const messages: any[] = [
    {
      role: "system",
      content:
        "You are a UI testing agent asking the human for clarification. " +
        "Write a SHORT, natural Slovak question that helps unblock the agent. " +
        "Be specific to what is visible on the CURRENT page. " +
        "Anchor the question in the CURRENT page context (page kind, title, summary, visible buttons). " +
        "If the CURRENT page clearly shows a cookie or consent dialog, ask ONLY whether it may be accepted/closed or left untouched. " +
        "If task or priorHumanDirective already contains a concrete value, NEVER ask the human to repeat that same value. " +
        "If the blocker looks like a suggestion/autocomplete field, ask about the visible suggestions or whether the option was already selected, not about the value itself again. " +
        "If the task already clearly requires filters or a specific step, do NOT ask whether that step should be done. " +
        "If the current page is already later in the workflow (cart/checkout/confirmation), do NOT ask about an earlier page like login or product search unless that is truly necessary. " +
        "If there was previous human guidance that did not help, ask a MORE SPECIFIC follow-up instead of repeating the same question. " +
        "Do NOT mention CSS selectors or internal debug signatures. " +
        'Return ONLY valid JSON: {"question": string, "quickReplies"?: string[] }',
    },
    { role: "user", content: JSON.stringify(payload) },
  ];

  const res = await generateText({ model: LANGUAGE_MODEL, messages });
  args.onUsage?.(extractModelUsage(res));
  const parsed = JSON.parse(cleanJsonMaybe(res.text));

  const question = String(parsed?.question ?? "").trim();
  const quickReplies = Array.isArray(parsed?.quickReplies)
    ? parsed.quickReplies.map(String).filter(Boolean).slice(0, 4)
    : [];

  if (!question) {
    return {
      question: "Narazil som na problÃ©m na strÃ¡nke. VieÅ¡ mi prosÃ­m poradiÅ¥, ako mÃ¡m pokraÄovaÅ¥?",
      quickReplies: [],
    };
  }

  return { question, quickReplies };
}

// TOTO PREVEDIE INSTRUKCIU OD CLOVEKA NA UI AKCIU
export async function deriveHumanGuidedDecision(args: {
  task: string;
  currentDate: { iso: string; local: string };
  goalSpec: GoalSpec | null;
  snapshot: any;
  visionNotes: VisionNotes | null;
  humanDirective: PendingHumanDirective;
  completedSubtasks: Set<string>;
  pageKind: PageKind;
  lastHelp: string | null;
  onUsage?: (usage: ModelUsage) => void;
}) {
  const override = buildHumanDirectiveDecisionOverride(args);
  if (override) return override;

  const compactSnapshot = compactSnapshotForAgent(args.snapshot);

  const messages: any[] = [
    {
      role: "system",
      content:
        "You are a web UI agent translator. " +
        "You receive a screenshot of the current page AND a compact DOM snapshot. Use BOTH to decide. " +
        "Your job is to turn the HUMAN'S clarification into the immediate next safe UI action(s) on the CURRENT page. " +
        "If you can see a clickable element on the screenshot (like a navigation link, button, or tab), use clickByText with its visible label. " +
        "Prefer clickByText for navigation links and buttons you can see on the screenshot. " +
        "Use CSS selectors only when they are in the DOM snapshot. " +
        "If the human says to open, click, or expand something and you can see it on the screenshot, click it immediately. " +
        "If the human says they already manually handled something, return action='none'. " +
        "Return ONLY JSON in the AgentDecision shape.",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            task: args.task,
            currentDate: args.currentDate,
            goalSpec: args.goalSpec,
            completedSubtasks: [...args.completedSubtasks],
            pageKind: args.pageKind,
            snapshot: compactSnapshot,
            visionNotes: args.visionNotes,
            humanDirective: {
              text: args.humanDirective.text,
              sourceReason: args.humanDirective.sourceReason,
              appliedCount: args.humanDirective.appliedCount,
            },
            lastHelp: args.lastHelp,
          }),
        },
        { type: "image", image: await getViewportScreenshotDataUrl() },
      ],
    },
  ];

  try {
    const res = await generateText({ model: LANGUAGE_MODEL, messages });
    args.onUsage?.(extractModelUsage(res));
    const raw = typeof res === "string" ? res : res?.text ?? "";
    if (!raw) return null;
    const parsed = normalizeParsedDecisionLike(JSON.parse(cleanJsonMaybe(raw)));
    return AgentDecisionSchema.parse(parsed);
  } catch {
    return null;
  }
}

// TOTO VYGENERUJE NAHRADNE ROZHODNUTIE PRI ZASEKNUTI
export async function deriveSelfHealDecision(args: {
  task: string;
  currentDate: { iso: string; local: string };
  goalSpec: GoalSpec | null;
  snapshot: any;
  visionNotes: VisionNotes | null;
  initialSnapshot: any;
  initialVisionNotes: VisionNotes | null;
  completedSubtasks: Set<string>;
  pageKind: PageKind;
  pendingHumanDirective: PendingHumanDirective | null;
  pendingSelfHeal: PendingSelfHeal;
  helpHistory: string[];
  stalePageCount: number;
  recentActionSigs: string[];
  onUsage?: (usage: ModelUsage) => void;
}) {
  const messages: any[] = [
    {
      role: "system",
      content:
        "You are a self-repair module for a web UI agent. " +
        "The agent is currently stuck or hit an execution problem. " +
        "Re-evaluate the CURRENT page using the CURRENT compact DOM snapshot as the primary source of truth and the CURRENT screenshot notes as secondary hints. " +
        "Try to recover WITHOUT asking the human if there is any clear safe continuation. " +
        "Prefer one alternative safe next action or a short safe batch that continues the original task. " +
        "If the task refers to today's date, use the provided currentDate field. " +
        "If the blocked field is a native select or dropdown represented in currentSnapshot.inputs with tag='select' or with options, use action='type' on that selector and set text to the desired option label or value. " +
        "If the previous failure came from typing into a suggestion-driven or hierarchical field, do not repeat the same full text blindly; prefer typing only the leading stable segment or clicking a visible matching option. " +
        "You may mark earlier subtasks done if the current page clearly shows they are already completed. " +
        "If the page advanced unexpectedly, continue from the CURRENT state instead of insisting on the previous selector. " +
        "If no safe recovery exists even after re-evaluation, return needHelp=true with action='none'. " +
        "Return ONLY JSON in the AgentDecision format.",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            task: args.task,
            currentDate: args.currentDate,
            goalSpec: args.goalSpec,
            currentSnapshot: compactSnapshotForAgent(args.snapshot),
            currentVisionNotes: args.visionNotes,
            initialSnapshot: compactSnapshotForPlanner(args.initialSnapshot),
            initialVisionNotes: args.initialVisionNotes,
            completedSubtasks: [...args.completedSubtasks],
            pageKind: args.pageKind,
            pendingHumanDirective: args.pendingHumanDirective
              ? {
                  text: args.pendingHumanDirective.text,
                  sourceReason: args.pendingHumanDirective.sourceReason,
                  appliedCount: args.pendingHumanDirective.appliedCount,
                }
              : null,
            selfHealContext: {
              source: args.pendingSelfHeal.source,
              reason: args.pendingSelfHeal.reason,
              lastError: args.pendingSelfHeal.lastError ?? null,
              lastDecisionSig: args.pendingSelfHeal.lastDecisionSig ?? null,
              originatingPageSig: args.pendingSelfHeal.originatingPageSig,
            },
            progress: {
              helpHistory: args.helpHistory.slice(-4),
              recentActionSigs: args.recentActionSigs.slice(-6),
              stalePageCount: args.stalePageCount,
            },
          }),
        },
        { type: "image", image: await getViewportScreenshotDataUrl() },
      ],
    },
  ];

  try {
    const res = await generateText({ model: LANGUAGE_MODEL, messages });
    args.onUsage?.(extractModelUsage(res));
    const raw = typeof res === "string" ? res : res?.text ?? "";
    if (!raw) return null;
    const parsed = normalizeParsedDecisionLike(JSON.parse(cleanJsonMaybe(raw)));
    return AgentDecisionSchema.parse(parsed);
  } catch {
    return null;
  }
}

// TOTO OVERI CI JE ULOHA UZ HOTOVA
export async function deriveCompletionCheck(args: {
  task: string;
  goalSpec: GoalSpec | null;
  snapshot: any;
  visionNotes: VisionNotes | null;
  completedSubtasks: Set<string>;
  pageKind: PageKind;
  lastHelp: string | null;
  onUsage?: (usage: ModelUsage) => void;
}): Promise<CompletionCheck | null> {
  if (!args.goalSpec) return null;

  const messages: any[] = [
    {
      role: "system",
      content:
        "You are a completion checker for a web UI automation run. " +
        "Decide whether the FULL USER TASK is ALREADY SATISFIED on the CURRENT page. " +
        "Use the CURRENT compact DOM snapshot as the primary source of truth and the CURRENT screenshot notes only as secondary hints. " +
        "Treat every explicit action or state requested by the user as mandatory unless it is clearly optional. " +
        "If the task asks to log in, open a product, add to cart, open the cart, submit a form, navigate somewhere, or reveal information after a sequence of steps, do NOT return done=true until those required actions are already completed and their result is visible. " +
        "Requested information such as price, detail, title, or total is only enough when all required preceding actions are already satisfied too. " +
        "Use completedSubtasks, successCriteria, finalRequirements, and subtasks as hard constraints for what still remains. " +
        "If an earlier blocker like CAPTCHA was required but the CURRENT page already shows the fully requested final state, treat that blocker as resolved and return done=true. " +
        "Be conservative when the result is not clearly visible yet. " +
        'Return ONLY valid JSON: {"done": boolean, "reason": string, "evidence": string[] }',
    },
    {
      role: "user",
      content: JSON.stringify({
        task: args.task,
        goal: args.goalSpec.goal,
        successCriteria: args.goalSpec.successCriteria,
        stopCondition: args.goalSpec.stopCondition,
        finalRequirements: args.goalSpec.finalRequirements,
        subtasks: args.goalSpec.subtasks,
        completedSubtasks: [...args.completedSubtasks],
        pageKind: args.pageKind,
        lastHelp: args.lastHelp,
        currentSnapshot: compactSnapshotForPlanner(args.snapshot),
        currentVisionNotes: args.visionNotes,
      }),
    },
  ];

  try {
    const res = await generateText({ model: LANGUAGE_MODEL, messages });
    args.onUsage?.(extractModelUsage(res));
    const raw = typeof res === "string" ? res : res?.text ?? "";
    if (!raw) return null;
    const parsed = JSON.parse(cleanJsonMaybe(raw));
    return CompletionCheckSchema.parse(parsed);
  } catch {
    return null;
  }
}

// TOTO VYGENERUJE FINALNU ODPOVED PRE POUZIVATELA
export async function deriveFinalVerdict(args: {
  task: string;
  goalSpec: GoalSpec | null;
  snapshot: any;
  visionNotes: VisionNotes | null;
  completedSubtasks: Set<string>;
  pageKind: PageKind;
  success: boolean;
  stopReason: string;
  currentDate: { iso: string; local: string };
  onUsage?: (usage: ModelUsage) => void;
}): Promise<string | null> {
  if (!args.snapshot) return null;

  const messages: any[] = [
    {
      role: "system",
      content:
        "You write the final human-facing result for a web UI automation run. " +
        "Answer in Slovak, plain text only, max 3 short sentences, no markdown. " +
        "Answer the USER TASK directly from the CURRENT page state. " +
        "Use the CURRENT compact DOM snapshot as the primary source of truth and screenshot notes only as secondary hints. " +
        "If the task asks for a detail, description, value, title, price, amount, or other visible information, include it explicitly when it is visible now. " +
        "Do not invent hidden information. If some requested information is not visible, say that it is not clearly visible. " +
        "If the run was not successful, summarize the blocker briefly and do not claim success.",
    },
    {
      role: "user",
      content: JSON.stringify({
        task: args.task,
        success: args.success,
        stopReason: args.stopReason,
        currentDate: args.currentDate,
        goal: args.goalSpec?.goal ?? null,
        successCriteria: args.goalSpec?.successCriteria ?? [],
        finalRequirements: args.goalSpec?.finalRequirements ?? [],
        completedSubtasks: [...args.completedSubtasks],
        pageKind: args.pageKind,
        currentSnapshot: compactSnapshotForPlanner(args.snapshot),
        currentVisionNotes: args.visionNotes,
      }),
    },
  ];

  try {
    const res = await generateText({ model: LANGUAGE_MODEL, messages });
    args.onUsage?.(extractModelUsage(res));
    const raw = typeof res === "string" ? res : res?.text ?? "";
    const text = String(raw ?? "").replace(/\s+/g, " ").trim();
    return text || null;
  } catch {
    return null;
  }
}

// TOTO VRATI ZALOZNU FINALNU ODPOVED
export function fallbackFinalVerdict(args: { success: boolean; stopReason: string }) {
  const reason = String(args.stopReason ?? "").trim();

  if (args.success) {
    return reason || "Uloha bola splnena.";
  }

  if (reason) {
    return `Ulohu sa nepodarilo dokoncit: ${reason}`;
  }

  return "Beh sa skoncil bez finalnej odpovede.";
}
