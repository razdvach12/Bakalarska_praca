import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getPage } from "../../../playwright/browser";

// TOTO SCROLLUJE STRANKU
export const scrollTool = createTool({
  id: "browser_scroll",
  description: "Scroll the page to top, bottom, or by pixels to find elements.",
  inputSchema: z.object({
    direction: z.enum(["top", "bottom", "down", "up"]),
    pixels: z.number().optional().default(500),
    amount: z.number().optional(),
  }),
  outputSchema: z.object({ ok: z.boolean(), deltaY: z.number().optional() }),
  execute: async ({ context }) => {
    const page = await getPage();
    const { direction } = context;
    const pixels = typeof context.amount === "number" ? context.amount : context.pixels;

    const beforeY = await page.evaluate(() => window.scrollY).catch(() => 0);

    if (direction === "top") {
      await page.evaluate(() => window.scrollTo(0, 0));
    } else if (direction === "bottom") {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    } else if (direction === "down") {
      await page.mouse.wheel(0, pixels);
    } else if (direction === "up") {
      await page.mouse.wheel(0, -pixels);
    }

    await page.waitForTimeout(400);

    const afterY = await page.evaluate(() => window.scrollY).catch(() => beforeY);
    return { ok: true, deltaY: afterY - beforeY };
  },
});
