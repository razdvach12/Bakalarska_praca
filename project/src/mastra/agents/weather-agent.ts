import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { weatherTool } from '../tools/weather-tool';
import { createLanguageModel, DEFAULT_OPENAI_MODEL } from '../../shared/modelFactory';

// TOTO JE AGENT PRE POCASIE
export const weatherAgent = new Agent({
  name: 'Weather Agent',
  instructions: `
      You are a helpful weather assistant that provides accurate weather information and can help planning activities based on the weather.
      ...
      Use the weatherTool to fetch current weather data.
  `,
  model: createLanguageModel(DEFAULT_OPENAI_MODEL),
  tools: { weatherTool },

  memory: new Memory({
    storage: new LibSQLStore({
      url: 'file:../mastra.db',
    }),
  }),
});
