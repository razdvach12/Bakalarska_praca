import type { AgentAction, AgentDecision, GoalSpec, GoalSubtask, VisionNotes } from "../types";
import type { PageKind } from "./shared";
import { includesAny, normText, pickLabel } from "./shared";

// TOTO ZMENSI SNAPSHOT PRE PLANOVACI MODUL
export function compactSnapshotForPlanner(snapshot: any) {
  const inputs: any[] = Array.isArray(snapshot?.inputs) ? snapshot.inputs : [];
  const buttons: any[] = Array.isArray(snapshot?.buttons) ? snapshot.buttons : [];
  const clickables: any[] = Array.isArray(snapshot?.clickables) ? snapshot.clickables : [];

  return {
    url: snapshot?.url ?? null,
    title: snapshot?.title ?? null,
    text: String(snapshot?.text ?? "").slice(0, 1600),
    cartBadge: snapshot?.cartBadge ?? null,
    pageMeta: snapshot?.pageMeta ?? null,
    inputs: inputs.slice(0, 20).map((x) => ({
      selector: x?.selector ?? null,
      tag: x?.tag ?? null,
      label: x?.label ?? null,
      name: x?.name ?? null,
      id: x?.id ?? null,
      placeholder: x?.placeholder ?? null,
      type: x?.type ?? null,
      value: x?.value ?? null,
      options: Array.isArray(x?.options) ? x.options.slice(0, 8) : undefined,
      ariaLabel: x?.ariaLabel ?? null,
      role: x?.role ?? null,
      className: x?.className ?? null,
      autoComplete: x?.autoComplete ?? null,
      ariaAutocomplete: x?.ariaAutocomplete ?? null,
      ariaExpanded: x?.ariaExpanded ?? null,
      ariaControls: x?.ariaControls ?? null,
      list: x?.list ?? null,
    })),
    buttons: buttons.slice(0, 24).map((x) => ({
      selector: x?.selector ?? null,
      text: x?.text ?? null,
      ariaLabel: x?.ariaLabel ?? null,
      href: x?.href ?? null,
    })),
    clickables: clickables.slice(0, 24).map((x) => ({
      selector: x?.selector ?? null,
      text: x?.text ?? null,
      ariaLabel: x?.ariaLabel ?? null,
      href: x?.href ?? null,
    })),
  };
}

// TOTO ZMENSI SNAPSHOT PRE AGENTA
export function compactSnapshotForAgent(snapshot: any) {
  const inputs: any[] = Array.isArray(snapshot?.inputs) ? snapshot.inputs : [];
  const buttons: any[] = Array.isArray(snapshot?.buttons) ? snapshot.buttons : [];
  const clickables: any[] = Array.isArray(snapshot?.clickables) ? snapshot.clickables : [];

  return {
    url: snapshot?.url ?? null,
    title: snapshot?.title ?? null,
    text: String(snapshot?.text ?? "").slice(0, 1400),
    cartBadge: snapshot?.cartBadge ?? null,
    pageMeta: snapshot?.pageMeta ?? null,
    inputs: inputs.slice(0, 16).map((x) => ({
      selector: x?.selector ?? null,
      tag: x?.tag ?? null,
      label: x?.label ?? null,
      name: x?.name ?? null,
      id: x?.id ?? null,
      placeholder: x?.placeholder ?? null,
      type: x?.type ?? null,
      value: x?.value ?? null,
      options: Array.isArray(x?.options) ? x.options.slice(0, 8) : undefined,
      ariaLabel: x?.ariaLabel ?? null,
      role: x?.role ?? null,
      className: x?.className ?? null,
      autoComplete: x?.autoComplete ?? null,
      ariaAutocomplete: x?.ariaAutocomplete ?? null,
      ariaExpanded: x?.ariaExpanded ?? null,
      ariaControls: x?.ariaControls ?? null,
      list: x?.list ?? null,
    })),
    buttons: buttons.slice(0, 18).map((x) => ({
      selector: x?.selector ?? null,
      text: x?.text ?? null,
      ariaLabel: x?.ariaLabel ?? null,
      href: x?.href ?? null,
    })),
    clickables: clickables.slice(0, 18).map((x) => ({
      selector: x?.selector ?? null,
      text: x?.text ?? null,
      ariaLabel: x?.ariaLabel ?? null,
      href: x?.href ?? null,
    })),
  };
}

export function selectorInSnapshot(snapshot: any, selector: string): boolean {
  const s = String(selector ?? "").trim();
  if (!s) return false;
  const inputs: any[] = Array.isArray(snapshot?.inputs) ? snapshot.inputs : [];
  const btns: any[] = Array.isArray(snapshot?.buttons) ? snapshot.buttons : [];
  const cl: any[] = Array.isArray(snapshot?.clickables) ? snapshot.clickables : [];
  return [...inputs, ...btns, ...cl].some((x) => String(x?.selector ?? "") === s);
}

export function textInSnapshot(snapshot: any, text: string): boolean {
  const target = normText(text);
  if (!target) return false;
  const btns: any[] = Array.isArray(snapshot?.buttons) ? snapshot.buttons : [];
  const cl: any[] = Array.isArray(snapshot?.clickables) ? snapshot.clickables : [];
  return [...btns, ...cl]
    .map((x) => normText(String(x?.text ?? x?.ariaLabel ?? "")))
    .some((x) => x === target || x.includes(target) || target.includes(x));
}

export function summarizeOptions(snapshot: any, max = 8) {
  const inputs: any[] = Array.isArray(snapshot?.inputs) ? snapshot.inputs : [];
  const btns: any[] = Array.isArray(snapshot?.buttons) ? snapshot.buttons : [];
  const cl: any[] = Array.isArray(snapshot?.clickables) ? snapshot.clickables : [];
  const selectOptions = inputs
    .flatMap((x) => (Array.isArray(x?.options) ? x.options : []))
    .filter((t) => typeof t === "string" && t.trim().length > 0)
    .map((t) => String(t).trim());
  const labels = [...btns, ...cl]
    .map(pickLabel)
    .filter((t) => typeof t === "string" && t.trim().length > 0)
    .map((t) => String(t).trim());

  const uniq: string[] = [];
  for (const t of [...selectOptions, ...labels]) {
    if (!uniq.includes(t)) uniq.push(t);
    if (uniq.length >= max) break;
  }
  return uniq;
}

export function pageSignature(snapshot: any, visionNotes: VisionNotes | null) {
  const inputState = (Array.isArray(snapshot?.inputs) ? snapshot.inputs : [])
    .slice(0, 12)
    .map((x: any) => `${x?.selector ?? ""}:${x?.value ?? ""}`)
    .join("|");

  return JSON.stringify({
    url: snapshot?.url ?? null,
    title: snapshot?.title ?? null,
    text: String(snapshot?.text ?? "").slice(0, 500),
    cartBadge: snapshot?.cartBadge ?? null,
    pageMeta: snapshot?.pageMeta ?? null,
    pageType: visionNotes?.page?.type ?? "unknown",
    heading: visionNotes?.page?.heading ?? null,
    overlay: visionNotes?.overlay?.present ?? false,
    errorText: visionNotes?.error?.text ?? null,
    inputState,
  });
}

export const INTENT_STOPWORDS = new Set(["a", "an", "and", "at", "for", "in", "into", "is", "my", "of", "on", "or", "the", "to", "user", "with"]);

export function tokenizeForIntent(text: string) {
  return normText(text)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !INTENT_STOPWORDS.has(token));
}

export function looselyMatchesPhrase(text: string, phrase: string) {
  const normalizedText = normText(text);
  const normalizedPhrase = normText(phrase);

  if (!normalizedText || !normalizedPhrase) return false;
  if (normalizedText.includes(normalizedPhrase)) return true;

  const textTokens = new Set(tokenizeForIntent(text));
  const phraseTokens = tokenizeForIntent(phrase);
  if (!phraseTokens.length) return false;

  return phraseTokens.every((token) => textTokens.has(token));
}

export function getClickableLabel(item: any) {
  return String(item?.text ?? item?.ariaLabel ?? item?.titleAttr ?? "").replace(/\s+/g, " ").trim();
}

export function snapshotSurfaceText(snapshot: any, visionNotes: VisionNotes | null) {
  const inputs: any[] = Array.isArray(snapshot?.inputs) ? snapshot.inputs : [];
  const buttons: any[] = Array.isArray(snapshot?.buttons) ? snapshot.buttons : [];
  const clickables: any[] = Array.isArray(snapshot?.clickables) ? snapshot.clickables : [];

  const buttonLabels = [...buttons, ...clickables]
    .map((item) => getClickableLabel(item))
    .filter(Boolean)
    .slice(0, 30);

  const inputLabels = inputs
    .map((item) => `${item?.label ?? ""} ${item?.placeholder ?? ""} ${item?.name ?? ""} ${item?.ariaLabel ?? ""}`.trim())
    .filter(Boolean)
    .slice(0, 20);

  return [
    snapshot?.url ?? "",
    snapshot?.title ?? "",
    snapshot?.text ?? "",
    visionNotes?.page?.heading ?? "",
    visionNotes?.error?.text ?? "",
    ...buttonLabels,
    ...inputLabels,
  ]
    .join(" ")
    .trim();
}

// TOTO URCI TYP STRANKY PODLA URL A OBSAHU
export function detectPageKind(snapshot: any, visionNotes: VisionNotes | null): PageKind {
  const url = String(snapshot?.url ?? "").toLowerCase();
  const hay = snapshotSurfaceText(snapshot, visionNotes).toLowerCase();

  const visionType = visionNotes?.page?.type;
  if (visionType === "confirmation") return "checkout_complete";
  if (visionType === "login") return "login";

  if (
    includesAny(url, ["complete", "success", "thank", "confirmation", "order-placed"]) ||
    includesAny(hay, ["thank you for your order", "order confirmed", "order placed", "order complete", "purchase complete", "submission successful", "successfully submitted"])
  ) {
    return "checkout_complete";
  }

  if (
    includesAny(url, ["review", "overview", "summary", "step-two", "step-2"]) ||
    includesAny(hay, ["order summary", "order review", "payment information", "shipping information", "price total", "item total", "review your order", "place order"])
  ) {
    return "checkout_overview";
  }

  if (
    includesAny(url, ["checkout", "step-one", "step-1", "shipping", "billing"]) ||
    includesAny(hay, ["checkout", "shipping address", "billing address", "delivery address", "your information", "zip code", "postal code"])
  ) {
    const inputs: any[] = Array.isArray(snapshot?.inputs) ? snapshot.inputs : [];
    const hasFormInputs = inputs.filter((x: any) => x?.tag === "input" && x?.type !== "hidden").length >= 2;
    if (hasFormInputs) return "checkout_info";
  }

  if (
    includesAny(url, ["cart", "basket", "bag"]) ||
    includesAny(hay, ["your cart", "shopping cart", "your basket", "shopping bag", "continue shopping", "proceed to checkout", "view cart"])
  ) {
    return "cart";
  }

  if (
    includesAny(url, ["product/", "item/", "detail", "/p/"]) ||
    includesAny(hay, ["add to cart", "add to basket", "add to bag", "back to products", "product description", "product details"])
  ) {
    const addToCartCount = (hay.match(/add to cart/gi) || []).length;
    if (addToCartCount <= 2) return "product_detail";
  }

  if (
    includesAny(url, ["products", "catalog", "category", "search", "inventory", "shop", "collection"]) ||
    includesAny(hay, ["products", "showing results", "sort by", "filter"])
  ) {
    return "inventory";
  }

  if (
    !includesAny(hay, ["cart", "checkout", "basket"]) &&
    (() => {
      const inputs: any[] = Array.isArray(snapshot?.inputs) ? snapshot.inputs : [];
      const visibleInputs = inputs.filter((x: any) => x?.tag === "input" && x?.type !== "hidden" && x?.visible !== false);
      const hasSubmit = includesAny(hay, ["submit", "send", "register", "sign up", "subscribe", "contact"]);
      return visibleInputs.length >= 3 && hasSubmit;
    })()
  ) {
    return "form";
  }

  if (
    includesAny(url, ["login", "signin", "sign-in", "auth"]) ||
    includesAny(hay, ["username", "password", "log in", "sign in", "forgot password"])
  ) {
    return "login";
  }

  if (visionType === "product_detail") return "product_detail";
  if (visionType === "cart") return "cart";
  if (visionType === "form") return "form";
  if (visionType === "catalog") return "inventory";
  if (visionType === "checkout") return "checkout_info";

  return "unknown";
}

// TOTO ZISTI CI JE POUZIVATEL PRIHLASENY
export function isAuthenticatedish(snapshot: any, visionNotes: VisionNotes | null) {
  const url = String(snapshot?.url ?? "").toLowerCase();
  const title = String(snapshot?.title ?? "").toLowerCase();
  const text = snapshotSurfaceText(snapshot, visionNotes).toLowerCase();
  const heading = String(visionNotes?.page?.heading ?? "").toLowerCase();

  if (visionNotes?.ui?.cartIconVisible) return true;

  if (includesAny(url, ["dashboard", "account", "profile", "my-", "secure", "cart", "checkout", "orders"])) return true;

  if (includesAny(text, ["logout", "log out", "sign out", "my account", "my profile", "welcome,", "hello,", "add to cart"])) return true;
  if (includesAny(title, ["dashboard", "my account", "cart", "checkout"])) return true;
  if (includesAny(heading, ["dashboard", "my account", "your cart", "welcome"])) return true;

  return false;
}

export function isLoginLikeSubtask(subtask: GoalSubtask) {
  const hay = `${subtask.id} ${subtask.title} ${subtask.doneWhen}`;
  return includesAny(hay, ["login", "log in", "sign in", "authenticate", "prihlÃ¡s", "prihlas"]);
}

export function isCompletionLikeSubtask(subtask: GoalSubtask) {
  const hay = `${subtask.id} ${subtask.title} ${subtask.doneWhen}`;
  return includesAny(hay, ["finish", "complete", "confirm", "confirmation", "submit", "success", "done"]);
}

export function isSubtaskLike(subtask: GoalSubtask, words: string[]) {
  const hay = `${subtask.id} ${subtask.title} ${subtask.doneWhen}`;
  return includesAny(hay, words);
}

export function isLoginLikeSubtaskLoose(subtask: GoalSubtask) {
  const hay = `${subtask.id} ${subtask.title} ${subtask.doneWhen}`;
  return ["login", "log in", "sign in", "authenticate", "prihlÃƒÂ¡s", "prihlas"].some((phrase) =>
    looselyMatchesPhrase(hay, phrase)
  );
}

export function isCompletionLikeSubtaskLoose(subtask: GoalSubtask) {
  const hay = `${subtask.id} ${subtask.title} ${subtask.doneWhen}`;
  return ["finish", "complete", "confirm", "confirmation", "submit", "success", "done"].some((phrase) =>
    looselyMatchesPhrase(hay, phrase)
  );
}

export function isSubtaskLikeLoose(subtask: GoalSubtask, words: string[]) {
  const hay = `${subtask.id} ${subtask.title} ${subtask.doneWhen}`;
  return words.some((phrase) => looselyMatchesPhrase(hay, phrase));
}

// TOTO AUTOMATICKY OZNACI HOTOVE SUBTASKY PODLA STAVU STRANKY
export function inferAutoCompletedSubtasks(
  goalSpec: GoalSpec | null,
  snapshot: any,
  visionNotes: VisionNotes | null,
  alreadyDone?: Iterable<string>
) {
  if (!goalSpec) return [] as string[];

  const done: string[] = [];
  const doneSet = new Set(alreadyDone ?? []);
  const pageKind = detectPageKind(snapshot, visionNotes);
  const text = snapshotSurfaceText(snapshot, visionNotes);

  const cartBadgeNum = Number(snapshot?.cartBadge ?? 0);
  const hasCartBadge = Number.isFinite(cartBadgeNum) && cartBadgeNum > 0;
  const canAutoComplete = (subtask: GoalSubtask) => subtask.dependsOn.every((dep) => doneSet.has(dep));
  const markDone = (subtask: GoalSubtask) => {
    if (doneSet.has(subtask.id)) return;
    done.push(subtask.id);
    doneSet.add(subtask.id);
  };

  const PAGE_KIND_ORDER: PageKind[] = ["login", "inventory", "product_detail", "cart", "checkout_info", "checkout_overview", "checkout_complete"];
  const currentKindIndex = PAGE_KIND_ORDER.indexOf(pageKind);

  for (const subtask of goalSpec.subtasks) {
    if (!canAutoComplete(subtask)) continue;

    if (isLoginLikeSubtaskLoose(subtask) && isAuthenticatedish(snapshot, visionNotes)) {
      markDone(subtask);
      continue;
    }

    if (
      isSubtaskLikeLoose(subtask, ["add to cart", "added to cart", "add to basket", "add to bag"]) &&
      (hasCartBadge || currentKindIndex >= PAGE_KIND_ORDER.indexOf("cart"))
    ) {
      markDone(subtask);
      continue;
    }

    if (
      isSubtaskLikeLoose(subtask, ["open cart", "view cart", "go to cart", "your cart", "basket"]) &&
      currentKindIndex >= PAGE_KIND_ORDER.indexOf("cart")
    ) {
      markDone(subtask);
      continue;
    }

    if (
      isSubtaskLikeLoose(subtask, ["checkout", "proceed to checkout", "start checkout"]) &&
      currentKindIndex >= PAGE_KIND_ORDER.indexOf("checkout_info")
    ) {
      markDone(subtask);
      continue;
    }

    if (
      isSubtaskLikeLoose(subtask, ["fill", "information", "shipping", "billing", "address", "form"]) &&
      currentKindIndex >= PAGE_KIND_ORDER.indexOf("checkout_overview")
    ) {
      markDone(subtask);
      continue;
    }

    if (
      isCompletionLikeSubtaskLoose(subtask) &&
      (pageKind === "checkout_complete" ||
        includesAny(text, ["thank you", "complete", "submitted", "success", "confirmed", "order placed"]))
    ) {
      markDone(subtask);
      continue;
    }

    if (
      isSubtaskLikeLoose(subtask, ["view product", "product detail", "open product"]) &&
      (pageKind === "product_detail" || currentKindIndex >= PAGE_KIND_ORDER.indexOf("cart"))
    ) {
      markDone(subtask);
      continue;
    }
  }

  return done;
}

export function getKnownSubtaskIds(goalSpec: GoalSpec | null) {
  return new Set((goalSpec?.subtasks ?? []).map((x) => x.id));
}

export function getSubtaskTitle(goalSpec: GoalSpec | null, subtaskId: string | null | undefined) {
  if (!goalSpec || !subtaskId) return null;
  return goalSpec.subtasks.find((x) => x.id === subtaskId)?.title ?? null;
}

// TOTO ZISTI CI AKCIA SUVISI S PRIHLASENIM
export function isLoginishAction(a: any) {
  const selectorHay = String(a?.selector ?? "").toLowerCase();
  const textHay = String(a?.text ?? "").toLowerCase();
  const actionHay = `${selectorHay} ${textHay}`;

  if (a?.action === "type" && includesAny(actionHay, ["user", "username", "email", "login", "password", "pass", "heslo"])) return true;
  if ((a?.action === "click" || a?.action === "clickByText") && includesAny(actionHay, ["login", "log in", "sign in", "prihlas"])) return true;
  return false;
}

export function actionSignature(a: Partial<AgentAction> | null | undefined) {
  if (!a) return "none";
  return `${a.action ?? "none"}|${a.selector ?? ""}|${a.text ?? ""}|${String(a.mayNavigate ?? "")}`;
}

export function decisionSignature(decision: AgentDecision) {
  if ((decision as any).actions?.length) {
    return `BATCH:${(decision as any).actions.slice(0, 5).map((a: any) => actionSignature(a)).join(" >> ")}`;
  }
  return actionSignature(decision as any);
}