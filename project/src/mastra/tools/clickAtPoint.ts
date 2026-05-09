import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getPage } from "../../../playwright/browser";

// TOTO KLIKNE NA SURADNICE X Y
export const clickAtPointTool = createTool({
  id: "browser_click_at_point",
  description: "Click at specific x,y coordinates on the page viewport. Use as a last resort when CSS selectors and text matching fail.",
  inputSchema: z.object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    description: z.string().optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    clickedAt: z.object({ x: z.number(), y: z.number() }),
  }),
  execute: async ({ context }) => {
    const { x, y } = context;
    const page = await getPage();

    await page.mouse.click(x, y);
    await page.waitForTimeout(150);

    return {
      ok: true,
      clickedAt: { x, y },
    };
  },
});
