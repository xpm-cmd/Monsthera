import type { MonstheraConfig } from "../config.js";
import type { TextGenerator } from "../text-generator.js";
import type { LLMSummarizer } from "../../sessions/llm-summarizer.js";

import { OllamaTextGenerator, OpenAITextGenerator, StubTextGenerator } from "../text-generator.js";
import { OllamaSummarizer } from "../../sessions/llm-summarizer.js";

/**
 * Select the session-handoff LLM summarizer: `OllamaSummarizer` when
 * `sessions.llmEnabled`, otherwise `null` (the session service then falls
 * back to T1-only handoffs).
 */
export function createSessionSummarizer(deps: { config: MonstheraConfig }): LLMSummarizer | null {
  const { config } = deps;
  return config.sessions.llmEnabled
    ? new OllamaSummarizer({
        ollamaUrl: config.search.ollamaUrl,
        model: config.sessions.llmModel,
        temperature: config.sessions.llmTemperature,
        timeoutMs: config.sessions.llmTimeoutMs,
      })
    : null;
}

/**
 * General-purpose text generator (PR-3): provider-pluggable; consumed by
 * think synthesis (PR-5) and work→knowledge distillation (PR-6). The API key
 * is read from env only, never from the validated config object.
 */
export function createTextGenerator(deps: { config: MonstheraConfig }): TextGenerator {
  const { config } = deps;
  let textGenerator: TextGenerator;
  if (!config.llm.enabled) {
    textGenerator = new StubTextGenerator();
  } else if (config.llm.provider === "openai") {
    const apiKey = process.env["MONSTHERA_LLM_API_KEY"] ?? process.env["OPENAI_API_KEY"] ?? "";
    textGenerator = new OpenAITextGenerator({
      baseUrl: config.llm.baseUrl,
      apiKey,
      model: config.llm.model,
      temperature: config.llm.temperature,
      timeoutMs: config.llm.timeoutMs,
    });
  } else {
    textGenerator = new OllamaTextGenerator({
      ollamaUrl: config.search.ollamaUrl,
      model: config.llm.model,
      temperature: config.llm.temperature,
      timeoutMs: config.llm.timeoutMs,
    });
  }
  return textGenerator;
}
