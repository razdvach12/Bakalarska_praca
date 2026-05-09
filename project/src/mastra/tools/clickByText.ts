import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getPage } from "../../../playwright/browser";

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripDiacritics(s: string) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

// TOTO HODNOTI KANDIDATA NA KLIKNUTIE
async function scoreCandidate(frame: any, loc: any) {
  const visible = await loc.isVisible().catch(() => false);
  const enabled = await loc.isEnabled().catch(() => false);
  if (!visible || !enabled) return { ok: false as const, score: -999, y: 1e9, meta: null };

  const box = await loc.boundingBox().catch(() => null);
  const vp = frame.page?.().viewportSize?.() ?? null;
  const inViewport =
    !!box &&
    !!vp &&
    box.x + box.width > 0 &&
    box.y + box.height > 0 &&
    box.x < vp.width &&
    box.y < vp.height;

  const meta = await loc
    .evaluate((el: any) => {
      const tag = String(el?.tagName ?? "").toLowerCase();
      const role = String(el?.getAttribute?.("role") ?? "").toLowerCase();
      const type = String(el?.getAttribute?.("type") ?? "").toLowerCase();
      const href = String(el?.getAttribute?.("href") ?? "");
      return { tag, role, type, href };
    })
    .catch(() => ({ tag: "", role: "", type: "", href: "" }));

  const isButtonish =
    meta.tag === "button" ||
    meta.role === "button" ||
    (meta.tag === "a" && !!meta.href) ||
    (meta.tag === "input" && (meta.type === "button" || meta.type === "submit"));

  let score = 0;
  if (isButtonish) score += 4;
  if (inViewport) score += 3;
  if (box) score += 1;
  const y = box?.y ?? 1e9;
  score += Math.max(0, 2 - y / 600);

  return { ok: true as const, score, y, meta: { ...meta, inViewport, box } };
}

// TOTO NAJDE ELEMENT V RAMCI JEDNEHO FRAMU
async function findInFrame(frame: any, text: string, exact: boolean) {
  const strategies: Array<() => any> = [
    () => (exact ? frame.getByText(text, { exact: true }) : frame.getByText(text)),
    () => (exact ? frame.getByRole("button", { name: text, exact: true }) : frame.getByRole("button", { name: text })),
    () => {
      const rx = exact
        ? new RegExp(`^\\s*${escapeRegex(text)}\\s*$`, "i")
        : new RegExp(escapeRegex(text), "i");
      return frame.locator(`text=${rx}`);
    },
  ];

  const stripped = stripDiacritics(text);
  if (stripped !== text) {
    strategies.push(() => {
      const rx = exact
        ? new RegExp(`^\\s*${escapeRegex(stripped)}\\s*$`, "i")
        : new RegExp(escapeRegex(stripped), "i");
      return frame.locator(`text=${rx}`);
    });
  }

  for (const make of strategies) {
    try {
      const locator = make();
      const count = await locator.count().catch(() => 0);
      if (count > 0) return { locator, count };
    } catch {}
  }
  return null;
}

// TOTO NAJDE NAJLEPSI ELEMENT NAPRIEC VSETKYMI FRAMAMI
async function findBestAcrossFrames(page: any, text: string, exact: boolean) {
  const frames: any[] = [page, ...page.frames().filter((f: any) => f !== page.mainFrame())];
  const seen = new Set<any>();
  const ordered: any[] = [];
  for (const f of frames) {
    const key = f === page ? page.mainFrame() : f;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(f);
  }

  let best: { frame: any; locator: any; index: number; score: number; y: number } | null = null;

  for (const frame of ordered) {
    const found = await findInFrame(frame, text, exact);
    if (!found) continue;

    const maxScan = Math.min(found.count, 12);
    for (let i = 0; i < maxScan; i++) {
      const cand = found.locator.nth(i);
      const s = await scoreCandidate(frame, cand);
      if (!s.ok) continue;
      if (!best || s.score > best.score || (s.score === best.score && s.y < best.y)) {
        best = { frame, locator: found.locator, index: i, score: s.score, y: s.y };
      }
    }
  }

  return best;
}

// TOTO JE FALLBACK KLIK CEZ SHADOW DOM
async function shadowDomClickFallback(page: any, text: string, exact: boolean): Promise<boolean> {
  const tryClick = async (frame: any) => {
    return await frame
      .evaluate(
        ({ needle, exactMatch }: { needle: string; exactMatch: boolean }) => {
          const stripDia = (s: string) =>
            String(s ?? "")
              .normalize("NFD")
              .replace(/[̀-ͯ]/g, "");
          const norm = (s: string) => stripDia(String(s ?? "")).trim().toLowerCase();
          const target = norm(needle);
          if (!target) return false;

          const seenRoots = new Set<any>();
          const queue: any[] = [document];

          while (queue.length) {
            const root: any = queue.shift();
            if (!root || seenRoots.has(root)) continue;
            seenRoots.add(root);

            let nodes: any[] = [];
            try {
              nodes = Array.from((root.querySelectorAll?.("*") as any) ?? []);
            } catch {
              nodes = [];
            }

            for (const node of nodes) {
              if ((node as any).shadowRoot) queue.push((node as any).shadowRoot);

              const tag = String(node.tagName || "").toLowerCase();
              const role = String(node.getAttribute?.("role") || "").toLowerCase();
              const type = String(node.getAttribute?.("type") || "").toLowerCase();
              const isButtonish =
                tag === "button" ||
                role === "button" ||
                (tag === "a" && node.getAttribute?.("href")) ||
                (tag === "input" && (type === "button" || type === "submit"));
              if (!isButtonish) continue;

              const visibleText = norm(node.innerText ?? node.textContent ?? "");
              const ariaLabel = norm(node.getAttribute?.("aria-label") ?? "");
              const value = norm(node.getAttribute?.("value") ?? "");
              const matches = exactMatch
                ? visibleText === target || ariaLabel === target || value === target
                : visibleText.includes(target) || ariaLabel.includes(target) || value.includes(target);
              if (!matches) continue;

              const rect = node.getBoundingClientRect?.();
              if (!rect || rect.width < 2 || rect.height < 2) continue;
              const cs = window.getComputedStyle(node);
              if (!cs || cs.display === "none" || cs.visibility === "hidden") continue;

              try {
                node.scrollIntoView?.({ block: "center", inline: "center" });
              } catch {}
              try {
                (node as HTMLElement).click();
                return true;
              } catch {}
            }
          }
          return false;
        },
        { needle: text, exactMatch: exact }
      )
      .catch(() => false);
  };

  const frames: any[] = [page.mainFrame(), ...page.frames().filter((f: any) => f !== page.mainFrame())];
  for (const frame of frames) {
    if (await tryClick(frame)) return true;
  }
  return false;
}

// TOTO KLIKA NA ELEMENT PODLA VIDITELNEHO TEXTU
export const clickByTextTool = createTool({
  id: "browser_click_by_text",
  description: "Click first visible element with given text. Searches across iframes, shadow DOM, and is diacritic-insensitive.",
  inputSchema: z.object({
    text: z.string(),
    exact: z.boolean().optional().default(false),
    timeoutMs: z.number().int().positive().optional().default(10_000),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    matchedText: z.string().nullable(),
    matchedCount: z.number().int().optional(),
    via: z.string().optional(),
  }),

  execute: async ({ context }) => {
    const { text, exact, timeoutMs } = context;
    const page = await getPage();

    const best = await findBestAcrossFrames(page, text, exact);
    if (best) {
      const el = best.locator.nth(best.index);
      await el.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => {});
      await el.click({ timeout: timeoutMs });
      const matchedText = await el.textContent().catch(() => null);
      return { ok: true, matchedText: matchedText?.trim() ?? null, matchedCount: undefined, via: "locator" };
    }

    const clicked = await shadowDomClickFallback(page, text, exact);
    if (clicked) {
      return { ok: true, matchedText: text, matchedCount: 1, via: "shadow_dom_eval" };
    }

    throw new Error(`clickByTextTool: no element found containing text "${text}" (exact=${String(exact)}).`);
  },
});
