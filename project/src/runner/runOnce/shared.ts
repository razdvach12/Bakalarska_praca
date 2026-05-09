export type RunOptions = {
  allowHumanHelp?: boolean;
  difficulty?: string;
  runLabel?: string;
};

export type PageKind =
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

export type PendingHumanDirective = {
  text: string;
  sourceReason: string;
  createdAtStep: number;
  appliedCount: number;
  appliedOnSignatures: string[];
};

export type ReplanReason =
  | "backward_subtask_blocked"
  | "pending_human_guidance_replan"
  | "need_help_suppressed_later_workflow"
  | "selector_missing"
  | "click_text_missing"
  | "no_action_executed";

export type SelfHealSource =
  | "planner_need_help"
  | "same_decision_loop"
  | "stale_page"
  | "execution_error"
  | "failed_expected_effect"
  | "selector_missing"
  | "click_text_missing"
  | "no_action_executed";

export type PendingSelfHeal = {
  source: SelfHealSource;
  reason: string;
  createdAtStep: number;
  lastError?: string;
  lastDecisionSig?: string;
  originatingPageSig: string;
};

export type ModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export function stripDataUrls(s: string) {
  if (!s) return s;
  return s.replace(
    /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g,
    "[data:image.base64:STRIPPED]"
  );
}

export function truncate(s: string, max = 900) {
  if (!s) return s;
  return s.length > max ? `${s.slice(0, max)}...(truncated)` : s;
}

export function safeLogMessage(s: string, max = 900) {
  return truncate(stripDataUrls(String(s ?? "")), max);
}

// TOTO VYTIAHNE CISTY JSON Z TEXTU
export function cleanJsonMaybe(s: string) {
  const raw = String(s ?? "").replace(/```json/gi, "```").replace(/```/g, "").trim();

  if (raw.startsWith("{")) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          return raw.slice(0, i + 1);
        }
      }
    }
  }
  
  const firstBrace = raw.indexOf("{");
  if (firstBrace >= 0) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = firstBrace; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          return raw.slice(firstBrace, i + 1);
        }
      }
    }
  }
  
  return raw;
}

export function normText(t: string) {
  return String(t ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function pickLabel(x: any) {
  return x?.text ?? x?.label ?? x?.name ?? x?.ariaLabel ?? x?.titleAttr ?? x?.title ?? x?.value ?? null;
}

export function includesAny(text: string, words: string[]) {
  const n = normText(text);
  return words.some((w) => n.includes(normText(w)));
}

export function toCleanStringArray(value: any, max: number) {
  if (!Array.isArray(value)) return [] as string[];
  return value
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, max);
}

// TOTO NORMALIZUJE GOAL SPEC OD AGENTA
export function normalizeGoalSpecLike(parsed: any) {
  if (!parsed || typeof parsed !== "object") return parsed;

  const goal = String(parsed.goal ?? "").trim();
  const stopCondition = String(parsed.stopCondition ?? goal).trim() || goal;
  const successCriteria = toCleanStringArray(parsed.successCriteria, 6);
  const subtasks = (Array.isArray(parsed.subtasks) ? parsed.subtasks : [])
    .slice(0, 8)
    .map((subtask: any, index: number) => ({
      id: String(subtask?.id ?? `subtask_${index + 1}`).trim(),
      title: String(subtask?.title ?? "").trim(),
      doneWhen: String(subtask?.doneWhen ?? "").trim(),
      dependsOn: toCleanStringArray(subtask?.dependsOn, 6),
    }))
    .filter((subtask: any) => subtask.id && subtask.title && subtask.doneWhen);
  const finalRequirements = normalizeFinalRequirementsLike(parsed.finalRequirements);

  return {
    goal,
    successCriteria: successCriteria.length ? successCriteria : [stopCondition || goal].filter(Boolean),
    stopCondition,
    assumptions: toCleanStringArray(parsed.assumptions, 6),
    constraints: toCleanStringArray(parsed.constraints, 6),
    finalRequirements,
    subtasks,
  };
}

export function normalizeAgentActionLike(action: any) {
  const allowedActions = new Set(["type", "click", "clickByText", "wait", "scroll", "none"]);
  const normalizedAction = String(action?.action ?? "none").trim();

  return {
    action: allowedActions.has(normalizedAction) ? normalizedAction : "none",
    selector: action?.selector == null ? null : String(action.selector),
    text: action?.text == null ? null : String(action.text),
    reason: action?.reason == null ? undefined : String(action.reason),
    mayNavigate: typeof action?.mayNavigate === "boolean" ? action.mayNavigate : undefined,
    expectedEffect: action?.expectedEffect == null ? undefined : String(action.expectedEffect),
    successSignal: action?.successSignal == null ? undefined : String(action.successSignal),
    failureSignal: action?.failureSignal == null ? undefined : String(action.failureSignal),
    fallbackHint: action?.fallbackHint == null ? undefined : String(action.fallbackHint),
  };
}

// TOTO NORMALIZUJE ROZHODNUTIE OD AGENTA
export function normalizeParsedDecisionLike(parsed: any) {
  if (!parsed || typeof parsed !== "object") {
    return {
      done: false,
      reason: "Agent returned invalid object.",
      activeSubtaskId: null,
      markSubtasksDone: [],
      needHelp: true,
      helpReason: "Model returned invalid output.",
      action: "none",
      selector: null,
      text: null,
    };
  }

  const normalizedBase = {
    done: Boolean(parsed.done),
    reason: String(parsed.reason ?? "No further actions needed."),
    activeSubtaskId: parsed.activeSubtaskId == null ? null : String(parsed.activeSubtaskId),
    markSubtasksDone: toCleanStringArray(parsed.markSubtasksDone, 4),
    progressNote: parsed.progressNote == null ? undefined : String(parsed.progressNote),
    needHelp: Boolean(parsed.needHelp),
    helpReason: parsed.helpReason == null ? undefined : String(parsed.helpReason),
  };

  const normalizedActions = Array.isArray(parsed.actions)
    ? parsed.actions.map(normalizeAgentActionLike).slice(0, 5)
    : null;

  if (Array.isArray(normalizedActions) && normalizedActions.length === 0) {
    return {
      ...normalizedBase,
      action: "none",
      selector: null,
      text: null,
    };
  }

  if (Array.isArray(normalizedActions) && normalizedActions.length > 0) {
    return {
      ...normalizedBase,
      actions: normalizedActions,
    };
  }

  if (!Array.isArray(parsed.actions) && parsed.action == null) {
    return {
      ...normalizedBase,
      reason: String(parsed.reason ?? "No further actions provided."),
      action: "none",
      selector: null,
      text: null,
    };
  }

  const normalizedSingle = normalizeAgentActionLike(parsed);
  return {
    ...normalizedBase,
    action: normalizedSingle.action,
    selector: normalizedSingle.selector,
    text: normalizedSingle.text,
    mayNavigate: normalizedSingle.mayNavigate,
    expectedEffect: normalizedSingle.expectedEffect,
    successSignal: normalizedSingle.successSignal,
    failureSignal: normalizedSingle.failureSignal,
    fallbackHint: normalizedSingle.fallbackHint,
  };
}

export function normalizeFinalRequirementsLike(raw: any) {
  if (!Array.isArray(raw)) return [] as any[];

  const parsed: any[] = [];
  for (const item of raw.slice(0, 12)) {
    if (!item || typeof item !== "object") continue;
    const kind = String(item.kind ?? "").trim();
    if (!kind) continue;

    if (kind === "page_kind_is") {
      const pageKind = String(item.pageKind ?? "").trim();
      if (!pageKind) continue;
      parsed.push({ kind, pageKind });
      continue;
    }

    if (kind === "field_equals") {
      const label = String(item.label ?? "").trim();
      const value = String(item.value ?? "").trim();
      if (!label || !value) continue;
      parsed.push({ kind, label, value });
      continue;
    }

    if (kind === "field_filled") {
      const label = String(item.label ?? "").trim();
      if (!label) continue;
      parsed.push({ kind, label });
      continue;
    }

    if (kind === "cart_contains_product" || kind === "cart_not_contains_product") {
      const product = item.product == null ? undefined : String(item.product).trim() || undefined;
      parsed.push({ kind, product });
      continue;
    }

    if (kind === "confirmation_visible") {
      const text = item.text == null ? undefined : String(item.text).trim() || undefined;
      parsed.push({ kind, text });
      continue;
    }

    if (["answer_visible", "answer_contains_email", "answer_contains_phone", "overlay_absent", "login_form_absent", "error_absent"].includes(kind)) {
      parsed.push({ kind });
      continue;
    }

    if (["text_visible", "text_absent", "url_contains"].includes(kind)) {
      const text = String(item.text ?? "").trim();
      if (!text) continue;
      parsed.push({ kind, text });
      continue;
    }
  }

  return parsed;
}

export function extractModelUsage(result: any): ModelUsage {
  const usage = result?.usage ?? result?.providerMetadata?.usage ?? {};
  const promptTokens = Number(usage?.inputTokens ?? usage?.promptTokens ?? usage?.prompt ?? 0);
  const completionTokens = Number(usage?.outputTokens ?? usage?.completionTokens ?? usage?.completion ?? 0);
  const explicitTotal = Number(usage?.totalTokens ?? usage?.total ?? 0);

  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    totalTokens:
      Number.isFinite(explicitTotal) && explicitTotal > 0
        ? explicitTotal
        : Math.max(0, (Number.isFinite(promptTokens) ? promptTokens : 0) + (Number.isFinite(completionTokens) ? completionTokens : 0)),
  };
}

// TOTO VRATI AKTUALNY DATUM V ROZNYCH FORMATOCH
export function getCurrentDateContext() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";

  return {
    iso: `${year}-${month}-${day}`,
    local: new Intl.DateTimeFormat("sk-SK", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(now),
  };
}
