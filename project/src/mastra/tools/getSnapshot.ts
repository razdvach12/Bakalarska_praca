import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getPage } from "../../../playwright/browser";

const BBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const InputSchema = z.object({
  selector: z.string(),
  tag: z.string().optional(),
  label: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  ariaLabel: z.string().optional(),
  placeholder: z.string().optional(),
  value: z.string().optional(),
  options: z.array(z.string()).optional(),
  role: z.string().optional(),
  autoComplete: z.string().optional(),
  ariaAutocomplete: z.string().optional(),
  ariaExpanded: z.string().optional(),
  ariaControls: z.string().optional(),
  list: z.string().optional(),
  type: z.string().optional(),
  className: z.string().optional(),
  titleAttr: z.string().optional(),
  dataTestId: z.string().optional(),
  visible: z.boolean().optional(),
  enabled: z.boolean().optional(),
  count: z.number().int().optional(),
  inViewport: z.boolean().optional(),
  bbox: BBoxSchema.optional().nullable(),
});

const ClickableSchema = z.object({
  selector: z.string(),
  text: z.string().optional(),
  id: z.string().optional(),
  ariaLabel: z.string().optional(),
  role: z.string().optional(),
  className: z.string().optional(),
  titleAttr: z.string().optional(),
  href: z.string().optional(),
  tag: z.string().optional(),
  dataTestId: z.string().optional(),
  visible: z.boolean().optional(),
  enabled: z.boolean().optional(),
  count: z.number().int().optional(),
  inViewport: z.boolean().optional(),
  bbox: BBoxSchema.optional().nullable(),
});

// TOTO VYTVORI ODLAHCENY SNAPSHOT STRANKY
export const getSnapshotTool = createTool({
  id: "browser_get_snapshot",
  description: "Get a lightweight snapshot of the page. Supports fast and recovery modes.",
  inputSchema: z.object({
    mode: z.enum(["fast", "recovery"]).optional().default("fast"),
  }),
  outputSchema: z.object({
    url: z.string(),
    title: z.string(),
    text: z.string(),
    cartBadge: z.string().nullable(),
    pageMeta: z.object({
      modalOpen: z.boolean(),
      cookieLikeOverlay: z.boolean(),
      dropdownOpen: z.boolean(),
      nearBottom: z.boolean(),
    }),
    inputs: z.array(InputSchema),
    buttons: z.array(ClickableSchema),
    clickables: z.array(ClickableSchema),
  }),
  execute: async ({ context }) => {
    const page = await getPage();
    const mode = context?.mode ?? "fast";

    const config = {
      textLimit: mode === "recovery" ? 2500 : 1400,
      inputLimit: mode === "recovery" ? 160 : 100,
      clickableLimit: mode === "recovery" ? 240 : 140,
      buttonLimit: mode === "recovery" ? 160 : 100,
      outputInputLimit: mode === "recovery" ? 80 : 48,
      outputClickableLimit: mode === "recovery" ? 160 : 100,
    };

    const data: any = await page.evaluate((cfg: any) => {
      const url = location.href;
      const title = document.title || "";
      const rawText = document.body?.innerText ?? "";
      const text = rawText.replace(/\s+/g, " ").trim().slice(0, cfg.textLimit);
      const scrollY = window.scrollY || window.pageYOffset || 0;
      const viewportHeight = window.innerHeight || 0;
      const documentHeight = Math.max(
        document.body?.scrollHeight ?? 0,
        document.documentElement?.scrollHeight ?? 0,
        document.body?.offsetHeight ?? 0,
        document.documentElement?.offsetHeight ?? 0
      );

      // TOTO HLADA BADGE S POCTOM POLOZIEK V KOSIKU
      const cartBadgeSelectors = [
        '[aria-label*="cart" i] [class*="badge" i]',
        '[aria-label*="basket" i] [class*="badge" i]',
        '[class*="cart" i] [class*="badge" i]',
        '[class*="cart" i] [class*="count" i]',
        '[data-testid*="cart-count" i]',
        '[data-test*="cart-badge" i]',
        '.cart-count',
        '.cart-badge',
        '.basket-count',
      ];
      let cartBadge: string | null = null;
      for (const sel of cartBadgeSelectors) {
        try {
          const el = document.querySelector(sel) as any;
          const text = el?.textContent?.trim();
          if (text && /^\d+$/.test(text)) {
            cartBadge = text;
            break;
          }
        } catch {}
      }

      const vpW = window.innerWidth || 0;
      const vpH = window.innerHeight || 0;
      const seen = new Set<string>();

      const cssAttrValue = (v: any) =>
        String(v)
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"');

      const safeIdSelector = (id: string) => {
        const s = String(id);
        if (/^[a-zA-Z0-9_-]+$/.test(s)) return `#${s}`;
        return `[id="${cssAttrValue(s)}"]`;
      };

      const uniqCount = (sel: string) => {
        try {
          return document.querySelectorAll(sel).length;
        } catch {
          return 0;
        }
      };

      const buildDomPath = (el: any) => {
        const parts: string[] = [];
        let node = el;
        let depth = 0;

        while (node && node.nodeType === 1 && depth < 7) {
          const tag = String(node.tagName || "").toLowerCase();
          if (!tag || tag === "html" || tag === "body") break;

          const id = String(node.getAttribute?.("id") || "").trim();
          const dataTest = String(node.getAttribute?.("data-test") || "").trim();
          const dataTestId = String(node.getAttribute?.("data-testid") || "").trim();

          let part = "";
          if (dataTest) part = `[data-test="${cssAttrValue(dataTest)}"]`;
          else if (dataTestId) part = `[data-testid="${cssAttrValue(dataTestId)}"]`;
          else if (id) part = safeIdSelector(id);
          else {
            let index = 1;
            let sibling = node;
            while ((sibling = sibling.previousElementSibling)) {
              if (String(sibling.tagName || "").toLowerCase() === tag) index += 1;
            }
            part = `${tag}:nth-of-type(${index})`;
          }

          parts.unshift(part);
          const selector = parts.join(" > ");
          if (uniqCount(selector) === 1) return selector;

          node = node.parentElement;
          depth += 1;
        }

        return parts.length ? parts.join(" > ") : null;
      };

      const isVisibleFast = (el: any, rect: DOMRect) => {
        if (!rect || rect.width < 2 || rect.height < 2) return false;
        const cs = window.getComputedStyle(el);
        if (!cs) return false;
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        const op = Number(cs.opacity || "1");
        if (!Number.isNaN(op) && op < 0.01) return false;
        return true;
      };

      const looksLikeCookieText = (value: string) =>
        /cookie|cookies|consent|privacy|gdpr|tracking|suhlas|akzept|zustimm/i.test(value);

      const inViewport = (rect: DOMRect) => rect.x + rect.width > 0 && rect.y + rect.height > 0 && rect.x < vpW && rect.y < vpH;

      const pickSelector = (el: any, tag: string, extra?: any) => {
        const id = (el.getAttribute("id") || "").trim();
        const name = (el.getAttribute("name") || "").trim();
        const ariaLabel = (el.getAttribute("aria-label") || "").trim();
        const titleAttr = (el.getAttribute("title") || "").trim();
        const dataTest = (el.getAttribute("data-test") || "").trim();
        const dataTestId = (el.getAttribute("data-testid") || "").trim();
        const href = (el.getAttribute("href") || "").trim();
        const placeholder = (extra?.placeholder || "").trim();
        const extraName = (extra?.name || "").trim();

        const cands: string[] = [];
        if (dataTest) cands.push(`[data-test="${cssAttrValue(dataTest)}"]`);
        if (dataTestId) cands.push(`[data-testid="${cssAttrValue(dataTestId)}"]`);
        if (tag === "a" && href) cands.push(`a[href="${cssAttrValue(href)}"]`);
        if (id) cands.push(safeIdSelector(id));
        if (extraName) cands.push(`${tag}[name="${cssAttrValue(extraName)}"]`);
        if (name) cands.push(`${tag}[name="${cssAttrValue(name)}"]`);
        if (ariaLabel) cands.push(`${tag}[aria-label="${cssAttrValue(ariaLabel)}"]`);
        if (titleAttr) cands.push(`${tag}[title="${cssAttrValue(titleAttr)}"]`);
        if (placeholder) cands.push(`${tag}[placeholder="${cssAttrValue(placeholder)}"]`);
        const domPath = buildDomPath(el);
        if (domPath) cands.push(domPath);

        for (const s of cands) {
          if (uniqCount(s) === 1) return s;
        }

        return cands[0] ?? null;
      };

      const pickLabelText = (el: any) => {
        const id = String(el?.getAttribute?.("id") || "").trim();

        const clean = (value: any) => String(value ?? "").replace(/\s+/g, " ").trim();

        if (id) {
          const byFor = document.querySelector(`label[for="${cssAttrValue(id)}"]`) as any;
          const t = clean(byFor?.innerText ?? byFor?.textContent ?? "");
          if (t) return t.slice(0, 140);
        }

        const wrappingLabel = el?.closest?.("label") as any;
        const wrappingText = clean(wrappingLabel?.innerText ?? wrappingLabel?.textContent ?? "");
        if (wrappingText) return wrappingText.slice(0, 140);

        const ariaLabelledBy = String(el?.getAttribute?.("aria-labelledby") || "").trim();
        if (ariaLabelledBy) {
          const texts = ariaLabelledBy
            .split(/\s+/)
            .map((ref: string) => document.getElementById(ref))
            .map((node: any) => clean(node?.innerText ?? node?.textContent ?? ""))
            .filter(Boolean);
          if (texts.length) return texts.join(" ").slice(0, 140);
        }

        return undefined;
      };

      const makeClickable = (el: any, selector: string, forcedText?: string | null) => {
        if (!el || !selector) return null;
        const rect = el.getBoundingClientRect();
        const visible = isVisibleFast(el, rect);
        if (!visible) return null;

        const tag = String(el.tagName || "").toLowerCase();
        const enabled = !el.disabled;
        const count = uniqCount(selector);
        const rawTextCandidate = [
          forcedText,
          el.innerText,
          el.textContent,
          el.value,
          el.getAttribute?.("value"),
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
        ]
          .map((value: any) => String(value ?? "").replace(/\s+/g, " ").trim())
          .find(Boolean);
        const t = String(rawTextCandidate ?? "").slice(0, 140);

        return {
          selector,
          text: t || undefined,
          id: el.getAttribute("id") || undefined,
          ariaLabel: el.getAttribute("aria-label") || undefined,
          role: el.getAttribute("role") || undefined,
          className: el.getAttribute("class") || undefined,
          titleAttr: el.getAttribute("title") || undefined,
          href: el.getAttribute("href") || undefined,
          tag: tag || undefined,
          dataTestId: el.getAttribute("data-test") || el.getAttribute("data-testid") || undefined,
          visible,
          enabled,
          count,
          inViewport: inViewport(rect),
          bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      };

      const collectClickables = () => {
        const results: any[] = [];
        const nodes = Array.from(
          document.querySelectorAll(
            'button, a, [role="button"], [role="link"], [role="option"], [role="menuitem"], [role="listbox"] > *, input[type="submit"], input[type="button"], summary'
          )
        ).slice(0, cfg.clickableLimit);

        for (const node of nodes) {
          const el = node as any;
          const tag = String(el.tagName || "").toLowerCase();
          const rect = el.getBoundingClientRect();
          if (!isVisibleFast(el, rect)) continue;

          const selector = pickSelector(el, tag);
          if (!selector || seen.has(selector)) continue;
          seen.add(selector);

          const clickable = makeClickable(el, selector);
          if (clickable) results.push(clickable);
        }

        return results;
      };

      const collectInputs = () => {
        const results: any[] = [];
        const nodes = Array.from(
          document.querySelectorAll(
            'input, textarea, select, [role="combobox"], [role="textbox"], [role="searchbox"], [contenteditable="true"], [contenteditable=""]'
          )
        ).slice(0, cfg.inputLimit);

        for (const node of nodes) {
          const el = node as any;
          const tag = String(el.tagName || "").toLowerCase();
          const rect = el.getBoundingClientRect();
          if (!isVisibleFast(el, rect)) continue;

          const name = el.getAttribute("name");
          const placeholder = el.getAttribute("placeholder");
          const selector = pickSelector(el, tag, { name, placeholder });
          if (!selector || seen.has(selector)) continue;
          seen.add(selector);

          let value = "";
          try {
            value =
              el.value != null
                ? String(el.value)
                : String(el.getAttribute?.("aria-valuetext") ?? el.innerText ?? el.textContent ?? "");
          } catch {
            value = "";
          }

          results.push({
            selector,
            tag: tag || undefined,
            label: pickLabelText(el),
            id: el.getAttribute("id") || undefined,
            name: name || undefined,
            ariaLabel: el.getAttribute("aria-label") || undefined,
            placeholder: placeholder || undefined,
            value: value ? value.slice(0, 200) : undefined,
            checked: (el.type === "checkbox" || el.type === "radio") ? Boolean(el.checked) : undefined,
            options:
              tag === "select"
                ? Array.from(el.options ?? [])
                    .map((opt: any) => String(opt.label ?? opt.textContent ?? "").replace(/\s+/g, " ").trim())
                    .filter(Boolean)
                    .slice(0, 12)
                : undefined,
            role: el.getAttribute("role") || undefined,
            autoComplete: el.getAttribute("autocomplete") || undefined,
            ariaAutocomplete: el.getAttribute("aria-autocomplete") || undefined,
            ariaExpanded: el.getAttribute("aria-expanded") || undefined,
            ariaControls: el.getAttribute("aria-controls") || undefined,
            list: el.getAttribute("list") || undefined,
            type: el.getAttribute("type") || undefined,
            className: el.getAttribute("class") || undefined,
            titleAttr: el.getAttribute("title") || undefined,
            dataTestId: el.getAttribute("data-test") || el.getAttribute("data-testid") || undefined,
            visible: true,
            enabled: !el.disabled,
            count: uniqCount(selector),
            inViewport: inViewport(rect),
            bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          });
        }

        return results;
      };

      const pushSpecialClickable = (results: any[], selector: string, label: string) => {
        try {
          const el = document.querySelector(selector) as any;
          if (!el || seen.has(selector)) return;
          const clickable = makeClickable(el, selector, label);
          if (!clickable) return;
          seen.add(selector);
          results.unshift(clickable);
        } catch {}
      };

      const allClickables = collectClickables();

      // TOTO PRIDAVA BEZNE PATTERNY PRE KOSIK A MENU
      const GENERIC_CART_SELECTORS = [
        '[aria-label*="cart" i]',
        '[aria-label*="basket" i]',
        '[aria-label*="bag" i]',
        'a[href*="cart"]',
        'a[href*="basket"]',
        '[data-testid*="cart" i]',
        '[data-test*="cart" i]',
      ];
      const GENERIC_MENU_SELECTORS = [
        '[aria-label*="menu" i]',
        '[aria-label*="navigation" i]',
        'button[aria-expanded]',
        '[data-testid*="menu" i]',
        '[data-test*="menu" i]',
      ];
      for (const sel of GENERIC_CART_SELECTORS) {
        pushSpecialClickable(allClickables, sel, "cart");
      }
      for (const sel of GENERIC_MENU_SELECTORS) {
        pushSpecialClickable(allClickables, sel, "menu");
      }

      const buttons: any[] = [];
      const clickables: any[] = [];
      for (const c of allClickables) {
        const tag = String(c.tag || "");
        const role = String(c.role || "").toLowerCase();
        const isButton = tag === "button" || (role === "button" && tag !== "a");
        (isButton ? buttons : clickables).push(c);
      }

      const viewportArea = Math.max(1, vpW * vpH);

      const overlayCandidates = Array.from(
        document.querySelectorAll(
          '[role="dialog"], dialog, [aria-modal="true"], [class*="modal" i], [class*="popup" i], [class*="overlay" i], [class*="drawer" i], [class*="cookie" i], [class*="consent" i], [id*="cookie" i], [id*="consent" i]'
        )
      );

      const overlayNodes = overlayCandidates.filter((node: any) => {
        const rect = node.getBoundingClientRect();
        if (!isVisibleFast(node, rect)) return false;
        if (rect.width < 140 || rect.height < 48) return false;

        const tagName = String(node.tagName || "").toLowerCase();
        const role = String(node.getAttribute?.("role") || "").toLowerCase();
        const ariaModal = String(node.getAttribute?.("aria-modal") || "").toLowerCase() === "true";
        const isExplicitDialog = tagName === "dialog" || role === "dialog" || ariaModal;
        if (isExplicitDialog) return true;

        const cs = window.getComputedStyle(node);
        const position = String(cs?.position || "").toLowerCase();
        if (position !== "fixed" && position !== "absolute" && position !== "sticky") return false;

        const areaPct = (rect.width * rect.height) / viewportArea;
        const zIndex = parseInt(cs?.zIndex || "0", 10) || 0;
        const className = String(node.className || "").toLowerCase();
        const idAttr = String(node.id || "").toLowerCase();
        const looksCookieish = /cookie|consent|gdpr/.test(className + " " + idAttr);

        if (areaPct >= 0.25) return true;
        if (zIndex >= 1000 && areaPct >= 0.05) return true;
        if (looksCookieish && zIndex >= 100) return true;
        return false;
      });

      const modalOpen = overlayNodes.length > 0;
      const cookieLikeOverlay = overlayNodes.some((node: any) =>
        looksLikeCookieText(String(node.innerText ?? node.textContent ?? ""))
      );
      const dropdownOpen = Array.from(document.querySelectorAll('[role="listbox"], [role="menu"], [aria-expanded="true"]')).some((node: any) => {
        const rect = node.getBoundingClientRect?.();
        return rect && isVisibleFast(node, rect);
      });
      const nearBottom = documentHeight > 0 ? scrollY + viewportHeight >= documentHeight - 120 : false;

      return {
        url,
        title,
        text,
        cartBadge,
        pageMeta: {
          modalOpen,
          cookieLikeOverlay,
          dropdownOpen,
          nearBottom,
        },
        inputs: collectInputs(),
        buttons,
        clickables,
      };
    }, config);

    return {
      url: data.url,
      title: data.title,
      text: data.text,
      cartBadge: data.cartBadge ?? null,
      pageMeta: data.pageMeta ?? {
        modalOpen: false,
        cookieLikeOverlay: false,
        dropdownOpen: false,
        nearBottom: false,
      },
      inputs: (data.inputs ?? []).slice(0, config.outputInputLimit),
      buttons: (data.buttons ?? []).slice(0, config.buttonLimit),
      clickables: (data.clickables ?? []).slice(0, config.outputClickableLimit),
    };
  },
});