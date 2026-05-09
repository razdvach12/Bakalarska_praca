import { getPage } from "../../../playwright/browser";
import type { AgentAction } from "../types";
import type { PendingHumanDirective } from "./shared";
import { includesAny, normText } from "./shared";
import { getClickableLabel, selectorInSnapshot, textInSnapshot } from "./pageState";

// TOTO NORMALIZUJE CSS SELEKTOR
export function normalizeCssSelector(sel: string) {
  const s = String(sel ?? "").trim();
  if (!s) return s;

  if (/^#[A-Za-z0-9_-]+$/.test(s)) {
    return s;
  }

  if (s.startsWith("#") && /[ >+~]/.test(s)) {
    return s;
  }

  if (s.startsWith("#")) {
    const id = s.slice(1);
    if (/[^a-zA-Z0-9\-_]/.test(id)) {
      const safeId = id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `[id="${safeId}"]`;
    }
  }

  return s;
}

export function looksLikeCssSelector(sel: string) {
  const s = String(sel ?? "").trim();
  if (!s) return false;
  if (isSyntheticSelector(s)) return false;
  return (
    s.startsWith("#") ||
    s.startsWith(".") ||
    s.startsWith("[") ||
    s.includes("href=") ||
    s.includes("data-test") ||
    s.includes("data-testid") ||
    s.includes("aria-label") ||
    s.includes("name=") ||
    s.includes("id=") ||
    /^([a-z]+)(\.|#|\[)/i.test(s)
  );
}

// TOTO ZISTI CI SELEKTOR NIE JE FALOSNY
export function isSyntheticSelector(sel: string) {
  const s = String(sel ?? "").trim().toLowerCase();
  if (!s) return false;

  return (
    s.startsWith("text=") ||
    s.startsWith("xpath=") ||
    s.startsWith("//") ||
    s.startsWith("role=") ||
    s.startsWith("getbyrole(") ||
    s.includes(">>") ||
    s.includes(":contains(") ||
    s.includes(":has-text(") ||
    s.includes("nth=")
  );
}

export function shouldClickByTextExact(t: string) {
  const x = normText(t);
  if (!x) return false;
  const exactSet = new Set([
    "continue",
    "checkout",
    "login",
    "log in",
    "sign in",
    "submit",
    "next",
    "finish",
    "add to cart",
  ]);
  if (exactSet.has(x)) return true;
  if (x.length <= 10) return true;
  return false;
}

export async function miniStabilize(ms = 120) {
  await new Promise((r) => setTimeout(r, ms));
}

export async function afterActionStabilize() {
  const page = await getPage();
  await page.waitForLoadState("domcontentloaded", { timeout: 1200 }).catch(() => {});
  await page.waitForTimeout(140);
}

export function isNonNavigationalClickFallback(selectorOrText: string) {
  const sel = String(selectorOrText ?? "").toLowerCase();
  if (sel.includes("radio") || sel.includes("checkbox")) return true;
  if (sel.includes("toggle") || sel.includes("switch")) return true;
  if (sel.includes("accordion") || sel.includes("expand") || sel.includes("collapse")) return true;
  if (sel.includes("dropdown") || sel.includes("select") || sel.includes("option")) return true;
  if (sel.includes("burger") || sel.includes("menu") || sel.includes("sidebar")) return true;
  if (sel.includes("tab") || sel.includes("filter")) return true;
  if (sel.includes("submit") || sel.includes("login") || sel.includes("checkout") || sel.includes("continue")) return false;
  return false;
}

export function pushRecent(arr: string[], value: string, max = 8) {
  arr.push(value);
  while (arr.length > max) arr.shift();
}

export function recordAppliedHumanDirective(directive: PendingHumanDirective, helpApplySig: string | null) {
  if (helpApplySig && !directive.appliedOnSignatures.includes(helpApplySig)) {
    directive.appliedOnSignatures.push(helpApplySig);
  }
  directive.appliedCount += 1;
}

// TOTO NORMALIZUJE AKCIU OPROTI SNAPSHOTU
export function normalizeActionAgainstSnapshot(action: AgentAction, snapshot: any) {
  const normalized: AgentAction = { ...action };
  const logs: string[] = [];
  const errors: string[] = [];

  if (normalized.selector) {
    normalized.selector = normalizeCssSelector(String(normalized.selector));
  }

  if (normalized.action === "click" && normalized.selector) {
    const selector = String(normalized.selector).trim();

    if (isSyntheticSelector(selector)) {
      const fallbackText = normalized.text && textInSnapshot(snapshot, String(normalized.text)) ? String(normalized.text) : null;
      if (fallbackText) {
        normalized.action = "clickByText";
        normalized.selector = null;
        normalized.text = fallbackText;
        logs.push(`Rejected synthetic selector "${selector}" and downgraded action to clickByText("${fallbackText}").`);
      } else {
        errors.push(`Rejected synthetic selector "${selector}" without grounded visible text fallback.`);
      }
    } else if (!selectorInSnapshot(snapshot, selector)) {
      const fallbackText =
        normalized.text && textInSnapshot(snapshot, String(normalized.text))
          ? String(normalized.text)
          : null;

      if (fallbackText) {
        normalized.action = "clickByText";
        normalized.selector = null;
        normalized.text = fallbackText;
        logs.push(`Selector "${selector}" was not grounded in snapshot, downgraded to clickByText("${fallbackText}").`);
      } else if (looksLikeCssSelector(selector)) {
        logs.push(`Selector "${selector}" not in snapshot but looks like valid CSS. Allowing direct Playwright click attempt.`);
      } else {
        errors.push(`Selector "${selector}" is not grounded in the current snapshot.`);
      }
    }
  }

  if ((normalized.action === "type" || normalized.action === "wait") && normalized.selector) {
    const selector = String(normalized.selector).trim();
    if (isSyntheticSelector(selector)) {
      errors.push(`Rejected synthetic selector "${selector}" for ${normalized.action}.`);
    } else if (!selectorInSnapshot(snapshot, selector)) {
      errors.push(`Selector "${selector}" is not grounded in the current snapshot for ${normalized.action}.`);
    }
  }

  if (normalized.action === "clickByText") {
    const text = String(normalized.text ?? "").trim();
    if (!text) {
      errors.push("clickByText requires visible text.");
    } else if (!textInSnapshot(snapshot, text)) {
      logs.push(`Text "${text}" not found in snapshot clickables, but allowing Playwright to try clickByText.`);
    }
  }

  return { action: normalized, logs, errors };
}

export function findSnapshotItemBySelector(snapshot: any, selector: string) {
  const target = String(selector ?? "").trim();
  if (!target) return null;

  const items = [
    ...(Array.isArray(snapshot?.buttons) ? snapshot.buttons : []),
    ...(Array.isArray(snapshot?.clickables) ? snapshot.clickables : []),
    ...(Array.isArray(snapshot?.inputs) ? snapshot.inputs : []),
  ];

  return items.find((item) => String(item?.selector ?? "").trim() === target) ?? null;
}

const COMBINING_MARKS_REGEX = /[\u0300-\u036f]/g;

export function normalizeComparableText(value: string) {
  return String(value ?? "").trim().toLowerCase().normalize("NFD").replace(COMBINING_MARKS_REGEX, "");
}

export function splitDynamicInputValueParts(value: string) {
  return String(value ?? "")
    .split(/\s*(?:,|\/|>|;|\||\s-\s|->|â†’)\s*/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function getInputSemanticHaystack(input: any) {
  return [
    input?.selector ?? "",
    input?.label ?? "",
    input?.placeholder ?? "",
    input?.name ?? "",
    input?.id ?? "",
    input?.ariaLabel ?? "",
    input?.role ?? "",
    input?.className ?? "",
    input?.autoComplete ?? "",
    input?.ariaAutocomplete ?? "",
    input?.ariaControls ?? "",
    input?.list ?? "",
    input?.titleAttr ?? "",
    input?.dataTestId ?? "",
  ].join(" ");
}

export function looksLikeStructuredSelectionInput(input: any) {
  if (!input || typeof input !== "object") return false;

  const hay = getInputSemanticHaystack(input);
  return includesAny(hay, [
    "kde",
    "lokalit",
    "location",
    "city",
    "district",
    "region",
    "destination",
    "adresa",
    "address",
    "miesto",
    "mesto",
    "obec",
    "okres",
    "category",
    "kategoria",
    "brand",
    "znack",
    "model",
    "filter",
    "vyber",
    "select",
    "option",
    "autocomplete",
    "autosuggest",
    "typeahead",
    "suggest",
  ]);
}

export function isLikelyDynamicInput(input: any) {
  if (!input || typeof input !== "object") return false;

  const hay = getInputSemanticHaystack(input);

  if (String(input?.role ?? "").toLowerCase() === "combobox") return true;
  if (String(input?.role ?? "").toLowerCase() === "searchbox" && looksLikeStructuredSelectionInput(input)) return true;
  if (includesAny(hay, ["combobox", "autocomplete", "autosuggest", "typeahead", "suggest"])) return true;
  if (looksLikeStructuredSelectionInput(input)) return true;

  const ariaAutocomplete = String(input?.ariaAutocomplete ?? "").toLowerCase();
  if (ariaAutocomplete === "list" || ariaAutocomplete === "both" || ariaAutocomplete === "inline") return true;
  if (String(input?.ariaExpanded ?? "").toLowerCase() === "true") return true;
  if (String(input?.ariaControls ?? "").trim()) return true;
  if (String(input?.list ?? "").trim()) return true;

  return false;
}

// TOTO PLANUJE PISANIE DO DYNAMICKEHO INPUTU S NAVRHMI
export function planDynamicTypeInput(snapshot: any, selector: string, desiredText: string) {
  const input = findSnapshotItemBySelector(snapshot, selector);
  const originalText = String(desiredText ?? "").trim();
  const parts = splitDynamicInputValueParts(originalText);
  const structuredSelection = looksLikeStructuredSelectionInput(input);
  const likelyDynamic = isLikelyDynamicInput(input) || (structuredSelection && parts.length >= 2);
  const textToType = likelyDynamic && parts.length >= 2 && parts[0].length >= 2 ? parts[0] : originalText;

  return {
    input,
    originalText,
    textToType,
    likelyDynamic,
    allowSubstringMatch: likelyDynamic || textToType !== originalText,
    prefixApplied: textToType !== originalText,
    shouldRefresh: likelyDynamic || textToType !== originalText,
    waitMs: textToType !== originalText ? 420 : likelyDynamic ? 280 : 120,
  };
}

// TOTO HLADA NAJLEPSI NAVRH Z AUTOCOMPLETU
export function findDynamicSuggestionCandidate(snapshot: any, desiredText: string, typedText: string, inputSelector: string) {
  const desiredNorm = normalizeComparableText(desiredText);
  const typedNorm = normalizeComparableText(typedText);
  if (!desiredNorm) return null;

  const desiredTokens = desiredNorm.split(/[^a-z0-9]+/g).filter(Boolean);
  const items = [
    ...(Array.isArray(snapshot?.buttons) ? snapshot.buttons : []),
    ...(Array.isArray(snapshot?.clickables) ? snapshot.clickables : []),
  ];

  let best: { selector: string | null; text: string; score: number } | null = null;

  for (const item of items) {
    const selector = String(item?.selector ?? "").trim();
    if (!selector || selector === inputSelector) continue;

    const label = getClickableLabel(item);
    if (!label) continue;

    const labelNorm = normalizeComparableText(label);
    if (!labelNorm) continue;
    if (labelNorm === typedNorm && desiredNorm !== typedNorm) continue;

    let score = 0;

    if (labelNorm === desiredNorm) score += 40;
    else if (labelNorm.includes(desiredNorm) || desiredNorm.includes(labelNorm)) score += 24;
    else if (labelNorm.startsWith(typedNorm) || labelNorm.startsWith(desiredNorm)) score += 20;

    if (desiredTokens.length >= 2) {
      const labelTokens = new Set(labelNorm.split(/[^a-z0-9]+/g).filter(Boolean));
      const overlap = desiredTokens.filter((token) => labelTokens.has(token)).length;
      if (overlap === desiredTokens.length) score += 18;
      else if (overlap >= Math.max(2, desiredTokens.length - 1)) score += 10;
    }

    if (desiredTokens.length === 1 && labelNorm.includes(desiredTokens[0])) {
      score += 12;
    }

    if (typedNorm && labelNorm.includes(typedNorm)) score += 5;
    if (item?.inViewport) score += 3;

    if (score < 10) continue;

    if (!best || score > best.score) {
      best = { selector, text: label, score };
    }
  }

  return best;
}