import "dotenv/config";
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { weatherWorkflow } from './workflows/weather-workflow';
import { uiLoopWorkflow } from "./workflows/ui-loop";
import { weatherAgent } from './agents/weather-agent';
import { uiAgent } from "./agents/ui-agent";
import { toolCallAppropriatenessScorer, completenessScorer, translationScorer } from './scorers/weather-scorer';

// TOTO JE HLAVNA MASTRA INSTANCIA S WORKFLOWMI A AGENTMI
export const mastra = new Mastra({
  workflows: { weatherWorkflow,
                uiLoopWorkflow },
  agents: { weatherAgent,
            uiAgent, },
  storage: new LibSQLStore({
    url: ":memory:",
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  telemetry: {
    enabled: false,
  },
  observability: {
    default: { enabled: true },
  },
});
