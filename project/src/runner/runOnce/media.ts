import path from "node:path";

import { generateText } from "ai";

import { emit } from "../../server/sse";
import { getPage } from "../../../playwright/browser";
import { visionAgent, VISION_PROMPT } from "../../mastra/agents/vision-agent";
import { VisionNotesSchema } from "../types";
import { cleanJsonMaybe, extractModelUsage, safeLogMessage, type ModelUsage } from "./shared";

const EMPTY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+X3sAAAAASUVORK5CYII=";

// TOTO SPRAVI SCREENSHOT VIDITELNEJ CASTI STRANKY
export async function getViewportScreenshotDataUrl() {
  const page = await getPage();
  try {
    const buf = await page.screenshot({
      type: "png",
      fullPage: false,
      timeout: 5000,
      animations: "disabled",
      caret: "hide",
    });
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return `data:image/png;base64,${EMPTY_PNG_BASE64}`;
  }
}

// TOTO POSLE SCREENSHOT VIZUALNEMU AGENTOVI A VRATI POPIS
export async function visionPass(screenshotDataUrl?: string, onUsage?: (usage: ModelUsage) => void) {
  const image = screenshotDataUrl ?? (await getViewportScreenshotDataUrl());
  const messages: any[] = [
    {
      role: "user",
      content: [
        { type: "text", text: `${VISION_PROMPT}\nReturn ONLY JSON.` },
        { type: "image", image },
      ],
    },
  ];

  const res = await generateText({ model: (visionAgent as any).model, messages });
  onUsage?.(extractModelUsage(res));
  const parsed = JSON.parse(cleanJsonMaybe(res.text));
  return VisionNotesSchema.parse(parsed);
}

// TOTO SPRAVI SCREENSHOT CELEJ STRANKY DO SUBORU
export async function screenshotFullPage(runDir: string, runId: string, name: string) {
  const page = await getPage();
  const shotPathFs = path.join(runDir, name);
  let captured = false;

  try {
    await page.screenshot({
      path: shotPathFs,
      fullPage: true,
      timeout: 8000,
      animations: "disabled",
      caret: "hide",
    });
    captured = true;
  } catch (e: any) {
    emit({
      type: "log",
      runId,
      ts: Date.now(),
      message: safeLogMessage(`Full-page screenshot failed, retrying viewport shot: ${e?.message ?? String(e)}`),
    });

    try {
      await page.screenshot({
        path: shotPathFs,
        fullPage: false,
        timeout: 4000,
        animations: "disabled",
        caret: "hide",
      });
      captured = true;
      emit({
        type: "log",
        runId,
        ts: Date.now(),
        message: "Saved viewport screenshot fallback.",
      });
    } catch (fallbackError: any) {
      emit({
        type: "log",
        runId,
        ts: Date.now(),
        message: safeLogMessage(`Viewport screenshot fallback failed: ${fallbackError?.message ?? String(fallbackError)}`),
      });
    }
  }

  if (!captured) return;

  emit({
    type: "screenshot",
    runId,
    ts: Date.now(),
    path: `/runs/${runId}/${path.basename(shotPathFs)}`,
  });
}
