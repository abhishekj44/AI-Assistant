/* eslint-disable no-console */
require("dotenv").config({ path: ".env.local" });
require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

function ok(message) { console.log(`OK   ${message}`); }
function warn(message) { console.warn(`WARN ${message}`); }
function fail(message) { console.error(`FAIL ${message}`); process.exitCode = 1; }

function provider() {
  const value = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
  return ["gemini", "cerebras", "groq"].includes(value) ? value : "gemini";
}

async function verifyPrimaryModel() {
  const selected = provider();
  if (selected === "gemini") {
    if (!process.env.GEMINI_API_KEY) return fail("GEMINI_API_KEY is required for LLM_PROVIDER=gemini");
    try {
      const { GoogleGenAI, ThinkingLevel } = require("@google/genai");
      const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: process.env.GEMINI_API_VERSION || "v1" } });
      const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
      const config = {
        maxOutputTokens: 16,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      };
      if ((process.env.GEMINI_SERVICE_TIER || "standard").toLowerCase() === "priority") {
        config.serviceTier = "priority";
      }
      const response = await client.models.generateContent({
        model,
        contents: "Reply only with OK",
        config,
      });
      if (!response.text?.toUpperCase().includes("OK")) throw new Error("unexpected model response");
      const actualTier = response.usageMetadata?.serviceTier || process.env.GEMINI_SERVICE_TIER || "standard";
      ok(`Gemini model reachable: ${model} (tier: ${String(actualTier).toLowerCase()})`);
    } catch (error) {
      fail(`Gemini validation failed: ${error.message}`);
    }
    return;
  }

  const isCerebras = selected === "cerebras";
  const keyName = isCerebras ? "CEREBRAS_API_KEY" : "GROQ_API_KEY";
  const apiKey = process.env[keyName];
  if (!apiKey) return fail(`${keyName} is required for LLM_PROVIDER=${selected}`);
  const endpoint = isCerebras
    ? (process.env.CEREBRAS_API_URL || "https://api.cerebras.ai/v1/chat/completions")
    : (process.env.GROQ_API_URL || "https://api.groq.com/openai/v1/chat/completions");
  const model = isCerebras
    ? (process.env.CEREBRAS_MODEL || "gpt-oss-120b")
    : (process.env.GROQ_MODEL || "openai/gpt-oss-120b");
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply only with OK" }], max_completion_tokens: 16, reasoning_effort: "low" }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    ok(`${selected} model reachable: ${model}`);
  } catch (error) {
    fail(`${selected} validation failed: ${error.message}`);
  }
}


async function verifyDeepgram() {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return fail("DEEPGRAM_API_KEY is required for live transcription");
  try {
    const response = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl_seconds: 30 }),
      signal: AbortSignal.timeout(8000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.access_token) {
      const detail = payload?.err_msg || `HTTP ${response.status}`;
      if (/insufficient permissions/i.test(detail)) {
        throw new Error(`${detail} Create a Deepgram API key with Member-or-higher permission; /v1/auth/grant requires it.`);
      }
      throw new Error(detail);
    }
    ok("Deepgram short-lived token grant reachable");
  } catch (error) {
    fail(`Deepgram token validation failed: ${error.message}`);
  }
}

async function main() {
  console.log("Meeting Copilot setup verification\n");

  if (Number(process.versions.node.split(".")[0]) >= 20) ok(`Node ${process.versions.node}`);
  else fail(`Node ${process.versions.node}; Node 20+ is required`);

  const worklet = path.join(process.cwd(), "public", "worklets", "pcm-processor.js");
  fs.existsSync(worklet) ? ok("PCM AudioWorklet present") : fail("public/worklets/pcm-processor.js is missing");

  await verifyDeepgram();

  if (!process.env.GEMINI_API_KEY && provider() !== "gemini") {
    warn("GEMINI_API_KEY is not set: live answers can work, but Knowledge Pack extraction and rolling meeting memory are disabled");
  }

  if (process.env.TAVILY_API_KEY) ok("TAVILY_API_KEY configured for freshness-sensitive questions");
  else warn("TAVILY_API_KEY not set; fresh web lookup will be skipped");

  await verifyPrimaryModel();

  if (!process.exitCode) {
    console.log("\nSetup checks passed. Start with: npm run dev");
  }
}

main().catch((error) => {
  fail(error?.stack || error?.message || String(error));
});
