import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getPage } from "../../../playwright/browser";

// TOTO STLACI KLAVES NA KLAVESNICI
export const pressKeyTool = createTool({
  id: "browser_press_key",
  description: "Press a keyboard key (Enter, Escape, Tab, ArrowDown, etc.)",
  inputSchema: z.object({
    key: z.string(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
  }),
  execute: async ({ context }) => {
    const page = await getPage();
    await page.keyboard.press(context.key);
    await page.waitForTimeout(100);
    return { ok: true };
  },
});
