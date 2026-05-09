import type { AgentAction, AgentDecision, GoalSpec, VisionNotes } from "../types";
import type { PageKind, PendingHumanDirective } from "./shared";
import { includesAny } from "./shared";
import {
  findSnapshotItemBySelector,
  getInputSemanticHaystack,
  isLikelyDynamicInput,
  looksLikeStructuredSelectionInput,
  normalizeComparableText,
  splitDynamicInputValueParts,
} from "./actions";
import {
  INTENT_STOPWORDS,
  getClickableLabel,
  getSubtaskTitle,
  looselyMatchesPhrase,
  snapshotSurfaceText,
} from "./pageState";

export function isCookieContextText(text: string) {
  return includesAny(text, [
    "cookie",
    "cookies",
    "consent",
    "gdpr",
    "privacy",
    "tracking",
    "suhlas",
    "suhlasim",
    "akcept",
    "prijat",
    "povolit",
    "allow",
    "zustimm",
    "akzept",
  ]);
}

export function isCookieAcceptText(text: string) {
  return includesAny(text, [
    "accept",
    "accept all",
    "accept cookies",
    "allow",
    "allow all",
    "allow cookies",
    "agree",
    "i agree",
    "got it",
    "ok",
    "okay",
    "consent",
    "continue",
    "suhlasim",
    "suhlas",
    "prijat",
    "prijat vsetko",
    "povolit",
    "povolit vsetko",
    "akceptovat",
    "akzept",
    "zustimmen",
    "alle akzeptieren",
  ]);
}

export function isCookieRejectText(text: string) {
  return includesAny(text, [
    "reject",
    "decline",
    "manage",
    "settings",
    "preferences",
    "necessary",
    "essential",
    "learn more",
    "detail",
    "odmiet",
    "nastaven",
    "spravovat",
    "manage options",
  ]);
}

export function getCookieDialogSignals(snapshot: any, visionNotes: VisionNotes | null) {
  const buttons: any[] = Array.isArray(snapshot?.buttons) ? snapshot.buttons : [];
  const clickables: any[] = Array.isArray(snapshot?.clickables) ? snapshot.clickables : [];
  const items = [...buttons, ...clickables];
  const buttonLabels = items.map((item) => getClickableLabel(item)).filter(Boolean);
  const pageHay = `${snapshot?.title ?? ""} ${snapshot?.text ?? ""} ${visionNotes?.page?.heading ?? ""}`;
  const overlaySignal = Boolean(visionNotes?.overlay?.present && visionNotes?.overlay?.type === "cookie_consent");
  const textSignal = isCookieContextText(pageHay);
  const acceptCandidate = buttonLabels.find((label) => isCookieAcceptText(label));
  const rejectCandidate = buttonLabels.find((label) => isCookieRejectText(label));

  return {
    overlaySignal,
    textSignal,
    acceptCandidate: acceptCandidate ?? null,
    rejectCandidate: rejectCandidate ?? null,
  };
}

export function findCookieConsentAction(snapshot: any, visionNotes: VisionNotes | null) {
  const items = [
    ...(Array.isArray(snapshot?.buttons) ? snapshot.buttons : []),
    ...(Array.isArray(snapshot?.clickables) ? snapshot.clickables : []),
  ];
  const signals = getCookieDialogSignals(snapshot, visionNotes);
  if (!signals.overlaySignal && !signals.textSignal) return null;

  for (const item of items) {
    const label = getClickableLabel(item);
    if (label && isCookieAcceptText(label)) {
      return {
        selector: String(item?.selector ?? "").trim() || null,
        label,
      };
    }
  }

  return null;
}

export function looksLikeBlockedUiError(text: string) {
  return includesAny(text, [
    "element is not visible",
    "not receiving pointer events",
    "intercepts pointer",
    "outside of the viewport",
    "another element",
    "obscured",
    "box=null",
    "overlay",
    "modal",
    "cookie",
    "consent",
    "privacy",
    "tracking",
  ]);
}

export function isManualCookieResolutionText(text: string) {
  const manualAction = includesAny(text, [
    "zaklikol som",
    "zaklikla som",
    "odklikol som",
    "odklikla som",
    "uz som ich odklikol",
    "uz som ich odklikla",
    "klikol som",
    "klikla som",
    "zavrel som",
    "zavrela som",
    "zatvoril som",
    "zatvorila som",
    "accepted them",
    "already accepted",
    "already clicked",
    "already closed",
  ]);
  const progressSignal = includesAny(text, ["pokracuj", "continue", "dalej", "hotovo", "done"]);
  const statusSignal = includesAny(text, ["uz som", "mam to", "je to", "spravil som", "urobil som"]);
  return manualAction || (progressSignal && statusSignal);
}

export function isCookieReadyToContinueText(text: string) {
  return (
    isManualCookieResolutionText(text) ||
    includesAny(text, [
      "pokracuj",
      "mozes pokracovat",
      "uz mozes pokracovat",
      "hotovo",
      "done",
      "continue",
      "ready",
      "ok mozes",
    ])
  );
}

export function isAffirmativeHelpAnswer(text: string) {
  return includesAny(text, [
    "yes",
    "yeah",
    "yep",
    "sure",
    "ok",
    "okay",
    "ano",
    "jasne",
    "mozes",
    "mozete",
    "kludne",
    "potvrd",
    "odklikni",
    "accept",
    "allow",
    "klikni",
  ]);
}

export function isNegativeHelpAnswer(text: string) {
  return includesAny(text, [
    "no",
    "nie",
    "ne",
    "nemozes",
    "nemozete",
    "nedavaj",
    "neklikaj",
    "skip",
    "preskoc",
    "odmietni",
    "reject",
    "decline",
  ]);
}

export function isCookieConsentAction(action: Partial<AgentAction> | null | undefined, snapshot: any, visionNotes: VisionNotes | null) {
  if (!action) return false;
  if (!((action.action === "click" && action.selector) || (action.action === "clickByText" && action.text))) return false;

  if (
    !(visionNotes?.overlay?.present && visionNotes?.overlay?.type === "cookie_consent") &&
    !isCookieContextText(`${snapshot?.title ?? ""} ${snapshot?.text ?? ""}`)
  ) {
    return false;
  }

  const label =
    action.action === "click"
      ? getClickableLabel(findSnapshotItemBySelector(snapshot, String(action.selector ?? "")))
      : String(action.text ?? "");

  return isCookieAcceptText(label);
}

export function parseTypeToolFailure(lastError?: string) {
  const text = String(lastError ?? "");
  const match = text.match(/typeTool verification failed for selector "([^"]+)". Expected "([^"]*)"/i);
  if (!match) return null;

  return {
    selector: String(match[1] ?? "").trim(),
    expected: String(match[2] ?? "").trim(),
  };
}

// TOTO POSTAVI OTAZKU PRE DYNAMICKE INPUTY
export function buildDynamicInputClarificationOverride(args: {
  task: string;
  lastError?: string;
  snapshot?: any;
  pendingHumanDirective?: PendingHumanDirective | null;
}) {
  const failure = parseTypeToolFailure(args.lastError);
  if (!failure?.selector) return null;

  const input = findSnapshotItemBySelector(args.snapshot, failure.selector);
  const expected = failure.expected;
  const looksDynamic =
    isLikelyDynamicInput(input) ||
    looksLikeStructuredSelectionInput(input) ||
    splitDynamicInputValueParts(expected).length >= 2;

  if (!looksDynamic) return null;

  const fieldName =
    String(input?.label ?? input?.placeholder ?? input?.ariaLabel ?? input?.name ?? "").trim() ||
    "toto pole";
  const knownValue =
    expected ||
    String(args.pendingHumanDirective?.text ?? "").trim() ||
    String(args.task ?? "").trim();
  const valueHint =
    expected && expected.length <= 80 ? ` pre hodnotu "${expected}"` : knownValue && knownValue.length <= 80 ? ` pre zadanu hodnotu` : "";

  return {
    question:
      `Pole "${fieldName}" sa sprava ako vyber s navrhmi${valueHint}. ` +
      `Ak vidis spravnu moznost, klikni ju prosim a potom mi napis "pokracuj". ` +
      `Ak si ju uz vybral, napis len "pokracuj".`,
    quickReplies: ["Vybral som moznost, pokracuj", "Vidim navrhy", "Nezobrazili sa navrhy"],
  };
}

export function getInputDisplayLabel(input: any) {
  return String(input?.label ?? input?.placeholder ?? input?.ariaLabel ?? input?.name ?? input?.id ?? "").trim() || "toto pole";
}

export function includesAnyComparable(text: string, words: string[]) {
  const normalized = normalizeComparableText(text);
  return words.some((word) => normalized.includes(normalizeComparableText(word)));
}

export function isPlaceholderLikeOption(option: string) {
  const normalized = normalizeComparableText(option);
  if (!normalized) return true;
  if (["-", "--", "---", "..."].includes(normalized)) return true;

  return [
    "select",
    "choose",
    "choose one",
    "please select",
    "vyber",
    "vyberte",
    "zvol",
    "zvolte",
    "pick one",
  ].some((phrase) => normalized.includes(normalizeComparableText(phrase)));
}

export function uniqSelectableOptions(options: string[]) {
  const uniq: string[] = [];

  for (const option of options.map((value) => String(value ?? "").trim())) {
    if (!option || isPlaceholderLikeOption(option)) continue;
    if (uniq.some((existing) => normalizeComparableText(existing) === normalizeComparableText(option))) continue;
    uniq.push(option);
  }

  return uniq;
}

export function parseVisibleOptionsFromReason(reason: string) {
  const match = String(reason ?? "").match(/visible options:\s*([^.]+?)(?:\.|$)/i);
  if (!match) return [] as string[];

  return uniqSelectableOptions(
    String(match[1] ?? "")
      .split(/\s*(?:\||,|;|\/)\s*/g)
      .map((part) => part.trim())
      .filter(Boolean)
  );
}

export function parseMissingFieldFromReason(reason: string) {
  const text = String(reason ?? "").trim();
  if (!text) return null;

  const quotedMatch = text.match(/missing explicit value for field "([^"]+)"/i);
  const bareMatch = text.match(/missing explicit value for field ([^.]+?)(?:\.|,|$)/i);
  const fieldLabel = String(quotedMatch?.[1] ?? bareMatch?.[1] ?? "").trim() || null;
  const explicitMissing =
    /missing explicit value/i.test(text) ||
    /task does not specify/i.test(text) ||
    /value is not specified/i.test(text);

  if (!explicitMissing && !fieldLabel) return null;

  return {
    fieldLabel,
    options: parseVisibleOptionsFromReason(text),
  };
}

export function findInputByFieldLabel(snapshot: any, fieldLabel: string | null | undefined) {
  const target = normalizeComparableText(String(fieldLabel ?? ""));
  if (!target) return null;

  const inputs: any[] = Array.isArray(snapshot?.inputs) ? snapshot.inputs : [];
  let best: { input: any; score: number } | null = null;

  for (const input of inputs) {
    const display = getInputDisplayLabel(input);
    const displayNorm = normalizeComparableText(display);
    const hayNorm = normalizeComparableText(getInputSemanticHaystack(input));

    let score = 0;
    if (displayNorm === target) score = 5;
    else if (displayNorm.includes(target) || target.includes(displayNorm)) score = 4;
    else if (hayNorm.includes(target)) score = 3;

    if (!score) continue;
    if (!best || score > best.score) best = { input, score };
  }

  return best?.input ?? null;
}

export function isCountryLikeInput(input: any) {
  return includesAnyComparable(getInputSemanticHaystack(input), [
    "country",
    "krajina",
    "nationality",
    "citizenship",
    "vehicle country",
    "registration country",
    "plate country",
  ]);
}

export function isRegionLikeInput(input: any) {
  return includesAnyComparable(getInputSemanticHaystack(input), ["region", "state", "province", "county"]);
}

export function taskMentionsVisibleOption(taskText: string, options: string[]) {
  const normalizedTask = normalizeComparableText(taskText);
  if (!normalizedTask) return false;

  return options.some((option) => {
    const normalizedOption = normalizeComparableText(option);
    return normalizedOption.length >= 4 && normalizedTask.includes(normalizedOption);
  });
}

export function findImplicitMissingChoiceInput(args: {
  task: string;
  reason: string;
  snapshot?: any;
  pendingHumanDirective?: PendingHumanDirective | null;
}) {
  if (
    !includesAnyComparable(args.reason, [
      "ambiguous",
      "multiple plausible",
      "missing value",
      "missing explicit value",
      "not specify",
      "not specified",
      "cannot safely choose",
    ])
  ) {
    return null;
  }

  const inputs: any[] = Array.isArray(args.snapshot?.inputs) ? args.snapshot.inputs : [];
  const candidates = inputs.filter((input) => {
    const value = String(input?.value ?? "").trim();
    const options = uniqSelectableOptions(Array.isArray(input?.options) ? input.options : []);
    return !value && options.length > 0 && (isCountryLikeInput(input) || isRegionLikeInput(input));
  });

  if (candidates.length !== 1) return null;

  const taskText = `${args.task ?? ""} ${args.pendingHumanDirective?.text ?? ""}`.trim();
  const options = uniqSelectableOptions(Array.isArray(candidates[0]?.options) ? candidates[0].options : []);
  if (taskMentionsVisibleOption(taskText, options)) return null;

  return candidates[0];
}

// TOTO POSTAVI OTAZKU NA CHYBAJUCE POLE
export function buildMissingFieldClarificationOverride(args: {
  task: string;
  reason: string;
  snapshot?: any;
  pendingHumanDirective?: PendingHumanDirective | null;
}) {
  const parsedMissing = parseMissingFieldFromReason(args.reason);
  const explicitInput = parsedMissing?.fieldLabel ? findInputByFieldLabel(args.snapshot, parsedMissing.fieldLabel) : null;
  const implicitInput = explicitInput ? null : findImplicitMissingChoiceInput(args);
  const input = explicitInput ?? implicitInput;

  if (!parsedMissing && !input) return null;

  const fieldLabel = parsedMissing?.fieldLabel ?? getInputDisplayLabel(input);
  const options = uniqSelectableOptions([
    ...(Array.isArray(input?.options) ? input.options : []),
    ...((parsedMissing?.options ?? []) as string[]),
  ]);

  if (!fieldLabel) return null;

  const countryLike =
    (input && isCountryLikeInput(input)) ||
    includesAnyComparable(fieldLabel, ["country", "krajina", "nationality", "citizenship"]);

  if (countryLike) {
    const slovakiaOption = options.find((option) => includesAnyComparable(option, ["slovakia", "slovensko"]));
    if (slovakiaOption) {
      return {
        question: `V poli "${fieldLabel}" nemam urcenu krajinu. Mam zadat ${slovakiaOption} alebo inu krajinu?`,
        quickReplies: [`Zadaj ${slovakiaOption}`, "Zadaj inu krajinu"],
      };
    }

    return {
      question: `Ktoru krajinu mam zadat do pola "${fieldLabel}"?`,
      quickReplies: options.slice(0, 3).map((option) => `Zadaj ${option}`),
    };
  }

  if (options.length > 0) {
    return {
      question: `V poli "${fieldLabel}" nemam urcenu hodnotu. Mam vybrat "${options[0]}" alebo inu moznost?`,
      quickReplies: [`Vyber ${options[0]}`, "Vyber inu moznost"],
    };
  }

  return {
    question: `Co mam vyplnit do pola "${fieldLabel}"?`,
    quickReplies: [],
  };
}

const HUMAN_GUIDANCE_STOPWORDS = new Set([
  ...INTENT_STOPWORDS,
  "a",
  "aj",
  "ano",
  "dalsi",
  "dany",
  "dana",
  "dane",
  "detail",
  "detailu",
  "este",
  "info",
  "informacie",
  "je",
  "klikni",
  "kliknut",
  "musis",
  "na",
  "nie",
  "otvor",
  "otvorit",
  "potrebne",
  "rozklikni",
  "rozkliknut",
  "si",
  "stranke",
  "stranku",
  "tam",
  "tejto",
  "tej",
  "to",
  "tu",
  "uvidis",
  "vidis",
]);

export function tokenizeGuidanceText(text: string) {
  return normalizeComparableText(text)
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !HUMAN_GUIDANCE_STOPWORDS.has(token));
}

export function looksLikeOpenDetailDirective(text: string) {
  return includesAnyComparable(text, [
    "rozklik",
    "otvor",
    "open",
    "klikni",
    "click",
    "detail",
    "profil",
    "listing",
    "nazov",
  ]);
}

export function pushNamedTarget(targets: string[], value: string | null | undefined) {
  const cleaned = String(value ?? "")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned || cleaned.length < 3) return;
  if (targets.some((target) => normalizeComparableText(target) === normalizeComparableText(cleaned))) return;
  targets.push(cleaned);
}

export function extractNamedTargets(text: string) {
  const source = String(text ?? "");
  const targets: string[] = [];

  for (const match of source.matchAll(/"([^"]+)"/g)) {
    pushNamedTarget(targets, match[1]);
  }

  for (const match of source.matchAll(/(?:nazvom|named|called)\s+([^.,;!?]+)/gi)) {
    pushNamedTarget(targets, match[1]);
  }

  for (const match of source.matchAll(/(?:rozklik[^\s]*|otvor[^\s]*|klikn[^\s]*)\s+([^.,;!?]+?)\s+detail/gi)) {
    pushNamedTarget(targets, match[1]);
  }

  return targets.slice(0, 6);
}

export function findHumanDirectiveClickTarget(args: {
  task: string;
  snapshot?: any;
  humanDirective: PendingHumanDirective;
}) {
  const directiveText = `${String(args.humanDirective.sourceReason ?? "").trim()} ${String(args.humanDirective.text ?? "").trim()}`.trim();
  if (!directiveText) return null;

  const items = [
    ...(Array.isArray(args.snapshot?.buttons) ? args.snapshot.buttons : []),
    ...(Array.isArray(args.snapshot?.clickables) ? args.snapshot.clickables : []),
  ];
  if (!items.length) return null;

  const namedTargets = [...extractNamedTargets(args.task), ...extractNamedTargets(directiveText)];
  const directiveNorm = normalizeComparableText(directiveText);
  const taskNorm = normalizeComparableText(args.task);
  const directiveTokens = tokenizeGuidanceText(directiveText);
  const taskTokens = tokenizeGuidanceText(args.task);
  const openDetailIntent = looksLikeOpenDetailDirective(directiveText);

  let best: { item: any; label: string; score: number } | null = null;

  for (const item of items) {
    const label = getClickableLabel(item);
    if (!label) continue;
    if (isCookieContextText(label) && !isCookieContextText(directiveText)) continue;

    const labelNorm = normalizeComparableText(label);
    const labelTokens = new Set(tokenizeGuidanceText(label));
    let score = 0;

    if (namedTargets.some((target) => looselyMatchesPhrase(label, target))) score += 30;
    if (labelNorm.length >= 4 && directiveNorm.includes(labelNorm)) score += 20;
    if (labelNorm.length >= 4 && taskNorm.includes(labelNorm)) score += 8;

    const directiveOverlap = directiveTokens.filter((token) => labelTokens.has(token)).length;
    const taskOverlap = tokenizeGuidanceText(args.task).filter((token) => labelTokens.has(token)).length;
    score += directiveOverlap * 7;
    score += Math.min(taskOverlap, 4) * 3;

    if (openDetailIntent) {
      if (includesAnyComparable(label, ["detail", "viac", "more", "zobrazit", "otvorit", "open"])) score += 5;
      if (taskOverlap >= 2) score += 6;
    }

    if (item?.inViewport) score += 2;
    if (String(item?.href ?? "").trim()) score += 1;

    if (!best || score > best.score) {
      best = { item, label, score };
    }
  }

  return best && best.score >= 24 ? best : null;
}

export function findSingleDetailLikeTarget(snapshot: any) {
  const items = [
    ...(Array.isArray(snapshot?.buttons) ? snapshot.buttons : []),
    ...(Array.isArray(snapshot?.clickables) ? snapshot.clickables : []),
  ];

  const matches = items.filter((item) => {
    const label = getClickableLabel(item);
    if (!label) return false;
    if (isCookieContextText(label)) return false;
    return includesAnyComparable(label, ["detail", "viac", "more", "zobrazit", "otvorit", "open"]);
  });

  if (matches.length !== 1) return null;

  return {
    item: matches[0],
    label: getClickableLabel(matches[0]),
    score: 1,
  };
}

// TOTO PREVEDIE INSTRUKCIU OD CLOVEKA NA AKCIU
export function buildHumanDirectiveDecisionOverride(args: {
  task: string;
  snapshot?: any;
  humanDirective: PendingHumanDirective;
  pageKind: PageKind;
}): AgentDecision | null {
  const directiveText = String(args.humanDirective.text ?? "").trim();
  if (!directiveText) return null;
  const directiveContext = `${String(args.humanDirective.sourceReason ?? "").trim()} ${directiveText}`.trim();
  const hasOpenDetailIntent = looksLikeOpenDetailDirective(directiveContext);
  const affirmativeReply = isAffirmativeHelpAnswer(directiveText);
  if (!hasOpenDetailIntent && !affirmativeReply) return null;

  const target = findHumanDirectiveClickTarget(args) ?? (affirmativeReply ? findSingleDetailLikeTarget(args.snapshot) : null);
  if (!target) return null;

  const selector = String(target.item?.selector ?? "").trim();
  if (selector) {
    return {
      done: false,
      reason: `Applied human guidance to open "${target.label}" from the current page.`,
      activeSubtaskId: null,
      markSubtasksDone: [],
      progressNote: `Klikam na detail podla rady od pouzivatela: ${target.label}.`,
      needHelp: false,
      action: "click",
      selector,
      text: null,
      mayNavigate: true,
    };
  }

  return {
    done: false,
    reason: `Applied human guidance to open "${target.label}" from the current page.`,
    activeSubtaskId: null,
    markSubtasksDone: [],
    progressNote: `Klikam na detail podla rady od pouzivatela: ${target.label}.`,
    needHelp: false,
    action: "clickByText",
    selector: null,
    text: target.label,
    mayNavigate: true,
  };
}

export function isBackwardSubtask(pageKind: PageKind, activeSubtaskId: string | null | undefined, goalSpec: GoalSpec | null) {
  return false;
}

export function buildProgressPayload(args: {
  completedSubtasks: Set<string>;
  recentActionSigs: string[];
  stalePageCount: number;
  helpHistory: string[];
  lastHelp: string | null;
  pageKind: PageKind;
  pendingHumanDirective: PendingHumanDirective | null;
  helpAppliedOnCurrentState: boolean;
}) {
  return {
    completedSubtasks: [...args.completedSubtasks],
    recentActionSigs: args.recentActionSigs.slice(-6),
    stalePageCount: args.stalePageCount,
    helpHistory: args.helpHistory.slice(-4),
    lastHelp: args.lastHelp,
    pageKind: args.pageKind,
    pendingHumanDirective: args.pendingHumanDirective
      ? {
          text: args.pendingHumanDirective.text,
          sourceReason: args.pendingHumanDirective.sourceReason,
          appliedCount: args.pendingHumanDirective.appliedCount,
        }
      : null,
    helpAppliedOnCurrentState: args.helpAppliedOnCurrentState,
  };
}