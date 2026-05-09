import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getPage } from "../../../playwright/browser";

// TOTO ZISTI CI NIE JE SELEKTOR FALOSNY
function isSyntheticSelector(selector: string) {
  const value = String(selector ?? "").trim().toLowerCase();
  return (
    value.startsWith("text=") ||
    value.startsWith("xpath=") ||
    value.startsWith("//") ||
    value.startsWith("role=") ||
    value.startsWith("getbyrole(") ||
    value.includes(">>") ||
    value.includes(":contains(") ||
    value.includes(":has-text(") ||
    value.includes("nth=")
  );
}

// TOTO KLIKNE NA ELEMENT PODLA SELEKTORA
export const clickTool = createTool({
  id: "browser_click",
  description: "Click an element by selector with short retries.",
  inputSchema: z.object({
    selector: z.string(),
    timeoutMs: z.number().int().positive().optional().default(6000),
    force: z.boolean().optional().default(false),
    expectNavigation: z.boolean().optional().default(false),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
  }),
  execute: async ({ context }) => {
    const { selector, timeoutMs, force } = context;

    if (!selector) {
      throw new Error("clickTool: context.selector is undefined");
    }
    if (isSyntheticSelector(selector)) {
      throw new Error(`clickTool rejected synthetic selector "${selector}".`);
    }

    const page = await getPage();
    const maxAttempts = 2;

    const pickTarget = async () => {
      const matches = page.locator(selector);
      const count = await matches.count().catch(() => 0);
      if (count <= 1) {
        return {
          locator: matches.first(),
          count,
          visibleMatches: count === 1 ? 1 : 0,
        };
      }

      let firstVisibleIndex = -1;
      let visibleMatches = 0;

      for (let i = 0; i < count; i++) {
        const candidate = matches.nth(i);
        const visible = await candidate.isVisible().catch(() => false);
        const enabled = await candidate.isEnabled().catch(() => false);
        const box = await candidate.boundingBox().catch(() => null);

        if (visible) visibleMatches++;
        if (firstVisibleIndex === -1 && visible && enabled && box) {
          firstVisibleIndex = i;
        }
      }

      if (firstVisibleIndex >= 0) {
        return {
          locator: matches.nth(firstVisibleIndex),
          count,
          visibleMatches,
        };
      }

      return {
        locator: matches.first(),
        count,
        visibleMatches,
      };
    };

    const debugInfo = async () => {
      const url = page.url();
      const chosen = await pickTarget();
      const visible = await chosen.locator.isVisible().catch(() => false);
      const enabled = await chosen.locator.isEnabled().catch(() => false);
      const box = await chosen.locator.boundingBox().catch(() => null);
      return { url, count: chosen.count, visibleMatches: chosen.visibleMatches, visible, enabled, box };
    };

    let lastErr: any = null;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const chosen = await pickTarget();
        const loc = chosen.locator;

        await loc.waitFor({ state: "attached", timeout: timeoutMs });
        await loc.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => {});
        await loc.click({ timeout: timeoutMs, trial: true }).catch(() => {});
        await loc.click({ timeout: timeoutMs });
        return { ok: true };
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message ?? e);
        const chosen = await pickTarget();
        const loc = chosen.locator;

        const shouldTryForce =
          force ||
          msg.includes("intercepts pointer") ||
          msg.includes("not receiving pointer events") ||
          msg.includes("Element is not visible") ||
          msg.includes("Element is outside of the viewport") ||
          msg.includes("has been detached") ||
          msg.includes("Timeout");

        if (shouldTryForce) {
          try {
            await loc.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => {});
            await loc.click({ timeout: timeoutMs, force: true });
            return { ok: true };
          } catch (e2: any) {
            lastErr = e2;
          }
        }

        await page.waitForTimeout(80);
      }
    }

    const dbg = await debugInfo();
    throw new Error(
      `clickTool failed for selector "${selector}" after ${maxAttempts} attempts. ` +
        `url=${dbg.url} count=${dbg.count} visibleMatches=${dbg.visibleMatches} visible=${dbg.visible} enabled=${dbg.enabled} ` +
        `box=${dbg.box ? JSON.stringify(dbg.box) : "null"}. Last error: ${String(lastErr?.message ?? lastErr)}`
    );
  },
});
