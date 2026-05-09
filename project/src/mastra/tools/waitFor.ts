import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getPage } from "../../../playwright/browser";

// TOTO ZISTI CI SELEKTOR NIE JE FALOSNY
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

// TOTO CAKA NA ELEMENT V DOM
export const waitForTool = createTool({
  id: "browser_wait_for",
  description:
    "Wait for a selector. Default is attached (fast, tolerant). Use state=visible only when truly needed before interaction.",
  inputSchema: z.object({
    selector: z.string(),
    timeoutMs: z.number().int().positive().optional().default(2500),
    state: z.enum(["attached", "visible", "hidden", "detached"]).optional().default("attached"),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async ({ context }) => {
    const { selector, timeoutMs, state } = context;
    const page = await getPage();
    if (isSyntheticSelector(selector)) {
      throw new Error(`waitForTool rejected synthetic selector "${selector}".`);
    }

    await page.locator(selector).first().waitFor({ state, timeout: timeoutMs });
    return { ok: true };
  },
});
