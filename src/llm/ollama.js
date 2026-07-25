const DEFAULT_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen2.5:7b";
const MAX_EVIDENCE_CHARS = 20_000;

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(`Expected a boolean but received "${value}"`);
}

export function loadOllamaConfig(env = process.env) {
  const url = new URL(env.OLLAMA_URL ?? DEFAULT_URL);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("OLLAMA_URL must use http or https");
  }
  const timeoutMs = Number(env.OLLAMA_TIMEOUT_MS ?? 15_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new Error("OLLAMA_TIMEOUT_MS must be between 100 and 120000");
  }
  return {
    enabled: parseBoolean(env.OLLAMA_ENABLED, false),
    url: url.toString().replace(/\/$/, ""),
    model: env.OLLAMA_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs,
  };
}

function validateAdvisory(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Ollama response must be a JSON object");
  }
  if (typeof value.summary !== "string" || value.summary.length > 2_000) {
    throw new Error("Ollama summary is missing or too long");
  }
  if (!["low", "medium", "high", "critical", "unknown"].includes(value.risk)) {
    throw new Error("Ollama risk is invalid");
  }
  if (
    !Array.isArray(value.recommendations) ||
    value.recommendations.length > 5 ||
    value.recommendations.some(
      (item) => typeof item !== "string" || item.length > 500,
    )
  ) {
    throw new Error("Ollama recommendations are invalid");
  }
  return {
    advisory: true,
    summary: value.summary,
    risk: value.risk,
    recommendations: value.recommendations,
  };
}

export class OllamaAdvisor {
  constructor(
    config = loadOllamaConfig(),
    fetchImpl = fetch,
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async summarize(evidence) {
    if (!this.config.enabled) {
      return {
        available: false,
        advisory: true,
        warning: "Local Ollama advisory is disabled.",
      };
    }

    const serialized = JSON.stringify(evidence);
    if (serialized.length > MAX_EVIDENCE_CHARS) {
      return {
        available: false,
        advisory: true,
        warning: `Evidence exceeds the ${MAX_EVIDENCE_CHARS}-character Ollama limit.`,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.config.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.config.model,
          stream: false,
          format: "json",
          options: { temperature: 0 },
          messages: [
            {
              role: "system",
              content:
                "Summarize the supplied ShadowGraph evidence. Do not change the deterministic decision. Return JSON with summary, risk (low|medium|high|critical|unknown), and up to five recommendations.",
            },
            { role: "user", content: serialized },
          ],
        }),
      });
      if (!response.ok) {
        throw new Error(`Ollama returned HTTP ${response.status}`);
      }
      const payload = await response.json();
      const content = payload?.message?.content;
      if (typeof content !== "string") {
        throw new Error("Ollama response is missing message content");
      }
      return {
        available: true,
        model: this.config.model,
        ...validateAdvisory(JSON.parse(content)),
      };
    } catch (error) {
      return {
        available: false,
        advisory: true,
        warning:
          error instanceof Error
            ? `Ollama advisory unavailable: ${error.message}`
            : "Ollama advisory unavailable.",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
