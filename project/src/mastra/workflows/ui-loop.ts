import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";

const workflowInputSchema = z.object({
  url: z.string().url(),
  task: z.string(),
  maxSteps: z.number().int().positive().optional(),
});

const workflowOutputSchema = z.object({
  done: z.boolean(),
  reason: z.string().optional(),
  history: z.array(z.any()).optional(),
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// TOTO VOLA AGENTA S BACKOFF PRI RATE LIMIT
async function generateWithBackoff(
  agent: any,
  payload: string,
  runtimeContext: any,
  attempts = 4
) {
  let delay = 1200;
  for (let i = 0; i < attempts; i++) {
    try {
      return await agent.generate(payload, { runtimeContext });
    } catch (e: any) {
      const msg = e?.message ?? "";
      if (!msg.includes("rate_limit_exceeded") && !msg.includes("429")) {
        throw e;
      }
      await sleep(delay + Math.floor(Math.random() * 400));
      delay *= 2;
    }
  }
  throw new Error("Rate limited too many times.");
}

// TOTO BEZI SLUCKU OBSERVE-PLAN-ACT
const uiLoopStep = createStep({
  id: "ui_loop_step",
  description: "Runs observe→plan→act loop with uiAgent",
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema,

  execute: async ({ inputData, mastra, runtimeContext }) => {
    try {
      const { url, task } = inputData;
      const maxSteps = inputData.maxSteps ?? 12;

      const agent = mastra.getAgent("uiAgent");
      if (!agent) {
        return { done: false, reason: "uiAgent not found", history: [] };
      }

      const history: any[] = [];

      await agent.tools.openPageTool.execute({
        context: { url },
        runtimeContext,
      });

      for (let i = 0; i < maxSteps; i++) {
        const snapshot = await agent.tools.getSnapshotTool.execute({
          context: {},
          runtimeContext,
        });

        const res = await generateWithBackoff(
          agent,
          JSON.stringify({ task, snapshot, history }),
          runtimeContext
        );

        let plan: any;
        try {
          plan = JSON.parse(res.text);
        } catch {
          history.push({ snapshot, raw: res.text });
          return {
            done: false,
            reason: "Agent did not return valid JSON",
            history,
          };
        }

        history.push({ snapshot, plan });

        if (plan.done) {
          return { done: true, history };
        }

        // TOTO VYKONA AKCIU PODLA PLANU AGENTA
        if (plan.action === "click" && plan.selector) {
          await agent.tools.clickTool.execute({
            context: { selector: plan.selector },
            runtimeContext,
          });

        } else if (plan.action === "clickByText" && plan.text) {
          await agent.tools.clickByTextTool.execute({
            context: { text: plan.text, exact: true },
            runtimeContext,
          });

        } else if (plan.action === "type" && plan.selector && plan.text) {
          await agent.tools.typeTool.execute({
            context: { selector: plan.selector, text: plan.text },
            runtimeContext,
          });

        } else if (plan.action === "wait" && plan.selector) {
          await agent.tools.waitForTool.execute({
            context: { selector: plan.selector },
            runtimeContext,
          });

        } else {
          return {
            done: false,
            reason: "No valid action from agent",
            history,
          };
        }

        await sleep(800);
      }

      return { done: false, reason: "maxSteps reached", history };
    } catch (e: any) {
      return {
        done: false,
        reason: `Workflow crashed: ${e?.message ?? String(e)}`,
        history: [],
      };
    }
  },
});

export const uiLoopWorkflow = createWorkflow({
  id: "ui_loop",
  description: "Agentic UI loop workflow",
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema,
})
  .then(uiLoopStep)
  .commit();
