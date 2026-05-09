import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getPage } from "../../../playwright/browser";

// TOTO OTVORI URL V PREHLIADACI
export const openPageTool = createTool({
  id: "browser_open_page",
  description: "Open a given URL in the browser and wait for initial DOM load (fast).",
  inputSchema: z.object({
    url: z.string().url(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    url: z.string(),
  }),

  execute: async ({ context }) => {
    const page = await getPage();
    await page.addInitScript(() => {
      // @ts-ignore
      globalThis.__name = globalThis.__name || ((target: any) => target);
    });
    await page.evaluate("globalThis.__name = globalThis.__name || ((target) => target);");
    const { url } = context;

    await page.addInitScript(() => {
      var __name = function (target: any, value: string) {
        try {
          Object.defineProperty(target, "name", { value, configurable: true });
        } catch {}
        return target;
      };
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(200);

    return { ok: true, url: page.url() };
  },
});
