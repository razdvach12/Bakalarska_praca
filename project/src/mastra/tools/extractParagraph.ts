import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getPage } from "../../../playwright/browser";

function normalize(s: string) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

// TOTO ROZDELI TEXT NA VETY
function splitSentences(text: string) {
  const t = normalize(text);
  if (!t) return [];
  return t
    .split(/(?<=[.!?])\s+/g)
    .map((x) => normalize(x))
    .filter(Boolean);
}

// TOTO VYTIAHNE PARAGRAF Z OBSAHU STRANKY
export const extractParagraphTool = createTool({
  id: "browser_extract_paragraph",
  description:
    "Extract a paragraph from the main content. You can pick by index (supports negative), by position (first/last/second_last), or by contains keyword. Optionally return only first N sentences or a sentence slice.",
  inputSchema: z.object({
    index: z.number().int().optional().describe("Paragraph index. Supports negative (e.g., -1 last, -2 second last)."),
    position: z.enum(["first", "last", "second_last"]).optional(),
    contains: z.string().optional().describe("Pick the first paragraph that contains this substring (case-insensitive)."),

    firstNSentences: z.number().int().min(1).max(10).optional().describe("Return only first N sentences."),
    sentenceFrom: z.number().int().min(0).optional().describe("Start sentence index (0-based)."),
    sentenceTo: z.number().int().min(0).optional().describe("End sentence index (inclusive)."),

    scope: z.enum(["auto", "wikipedia", "generic"]).optional().default("auto"),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    url: z.string(),
    paragraphIndex: z.number().int(),
    paragraphText: z.string(),
    selectedText: z.string(),
    sentenceCount: z.number().int(),
    paragraphsCount: z.number().int(),
  }),
  execute: async ({ context }) => {
    const page = await getPage();
    const url = page.url();

    const scope = context.scope ?? "auto";

    // TOTO NAJDE PARAGRAFY NA STRANKE
    let locator = page.locator("#mw-content-text .mw-parser-output > p");
    let count = await locator.count().catch(() => 0);

    if (scope === "generic" || (scope === "auto" && count === 0)) {
      locator = page.locator("main p, article p, body p");
      count = await locator.count().catch(() => 0);
    }

    if (count === 0) {
      throw new Error("No paragraphs found on the page.");
    }

    const max = Math.min(count, 120);
    const paras: string[] = [];
    for (let i = 0; i < max; i++) {
      const t = normalize(await locator.nth(i).innerText().catch(() => ""));
      if (t.length >= 40) paras.push(t);
    }

    if (paras.length === 0) {
      throw new Error("Paragraphs were found but all were empty/too short after filtering.");
    }

    // TOTO VYBERA POZADOVANY PARAGRAF
    let idx: number | null = null;

    if (typeof context.contains === "string" && context.contains.trim()) {
      const needle = context.contains.toLowerCase();
      idx = paras.findIndex((p) => p.toLowerCase().includes(needle));
      if (idx === -1) idx = null;
    }

    if (idx === null && typeof context.position === "string") {
      if (context.position === "first") idx = 0;
      if (context.position === "last") idx = paras.length - 1;
      if (context.position === "second_last") idx = Math.max(0, paras.length - 2);
    }

    if (idx === null && typeof context.index === "number") {
      idx = context.index < 0 ? paras.length + context.index : context.index;
    }

    if (idx === null) idx = 0;
    if (idx < 0 || idx >= paras.length) {
      throw new Error(`Paragraph index out of range. Got ${idx}, available 0..${paras.length - 1}`);
    }

    const paragraphText = paras[idx];

    // TOTO VYBERA POZADOVANE VETY
    const sentences = splitSentences(paragraphText);
    const sentenceCount = sentences.length;

    let selectedText = paragraphText;

    if (typeof context.firstNSentences === "number") {
      selectedText = sentences.slice(0, context.firstNSentences).join(" ");
    } else if (typeof context.sentenceFrom === "number" || typeof context.sentenceTo === "number") {
      const from = context.sentenceFrom ?? 0;
      const to = context.sentenceTo ?? Math.max(0, sentenceCount - 1);
      selectedText = sentences.slice(from, to + 1).join(" ");
    }

    selectedText = normalize(selectedText);

    return {
      ok: true,
      url,
      paragraphIndex: idx,
      paragraphText,
      selectedText,
      sentenceCount,
      paragraphsCount: paras.length,
    };
  },
});
