import assert from "node:assert/strict";
import test from "node:test";

import { loadOllamaConfig, OllamaAdvisor } from "../src/llm/ollama.js";

test("Ollama is optional and defaults to the installed local model", () => {
  assert.deepEqual(loadOllamaConfig({}), {
    enabled: false,
    url: "http://127.0.0.1:11434",
    model: "qwen2.5:7b",
    timeoutMs: 15_000,
  });
});

test("returns a bounded advisory without changing deterministic evidence", async () => {
  let requestBody;
  const advisor = new OllamaAdvisor(
    {
      enabled: true,
      url: "http://ollama.test",
      model: "qwen2.5:7b",
      timeoutMs: 1_000,
    },
    async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              summary: "Revenue changes beyond the configured threshold.",
              risk: "critical",
              recommendations: ["Preserve percentage normalization."],
            }),
          },
        }),
      );
    },
  );

  const result = await advisor.summarize({
    deterministicDecision: "failure",
    metricDelta: -24.75,
  });

  assert.equal(result.available, true);
  assert.equal(result.advisory, true);
  assert.equal(result.risk, "critical");
  assert.equal(requestBody.stream, false);
  assert.equal(requestBody.options.temperature, 0);
});

test("malformed or unavailable model output degrades safely", async () => {
  const advisor = new OllamaAdvisor(
    {
      enabled: true,
      url: "http://ollama.test",
      model: "qwen2.5:7b",
      timeoutMs: 1_000,
    },
    async () =>
      new Response(
        JSON.stringify({ message: { content: "not json" } }),
      ),
  );

  const result = await advisor.summarize({ deterministicDecision: "success" });
  assert.equal(result.available, false);
  assert.equal(result.advisory, true);
  assert.match(result.warning, /Ollama advisory unavailable/);
});
