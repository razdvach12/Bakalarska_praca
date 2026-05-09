import { google } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

type SupportedProvider = "openai" | "google";

export const DEFAULT_OPENAI_MODEL = "gpt-4.1";

function env(name: string) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

// TOTO VYTVORI OPENAI KLIENTA PODLA AZURE ALEBO STANDARD KONFIGURACIE
function createCorporateOpenAI() {
  const azureEndpoint = env("AZURE_OPENAI_ENDPOINT") ?? env("OPENAI_ENDPOINT");
  const azureDeployment = env("AZURE_OPENAI_DEPLOYMENT") ?? env("OPENAI_DEPLOYMENT") ?? env("OPENAI_DEPLOYMENT_ID");
  const azureApiVersion = env("AZURE_OPENAI_API_VERSION") ?? env("OPENAI_API_VERSION");
  const azureApiKey = env("AZURE_OPENAI_API_KEY") ?? env("OPENAI_API_KEY");

  if (azureEndpoint && azureDeployment && azureApiVersion) {
    return createOpenAICompatible({
      name: "azure-openai",
      baseURL: `${trimTrailingSlash(azureEndpoint)}/openai/deployments/${encodeURIComponent(azureDeployment)}`,
      headers: azureApiKey ? { "api-key": azureApiKey } : {},
      queryParams: { "api-version": azureApiVersion },
    });
  }

  return createOpenAI({
    baseURL: env("OPENAI_BASE_URL"),
    apiKey: env("OPENAI_API_KEY"),
  });
}

const corporateOpenAI = createCorporateOpenAI();

function detectProvider(modelName: string): SupportedProvider {
  const normalized = modelName.trim().toLowerCase();

  if (normalized.startsWith("openai/")) return "openai";
  if (normalized.startsWith("google/")) return "google";
  if (normalized.startsWith("gemini")) return "google";

  return "openai";
}

function stripProviderPrefix(modelName: string, provider: SupportedProvider) {
  const prefix = `${provider}/`;
  if (modelName.trim().toLowerCase().startsWith(prefix)) {
    return modelName.trim().slice(prefix.length).trim();
  }

  return modelName.trim();
}

export function getModelId(modelLike: unknown, fallback = DEFAULT_OPENAI_MODEL) {
  if (typeof modelLike === "string") {
    const trimmed = modelLike.trim();
    if (!trimmed) return fallback;
    const provider = detectProvider(trimmed);
    return stripProviderPrefix(trimmed, provider) || fallback;
  }

  if (modelLike && typeof modelLike === "object" && "modelId" in (modelLike as Record<string, unknown>)) {
    const raw = String((modelLike as { modelId?: unknown }).modelId ?? "").trim();
    return raw || fallback;
  }

  return fallback;
}

// TOTO VYTVORI JAZYKOVY MODEL PODLA NAZVU
export function createLanguageModel(modelName: string) {
  const rawModel = String(modelName ?? "").trim() || DEFAULT_OPENAI_MODEL;
  const provider = detectProvider(rawModel);
  const modelId = stripProviderPrefix(rawModel, provider) || DEFAULT_OPENAI_MODEL;

  return provider === "google" ? google(modelId) : corporateOpenAI(modelId);
}
