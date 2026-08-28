# AI Meeting Copilot

Low-latency, speaker-aware meeting/interview assistant built with Next.js, Deepgram streaming STT, a local Candidate Knowledge Pack, and pluggable LLM inference.

## What changed from the previous architecture

The latency-critical answer path no longer uses Pinecone, query embeddings, a question-extraction LLM, or a reranker.

```text
System audio ──> Deepgram ──> INTERVIEWER turns ──┐
                                                  ├─> structured conversation state
Microphone (optional) ──> Deepgram ──> ME turns ─┘
                                                        │
                         rolling meeting memory <───────┤  (background only)
                                                        │
Resume/JD/projects ──> one-time extraction ──> Candidate Knowledge Pack
Prepared Q&A ──> local Q&A Bank ──> top-match guidance ────────────┤
                                                        │
                                           Generate Answer
                                                        │
                         QuestionBundle + AnswerContract (local only)
                                                        │
                               Evidence Capsule selection (in-process)
                                                        │
                            optional fresh-web lookup only when required
                                                        │
                                   Gemini / Cerebras / Groq
                                                        │
                                          typed SSE stream
                                                        │
                              TTFT + tokens/sec + total latency
```

## Core design decisions

- **Optional dual-speaker transcription:** system audio is always tagged `interviewer`; microphone audio is tagged `me` only when the user enables **Capture my microphone**. Interviewer-only mode never requests microphone permission.
- **Structured turns, not raw transcript strings:** every utterance has an ID, sequence, speaker, timestamps and confidence.
- **QuestionBundle reconstruction:** long interviewer scenarios survive natural pauses; Generate Answer separates the actual ask from the scenario constraints without a question-extraction LLM.
- **Deterministic AnswerContract:** complex troubleshooting/architecture requests get diagnosis, implementation, validation, a relevant project example, and a trade-off without adding another model call.
- **Candidate Knowledge Pack:** resume/JD/project documents are converted once into compact factual structured context, including source-supported project examples and search-only answer hooks.
- **No vector DB on the normal answer path:** local lexical selection chooses the most relevant projects/experience in milliseconds.
- **Optional Prepared Q&A guidance:** a separate local Q&A Bank can provide high-value answer/key-point guidance; only the top matches are injected, and Candidate Knowledge remains authoritative for personal facts.
- **Follow-up aware selection:** recent conversation, current meeting topic and entities are included in local relevance matching, so questions like “why did you choose that?” can resolve the referenced project.
- **Background meeting memory:** every few finalized turns, a compact summary/facts/entities state is refreshed without blocking Generate Answer.
- **Strict web routing:** Tavily is called only for explicit freshness signals such as “latest”, “today”, or “current version”.
- **Dynamic live-answer length:** simple questions stay short, while architecture/troubleshooting/project questions can expand when needed for diagnosis, validation and implementation clarity.
- **Evidence Capsule:** a strong project match sends the protected project example/decision rather than broad unrelated profile data.
- **Versioned core prompt rules:** user settings can change style, but cannot replace V9 quality/grounding rules.
- **Session-aware depth:** Company / Call Type / Details are passed as small bounded context on Generate Answer.
- **Approved-answer learning:** generated history stays separate from Prepared Q&A; only a user-marked Good answer can be promoted.
- **Provider abstraction:** Gemini is the default; Cerebras and Groq can be selected with environment variables for latency benchmarking.
- **No retry sleeps:** only transient 429/5xx/network startup failures can fail over, and the critical path is capped at two provider/model attempts.
- **Measured performance:** the UI displays client TTFT, server generation throughput, end-to-end latency, the actual provider/model used, and a fine-grained latency breakdown across app, model startup/prefill and generation.
- **In-process Knowledge Pack cache:** repeated answer requests avoid re-reading/parsing an unchanged Candidate Knowledge Pack from disk.
- **Optional Gemini Priority tier:** set `GEMINI_SERVICE_TIER=priority` to benchmark Google's lower-latency priority queue; Standard remains the default because Priority is premium-priced.

## Requirements

- Node.js 20–22
- Chrome or Edge recommended for system-audio sharing
- Deepgram API key with Member-or-higher permission so the server can grant short-lived browser JWTs
- Gemini API key for the default answer model
- Gemini API key is also currently used for one-time Knowledge Pack extraction and background meeting-memory updates
- Optional Tavily key for current/fresh web facts
- Optional Cerebras/Groq key if benchmarking those inference providers

## Setup

```bash
cp .env.example .env.local
npm install
npm run verify-setup
npm run dev
```

Open `http://localhost:3000`.

`package-lock.json` is preserved from the supplied working baseline. Prefer `npm ci` for a reproducible install; use `npm install` only when intentionally changing dependencies.

## Environment

Minimum configuration:

```env
DEEPGRAM_API_KEY="..."
LLM_PROVIDER="gemini"
GEMINI_API_KEY="..."
GEMINI_MODEL="gemini-3.6-flash"
GEMINI_THINKING_LEVEL="minimal"
GEMINI_SERVICE_TIER="standard"
```

For Cerebras:

```env
LLM_PROVIDER="cerebras"
CEREBRAS_API_KEY="..."
CEREBRAS_MODEL="gpt-oss-120b"
```

For Groq:

```env
LLM_PROVIDER="groq"
GROQ_API_KEY="..."
GROQ_MODEL="openai/gpt-oss-120b"
```

See `.env.example` for all tuning options.

## First-run workflow

1. Open **Candidate Knowledge Pack**.
2. Upload your resume as `Resume / CV`, or use **Import pack** to install a refined Candidate Knowledge Pack JSON directly.
3. Upload the target job description as `Job description`.
4. Add important project docs/notes if the resume does not contain enough architectural detail.
5. Optional: add a few high-value items under **Prepared Q&A Guidance**, or import a compatible JSON bank.
6. Open **Prompt & Persona** and add only extra facts/style preferences that are not already captured in the Knowledge Pack.
7. Click **Connect Audio**.
8. In the browser share picker, enable system/tab audio so remote participants are captured.
9. Optional: enable **Capture my microphone** before connecting if you want your own answers included in follow-up context.
10. After the interviewer asks a question, click **Generate Answer** or press `Ctrl+Enter`.


### Transcription modes

- **Interviewer-only (default):** captures shared/system audio only. No microphone permission is requested.
- **Dual-speaker (optional):** enable **Capture my microphone** before connecting. If permission is denied or microphone STT fails, the interviewer stream continues and the UI shows a non-blocking warning.
- Deepgram browser JWT creation is independent of microphone permission. `/api/deepgram` uses `/v1/auth/grant`, so `DEEPGRAM_API_KEY` must have Member-or-higher permission.

## Candidate Knowledge Pack

Knowledge is stored locally on the application server in:

```text
data/candidate-knowledge.json
```

That file is git-ignored because it can contain personal/company information.

The one-time extractor records:

- profile/headline/strengths
- target role/JD requirements
- work experience
- projects
- technologies
- design decisions and rationale when explicitly stated
- challenges/solutions/results
- metrics and achievements
- durable factual notes
- source-supported compact project examples
- search-only `answerHooks` used to recognize paraphrases such as VLM / vision agent / perception worker

The answer model is explicitly instructed not to invent personal facts that are absent from this pack, candidate notes or the live conversation.

## Prepared Q&A Bank

Prepared Q&A is optional and remains separate from Candidate Knowledge. It is stored locally at `data/qa-bank.json` and is git-ignored. Only the top local matches are passed to the model; the entire bank is never added to the prompt.

Use it for high-value personal/architecture questions where you care about specific framing or key points. The model still answers unseen questions from Candidate Knowledge, live conversation and its general technical knowledge. Candidate Knowledge and Candidate Notes outrank Prepared Q&A when factual claims conflict.

See `docs/QA_BANK.md` and `data/qa-bank.example.json`.

## Latency telemetry

The response stream uses typed Server-Sent Events:

```text
event: meta
event: delta
event: sources
event: metrics
event: done
event: error
```

Metrics available under **Diagnostics -> Metrics**:

- **TTFT:** browser click until first visible answer chunk
- **Throughput:** output tokens divided by generation time; marked `~` when token usage is estimated
- **Total:** browser click until the stream is fully consumed
- **Model:** provider/model that served the request
- **HTTP headers / First SSE:** whether the browser is waiting for the server before streaming starts
- **Server pre-model:** all backend work before the LLM request begins
- **Model connect:** time awaiting provider stream creation
- **First chunk wait:** delay after stream creation until the provider yields its first chunk
- **Model wait total:** model connect + first-chunk delay; the most useful indicator for queue/prefill latency
- **Request/knowledge/Q&A/context/prompt/web phase timings**
- **Input, cached-input, thinking and output token counts** when exposed by the provider
- **Provider attempts, requested service tier and thinking level**

The UI also labels the likely bottleneck for each request. The server continues logging one `completion.metrics` JSON object per completed request for P50/P95 analysis.

## Performance tuning order

1. Keep `GEMINI_THINKING_LEVEL=minimal` for the default fast path; use `low` only if quality tests justify it.
2. Keep simple answers short; allow architecture/project answers to expand as needed; troubleshooting architecture defaults to roughly 125–185 words for diagnosis, validation and trade-off clarity.
3. Keep `CANDIDATE_CONTEXT_MAX_CHARS` around 4,200. V8 protects the top relevant project example before dropping secondary context; do not increase the budget unless diagnostics show missing evidence.
4. Keep web lookup disabled for non-fresh questions.
5. First inspect **Model wait total**, input tokens and cache-hit percentage. If model wait dominates, benchmark `GEMINI_SERVICE_TIER=priority` and alternate providers.
6. Benchmark provider/model choices using real interview questions and compare P50/P95 TTFT, tokens/sec and answer quality.
7. Add retrieval/vector search only if the knowledge corpus becomes large enough that local selection can no longer provide accurate context.

## API surface

| Endpoint | Purpose |
|---|---|
| `POST /api/completion` | streamed answer/summarization |
| `GET/POST/PUT/DELETE /api/knowledge` | inspect/build/import/remove Candidate Knowledge |
| `GET/POST/PUT/DELETE /api/qa-bank` | inspect/add/import/remove Prepared Q&A guidance |
| `GET/POST/PATCH/PUT /api/qa-history` | generated-answer review, feedback and approved promotion |
| `POST /api/memory` | asynchronous compact meeting-memory refresh |
| `GET /api/deepgram` | short-lived browser transcription JWT |
| `GET /api/health` | configuration/health summary |
| `GET/POST /api/sessions` | local session persistence |

## Project structure

```text
app/api/completion/        answer orchestration + SSE telemetry
app/api/knowledge/         Candidate Knowledge Pack ingestion
app/api/qa-bank/           Prepared Q&A persistence/import API
app/api/memory/            background meeting-memory refresh
app/api/deepgram/          ephemeral Deepgram credential
components/copilot.tsx     answer UI + TTFT measurement
components/recorder.tsx    required system audio + optional microphone capture
lib/audio/                 PCM AudioWorklet transport
lib/transcriptStateMachine speaker-aware turn state
lib/question/              QuestionBundle + deterministic AnswerContract
lib/knowledge/             knowledge schema + Evidence Capsule selection
lib/qa/                    Q&A schema + local matching
lib/server/                knowledge extraction + persistence
lib/llm/                   Gemini/Cerebras/Groq provider abstraction
public/worklets/           browser PCM downsampler
```

## Validation

```bash
npm run verify-setup
npm run typecheck
npm run smoke
npm run build
```

`npm run smoke` exercises transcript boundaries, long-scenario QuestionBundle reconstruction, AnswerContract classification, Evidence Capsule selection, Prepared Q&A matching, prompt-rule isolation/SessionInfo injection, and STT terminology without external APIs.

For actual performance evaluation, collect at least 50–100 representative questions and compare **P50/P95 TTFT, P50/P95 throughput, factual correctness, personalization accuracy and hallucination rate**. Do not select a provider from tokens/sec alone.

## Deployment notes

The current persistence layer intentionally uses the local filesystem because this project is being optimized first for a single-user/local or persistent-host deployment. Before horizontal/serverless scale-out, replace `lib/server/knowledgeStore.ts` and local session storage with a shared durable store (PostgreSQL/object storage/Redis as appropriate). The LLM and transcript layers are already separated from that storage implementation.

## V9 answer-quality pipeline

V9 fixes the pre-model quality bottleneck without adding another inference call. Generate Answer reconstructs a full interviewer `QuestionBundle`, derives a deterministic `AnswerContract`, selects a compact Evidence Capsule, and injects SessionInfo before the single answer-model stream. Immutable quality rules cannot be replaced by stale browser prompt settings.

Generated Q&A history is now reviewable: mark answers **Good** or **Poor**; only Good answers can be explicitly promoted to Prepared Q&A.

See `PATCH_NOTES_V9.md` and `docs/ANSWER_QUALITY_PIPELINE.md`.

## V8 evidence-aware context

V8 protects the highest-value real project evidence instead of simply minimizing characters. Projects can carry search-only `answerHooks` and source-supported compact `examples`. Architecture/scenario answers dynamically expand when useful and include one relevant real project reference when the Knowledge Pack supports it.

Use **Diagnostics → Context** to see the protected project, match score, selected project example, answer mode, and exact context sent to the model.

See `PATCH_NOTES_V8.md` and `docs/PROJECT_EVIDENCE.md`.

## V7 live-meeting optimizations

V7 keeps the primary meeting screen intentionally small. Open **Knowledge & Q&A** only when managing sources, and **Diagnostics** only when inspecting context/latency. Generate Answer now uses a compact dynamic candidate-context budget and exposes the exact model context/Q&A matches through the Diagnostics drawer.

See `PATCH_NOTES_V7.md` and `docs/CONTEXT_INSPECTOR.md`.

## V10 call-type prompt profiles

V10 requires a call mode before audio starts: **Giving Interview**, **Taking Interview**, or **Meeting**. The selected mode changes the Generate behavior, rolling-memory prompt, summarizer prompt, UI labels, and which context sources are allowed on the critical path.

All prompt wording is maintained under `lib/prompts/`; see `docs/PROMPT_PROFILES.md`.

Question reconstruction confidence is now visible on the main screen. `HIGH` trusts the reconstructed ask, `MEDIUM` combines it with the full scenario, and `FALLBACK` makes the scenario authoritative. This is implemented deterministically and adds no model/API hop.
