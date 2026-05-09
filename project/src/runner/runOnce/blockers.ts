import type { AgentAction, VisionNotes } from "../types";
import { normalizeCssSelector } from "./actions";
import { getClickableLabel } from "./pageState";
import { includesAny, normText } from "./shared";

export type BlockerKind = "cookie_consent" | "overlay" | "unknown";

export type BlockerAssessment = {
  present: boolean;
  kind: BlockerKind;
  evidenceKey: string;
  reasons: string[];
  actions: AgentAction[];
};

const COOKIE_CONTEXT_WORDS = [
  "cookie",
  "cookies",
  "consent",
  "privacy",
  "gdpr",
  "tracking",
  "suhlas",
  "akzept",
  "zustimm",
];

const REJECT_WORDS = [
  "reject",
  "decline",
  "deny",
  "necessary",
  "essential only",
  "only necessary",
  "only essential",
  "odmiet",
  "zamiet",
  "essential",
];

const DISMISS_WORDS = [
  "close",
  "dismiss",
  "skip",
  "not now",
  "cancel",
  "later",
  "x",
  "zatvor",
  "zavriet",
  "preskoc",
  "nie teraz",
];

const ACCEPT_WORDS = [
  "accept",
  "allow",
  "agree",
  "ok",
  "okay",
  "got it",
  "continue",
  "enable",
  "accept all",
  "allow all",
  "accept cookies",
  "allow cookies",
  "suhlas",
  "povolit",
  "prijat",
];

const PROMO_CTA_WORDS = [
  "buy now",
  "shop now",
  "subscribe",
  "newsletter",
  "discover",
  "learn more",
  "get started",
  "sign up",
  "register",
  "download",
];

const OVERLAY_WORDS = [
  "modal",
  "dialog",
  "popup",
  "overlay",
  "drawer",
  "newsletter",
  "promo",
  "subscribe",
];

function isCookieContext(text: string) {
  return includesAny(text, COOKIE_CONTEXT_WORDS);
}

function isRejectLike(text: string) {
  return includesAny(text, REJECT_WORDS);
}

function isDismissLike(text: string) {
  return includesAny(text, DISMISS_WORDS);
}

function isAcceptLike(text: string) {
  return includesAny(text, ACCEPT_WORDS);
}

function isPromoCta(text: string) {
  return includesAny(text, PROMO_CTA_WORDS);
}

function buildVisibleItems(snapshot: any) {
  return [
    ...(Array.isArray(snapshot?.buttons) ? snapshot.buttons : []),
    ...(Array.isArray(snapshot?.clickables) ? snapshot.clickables : []),
  ]
    .map((item) => {
      const label = getClickableLabel(item);
      const selector = String(item?.selector ?? "").trim();
      return {
        item,
        label,
        selector: selector ? normalizeCssSelector(selector) : null,
      };
    })
    .filter((item) => item.label || item.selector);
}

function buildAction(label: string, selector: string | null, mayNavigate = false): AgentAction {
  return selector
    ? {
        action: "click",
        selector,
        text: null,
        mayNavigate,
      }
    : {
        action: "clickByText",
        selector: null,
        text: label,
        mayNavigate,
      };
}

function buildEvidenceKey(kind: BlockerKind, reasons: string[], labels: string[]) {
  const compactReasons = [...new Set(reasons)].sort().join("|");
  const compactLabels = [...new Set(labels.map((label) => normText(label)).filter(Boolean))].slice(0, 4).join("|");
  return `${kind}::${compactReasons}::${compactLabels}`;
}

// TOTO VYHODNOTI CI STRANKU BLOKUJE OVERLAY ALEBO COOKIES
export function buildBlockerAssessment(snapshot: any, visionNotes: VisionNotes | null): BlockerAssessment {
  const items = buildVisibleItems(snapshot);
  const surface = `${snapshot?.title ?? ""} ${snapshot?.text ?? ""} ${visionNotes?.page?.heading ?? ""} ${
    Array.isArray(visionNotes?.hints) ? visionNotes?.hints.join(" ") : ""
  }`;

  const overlayBlocksRaw = (visionNotes?.overlay as any)?.blocksInteraction;
  const overlayAreaRaw = (visionNotes?.overlay as any)?.approxAreaPct;
  const overlayBlocks = typeof overlayBlocksRaw === "boolean" ? overlayBlocksRaw : true;
  const overlayArea = typeof overlayAreaRaw === "number" ? overlayAreaRaw : null;
  const visionOverlayIsInteractionBlocking = Boolean(
    visionNotes?.overlay?.present && overlayBlocks && (overlayArea === null || overlayArea >= 12)
  );

  const cookieSignals = [
    Boolean(snapshot?.pageMeta?.cookieLikeOverlay),
    Boolean(visionOverlayIsInteractionBlocking && visionNotes?.overlay?.type === "cookie_consent"),
    isCookieContext(surface),
    items.some((entry) => isCookieContext(entry.label)),
  ];

  const visionConfirmsOverlay = visionOverlayIsInteractionBlocking;

  const overlaySignals = [
    Boolean(snapshot?.pageMeta?.modalOpen && visionConfirmsOverlay),
    visionConfirmsOverlay,
    Boolean(visionConfirmsOverlay && visionNotes?.overlay?.closeVisible),
    Boolean(snapshot?.pageMeta?.modalOpen && includesAny(surface, OVERLAY_WORDS)),
  ];

  const cookieLike = cookieSignals.filter(Boolean).length >= 2 || (cookieSignals[0] && cookieSignals[1]);
  const overlayLike = !cookieLike && visionConfirmsOverlay && overlaySignals.filter(Boolean).length >= 2;
  const kind: BlockerKind = cookieLike ? "cookie_consent" : overlayLike ? "overlay" : "unknown";

  if (kind === "unknown") {
    return {
      present: false,
      kind,
      evidenceKey: "none",
      reasons: [],
      actions: [],
    };
  }

  const reasons: string[] = [];
  if (snapshot?.pageMeta?.cookieLikeOverlay) reasons.push("snapshot.cookieLikeOverlay");
  if (snapshot?.pageMeta?.modalOpen) reasons.push("snapshot.modalOpen");
  if (visionConfirmsOverlay) reasons.push(`vision.overlay.${visionNotes?.overlay?.type ?? "unknown"}`);
  if (visionConfirmsOverlay && visionNotes?.overlay?.closeVisible) reasons.push("vision.closeVisible");
  if (overlayArea !== null) reasons.push(`vision.overlay.area=${Math.round(overlayArea)}`);
  if (isCookieContext(surface)) reasons.push("surface.cookieContext");
  if (includesAny(surface, OVERLAY_WORDS)) reasons.push("surface.overlayContext");

  const ranked = items
    .map((entry) => {
      const label = entry.label;
      if (!label) return null;
      if (isPromoCta(label) && !isDismissLike(label) && !isRejectLike(label)) return null;

      let score = 0;
      if (kind === "cookie_consent") {
        if (isRejectLike(label)) score += 100;
        else if (isDismissLike(label)) score += 70;
        else if (isAcceptLike(label)) score += 50;
      } else {
        if (isDismissLike(label)) score += 95;
        else if (isRejectLike(label)) score += 80;
        else if (isAcceptLike(label) && includesAny(surface, ["required", "continue", "allow"])) score += 40;
      }

      if (isCookieContext(label)) score += 10;
      if (entry.item?.inViewport) score += 3;
      if (!entry.selector) score -= 5;
      if (score <= 0) return null;

      return {
        action: buildAction(label, entry.selector, false),
        label,
        score,
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => b.score - a.score);

  const topLabels = ranked.map((entry: any) => entry.label).slice(0, 4);
  const bestActions = ranked.map((entry: any) => entry.action).slice(0, 4);

  if (bestActions.length === 0 && kind === "cookie_consent" && visionNotes?.overlay?.acceptText) {
    const acceptText = visionNotes.overlay.acceptText;
    bestActions.push(buildAction(acceptText, null, false));
    topLabels.push(acceptText);
    reasons.push("vision.acceptText_fallback");
  }

  if (bestActions.length === 0 && kind === "overlay" && visionNotes?.overlay?.closeVisible) {
    for (const closeText of ["Close", "×", "X", "Zavrieť", "Zatvoriť"]) {
      bestActions.push(buildAction(closeText, null, false));
      topLabels.push(closeText);
    }
    reasons.push("vision.closeVisible_fallback");
  }

  return {
    present: bestActions.length > 0 || (kind !== "unknown" && visionConfirmsOverlay),
    kind,
    evidenceKey: buildEvidenceKey(kind, reasons, topLabels),
    reasons: [...new Set(reasons)],
    actions: bestActions,
  };
}

export function buildBlockerAttemptKey(pageSig: string, blocker: BlockerAssessment, action: AgentAction) {
  return `${pageSig}::${blocker.evidenceKey}::${String(action.action)}::${String(action.selector ?? action.text ?? "")}`;
}

export function actionTargetsBlocker(action: Partial<AgentAction> | null | undefined, blocker: BlockerAssessment | null | undefined) {
  if (!action || !blocker?.present) return false;
  const key = normText(String(action.selector ?? action.text ?? ""));
  return blocker.actions.some((candidate) => key === normText(String(candidate.selector ?? candidate.text ?? "")));
}