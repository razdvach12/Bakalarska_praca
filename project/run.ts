import "dotenv/config";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { uiAgent } from "./src/mastra/agents/ui-agent";

// TOTO JE TESTOVACI VSTUPNY BOD PRE UI AGENTA
async function main() {
  const url = "https://the-internet.herokuapp.com/checkboxes";
  const task = "Check the first unchecked checkbox.";

  const runtimeContext = new RuntimeContext();

  await uiAgent.tools.openPageTool.execute({
    context: { url },
    runtimeContext,
  });

  const snapshot = await uiAgent.tools.getSnapshotTool.execute({
    context: {},
    runtimeContext,
  });

  const res = await uiAgent.generate(
    JSON.stringify({ task, snapshot }),
    { runtimeContext }
  );

  const plan = JSON.parse(res.text);
  console.log("PLAN FROM LLM:", plan);

  if (!plan.done && plan.action === "click" && plan.selector) {
    await uiAgent.tools.clickTool.execute({
      context: { selector: plan.selector },
      runtimeContext,
    });
    console.log("Clicked:", plan.selector);
  } else {
    console.log("Nothing to do.");
  }
}

main().catch(console.error);
