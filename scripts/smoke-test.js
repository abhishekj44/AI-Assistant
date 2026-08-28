#!/usr/bin/env node

/**
 * Fast pure-logic regression checks. Requires dev dependency `typescript`, but no API keys,
 * network access, browser, or Next.js server.
 */
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const moduleCache = new Map();

function loadPureTsModule(file) {
  if (moduleCache.has(file)) return moduleCache.get(file);
  const source = fs.readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText;

  const module = { exports: {} };
  moduleCache.set(file, module.exports);
  const localRequire = (id) => {
    if (id === "clsx") return { clsx: (...values) => values.filter(Boolean).join(" ") };
    if (id === "tailwind-merge") return { twMerge: (value) => value };
    if (!id.startsWith("@/")) return require(id);
    const base = id.slice(2);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
      if (fs.existsSync(candidate)) return loadPureTsModule(candidate);
    }
    throw new Error(`Unable to resolve local smoke-test module ${id}`);
  };
  const sandbox = {
    module,
    exports: module.exports,
    require: localRequire,
    console,
    Date,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(output, sandbox, { filename: file });
  moduleCache.set(file, module.exports);
  return module.exports;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function transcriptStateMachineTest() {
  const { TranscriptStateMachine } = loadPureTsModule("lib/transcriptStateMachine.ts");
  const state = new TranscriptStateMachine();
  const event = (text, isFinal = true, speechFinal = true) => ({
    channel: { alternatives: [{ transcript: text, confidence: 0.99 }] },
    is_final: isFinal,
    speech_final: speechFinal,
  });

  state.processTranscriptEvent(event("Tell me about the contract intelligence platform."), "interviewer");
  assert(state.getLatestQuestionContext().includes("contract intelligence"), "Interviewer focus turn was not resolved");

  state.processTranscriptEvent(event("I designed it as a RAG and agentic workflow."), "me");
  assert(state.getLatestQuestionContext() === "", "An already-answered interviewer question was reused");

  state.processTranscriptEvent(event("Why did you choose that architecture?", false, false), "interviewer");
  assert(state.getLatestQuestionContext().includes("Why did you choose"), "Active interviewer interim was not used");

  // Long meetings must not create an unbounded live DOM/transcript payload.
  state.finalizeCurrentUtterance("interviewer");
  for (let i = 0; i < 650; i += 1) {
    state.processTranscriptEvent(event(`Synthetic turn ${i}`), i % 2 === 0 ? "interviewer" : "me");
  }
  assert(state.getAllMessages().length <= 180, "Live transcript window exceeded its bounded UI limit");
  assert(state.getRecentFinalizedTurns(50).length <= 50, "Recent transcript retrieval exceeded its bound");
}

function contextSelectorTest() {
  const { selectCandidateContext, selectCandidateContextWithMeta } = loadPureTsModule("lib/knowledge/contextSelector.ts");
  const pack = {
    version: 1,
    updatedAt: new Date().toISOString(),
    profile: { strengths: [] },
    experience: [],
    skills: ["RAG"],
    achievements: [],
    facts: [],
    sources: [],
    projects: [
      {
        name: "Contract Intelligence",
        problem: "Analyze enterprise contracts",
        role: "Architect",
        architecture: "RAG with agentic orchestration",
        technologies: ["LangGraph", "Azure OpenAI"],
        decisions: [{ decision: "Use LangGraph", reason: "Stateful orchestration" }],
        challenges: [],
        metrics: [],
        lessons: [],
      },
      {
        name: "Vision Satellite",
        problem: "Analyze satellite imagery",
        role: "Engineer",
        architecture: "VLM pipeline",
        technologies: ["VLM"],
        decisions: [],
        challenges: [],
        metrics: [],
        lessons: [],
        answerHooks: ["VLM", "vision agent", "perception worker", "YOLO plus VLM"],
        examples: [{
          title: "Hybrid perception plus multimodal reasoning",
          situation: "Dense visual content requires specialized perception and semantic reasoning.",
          approach: "Use YOLO detection before multimodal reasoning.",
          relevance: ["VLM", "perception worker", "vision agent"],
        }],
      },
    ],
  };

  const context = selectCandidateContext(
    pack,
    "Why did you choose that?",
    "We were discussing the Contract Intelligence project and LangGraph.",
    5_000,
  );

  assert(context.includes("Contract Intelligence"), "Follow-up context did not select the referenced project");
  assert(context.length <= 5_000, "Candidate context exceeded the configured prompt budget");

  const general = selectCandidateContext(
    pack,
    "Explain speculative decoding in large language models.",
    "",
    2_000,
  );
  assert(!general.includes("Vision Satellite"), "Unrelated candidate projects leaked into a general technical question");
  assert(general.length <= 2_000, "General technical candidate context exceeded its budget");

  const vlm = selectCandidateContextWithMeta(
    pack,
    "I am the customer. I gave you a VLM and data. Design the solution with a perception worker and vision agent.",
    "",
    4_200,
  );
  assert(vlm.topProjectName === "Vision Satellite", "VLM scenario did not protect the relevant vision project");
  assert(vlm.projectEvidenceRequired === true, "Architecture scenario did not require real project evidence");
  assert(vlm.projectExampleIncluded === true, "Relevant project example was not included");
  assert(vlm.context.includes("Hybrid perception plus multimodal reasoning"), "Protected project example was dropped from context");
  assert(!vlm.context.includes('"RAG"'), "Project capsule leaked unrelated global skills into the model context");
  assert(vlm.evidenceStrategy === "project_capsule", "Strong VLM match did not use the compact project evidence capsule");
  assert(vlm.context.length <= 4_200, "Protected VLM context exceeded its budget");
}

function qaSelectorTest() {
  const { selectQAMatches, buildQAGuidance } = loadPureTsModule("lib/qa/qaSelector.ts");
  const bank = {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: [
      {
        id: "qa_rag",
        category: "architecture",
        questions: ["Why did you use RAG?", "Why did you choose RAG instead of fine tuning?"],
        answer: "We used RAG for changing knowledge, grounding, and traceability.",
        keyPoints: ["grounding", "traceability"],
        tags: ["rag", "fine-tuning"],
        personal: false,
        priority: 8,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "qa_leadership",
        category: "behavioral",
        questions: ["How do you lead teams?"],
        answer: "I align outcomes, ownership, and feedback loops.",
        keyPoints: ["ownership"],
        tags: ["leadership"],
        personal: false,
        priority: 5,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  };

  const exact = selectQAMatches(bank, "Why didn't you fine tune the model instead of using RAG?", "", 2, 8);
  assert(exact.length > 0 && exact[0].entry.id === "qa_rag", "Q&A paraphrase did not select the RAG guidance");

  const followUp = selectQAMatches(
    bank,
    "Why that approach?",
    "We were discussing a RAG architecture with retrieval augmented generation.",
    2,
    8,
  );
  assert(followUp.length > 0 && followUp[0].entry.id === "qa_rag", "Q&A follow-up did not use recent context");

  const guidance = buildQAGuidance(exact, 900);
  assert(guidance.includes("changing knowledge"), "Q&A guidance omitted the prepared answer");
  assert(guidance.length <= 1_200, "Q&A guidance exceeded its bounded test budget unexpectedly");
}

function questionBundleTest() {
  const { buildQuestionBundle } = loadPureTsModule("lib/question/questionBundle.ts");
  const base = Date.parse("2026-08-27T10:00:00.000Z");
  const texts = [
    "My VLM sees a satellite image containing 20 vehicles but reports only seven.",
    "The semantic reasoning is correct: highway, parking lot, buildings and commercial zone.",
    "The problem is the final vehicle count. What will you do in that situation so I get the correct count of 20 instead of seven?",
    "Consider this as a customer project. I already have the VLM model and data.",
    "You are the engineer and can apply whatever approach is needed to solve the problem.",
  ];
  const turns = texts.map((text, index) => ({ id: `q${index}`, speaker: "interviewer", text, timestamp: new Date(base + index * 8_000).toISOString() }));
  const bundle = buildQuestionBundle(turns, { maxInterviewerTurns: 10, maxChars: 5_500, maxSpanMs: 150_000 });
  assert(bundle && bundle.interviewerBlock.includes("20 vehicles"), "Long interviewer scenario lost the original counting constraint");
  assert(bundle && /correct count|what will you do/i.test(bundle.primaryAsk), "QuestionBundle did not recover the actual ask");
  assert(bundle && bundle.turnCount === 5, "QuestionBundle incorrectly split the scenario on pauses");
}

function answerContractTest() {
  const { inferAnswerProfile } = loadPureTsModule("lib/question/answerContract.ts");
  const profile = inferAnswerProfile(
    "What will you do in that situation so I get the correct count?",
    true,
    "Customer already has a VLM. Semantic reasoning is correct but 20 vehicles are undercounted as seven.",
  );
  assert(profile.mode === "troubleshooting_architecture", "Scenario failure was not classified as troubleshooting architecture");
  assert(profile.needsDiagnosis && profile.needsValidation && profile.needsTradeoff, "Answer contract omitted required clarity stages");
}


function promptContractTest() {
  const { buildAnswerSystemInstruction, buildAnswerPromptDetailed } = loadPureTsModule("lib/promptBuilder.ts");
  const { inferAnswerProfile } = loadPureTsModule("lib/question/answerContract.ts");
  const profile = inferAnswerProfile(
    "What will you do so the vehicle count is correct?",
    true,
    "Customer has a VLM; semantic reasoning is correct but it undercounts 20 vehicles as seven.",
  );
  const system = buildAnswerSystemInstruction(
    "- Prefer concise bullets when useful.",
    false,
    profile,
    true,
    { company: "Example Corp", callType: "giving_interview", details: "Lead AI Engineer - Round 1" },
  );
  assert(system.includes("IMMUTABLE CORE QUALITY RULES"), "User style preferences replaced the immutable quality rules");
  assert(system.includes("validation/success criteria"), "Core validation requirement is missing from the system instruction");
  assert(system.includes("Prefer concise bullets"), "Optional user style preferences were not appended");
  assert(system.includes("senior-engineer/professional depth"), "Giving Interview prompt did not influence answer depth");
  assert(system.includes("failure diagnosis") && system.includes("trade-off"), "AnswerContract sequence is missing from the system instruction");

  const prompt = buildAnswerPromptDetailed({
    candidateContext: '{"protectedProjectEvidence":{"name":"Vision Satellite"}}',
    recentTurns: [
      { id: "prior", sequenceId: 1, speaker: "me", text: "Earlier answer", timestamp: new Date().toISOString(), isInterim: false },
      { id: "current", sequenceId: 2, speaker: "interviewer", text: "What will you do so the vehicle count is correct?", timestamp: new Date().toISOString(), isInterim: false },
    ],
    question: "What will you do so the vehicle count is correct?",
    questionBundle: {
      primaryAsk: "What will you do so the vehicle count is correct?",
      scenarioContext: "Customer has a VLM that understands the scene but undercounts 20 vehicles as seven.",
      interviewerBlock: "Customer has a VLM... What will you do so the vehicle count is correct?",
      retrievalQuery: "vehicle count VLM undercount",
      turnIds: ["current"],
      turnCount: 1,
      usedActiveInterim: false,
      primaryAskConfidence: "high",
    },
    sessionInfo: { company: "Example Corp", callType: "giving_interview", details: "Lead AI Engineer - Round 1" },
    answerProfile: profile,
  });
  assert(prompt.prompt.includes("<SESSION_CONTEXT_DATA>"), "SessionInfo was not injected into the model prompt");
  assert(prompt.prompt.includes("<INTERVIEWER_SCENARIO_DATA>"), "Scenario context was not injected into the model prompt");
  assert(prompt.prompt.includes("<CURRENT_INTERVIEWER_ASK confidence=\"high\">"), "Primary ask/confidence was not separated in the model prompt");
  assert(!prompt.recentConversationText.includes("vehicle count is correct"), "Current scenario was duplicated into recent conversation context");
}

function callTypePromptTest() {
  const { getCallPromptTemplate } = loadPureTsModule("lib/prompts/index.ts");
  const { inferAnswerProfile } = loadPureTsModule("lib/question/answerContract.ts");
  const { buildAnswerPromptDetailed, buildAnswerSystemInstruction } = loadPureTsModule("lib/promptBuilder.ts");
  const { normalizeCallType } = loadPureTsModule("lib/callTypes.ts");

  assert(normalizeCallType("interview") === "giving_interview", "Legacy interview call type did not migrate");
  assert(getCallPromptTemplate({ callType: "giving_interview" }).id === "giving-interview-v10", "Giving Interview prompt registry mismatch");
  assert(getCallPromptTemplate({ callType: "taking_interview" }).id === "taking-interview-v10", "Taking Interview prompt registry mismatch");
  assert(getCallPromptTemplate({ callType: "meeting" }).id === "meeting-v10", "Meeting prompt registry mismatch");

  const fallbackBundle = {
    primaryAsk: "I worked on a RAG system.",
    scenarioContext: "",
    interviewerBlock: "I worked on a RAG system with reranking and evaluation, but the latency was high.",
    retrievalQuery: "RAG reranking evaluation latency",
    turnIds: ["candidate1"],
    turnCount: 1,
    usedActiveInterim: false,
    primaryAskConfidence: "fallback",
  };
  const takingProfile = inferAnswerProfile(fallbackBundle.primaryAsk, false, fallbackBundle.scenarioContext, "taking_interview");
  assert(takingProfile.mode === "interviewer_followup", "Taking Interview did not select interviewer follow-up contract");
  const takingPrompt = buildAnswerPromptDetailed({
    candidateContext: '{"shouldNotAppear":true}',
    background: "private candidate persona should not enter interviewer mode",
    recentTurns: [],
    question: fallbackBundle.primaryAsk,
    questionBundle: fallbackBundle,
    sessionInfo: { company: "Example Corp", callType: "taking_interview", details: "Senior AI interview" },
    answerProfile: takingProfile,
  });
  assert(takingPrompt.prompt.includes("<CANDIDATE_RESPONSE_DATA>"), "Taking Interview did not pass candidate response data");
  assert(!takingPrompt.prompt.includes("shouldNotAppear"), "Taking Interview leaked local candidate evidence");
  assert(!takingPrompt.prompt.includes("private candidate persona"), "Taking Interview leaked local persona notes");
  const takingSystem = buildAnswerSystemInstruction("", false, takingProfile, false, { company: "Example Corp", callType: "taking_interview", details: "Senior AI interview" });
  assert(takingSystem.includes("Do not answer the candidate's question for them"), "Taking Interview prompt rules are missing");

  const meetingProfile = inferAnswerProfile("Can we change the rollout plan?", false, "Production risk is high", "meeting");
  const meetingPrompt = buildAnswerPromptDetailed({
    candidateContext: "{}",
    recentTurns: [],
    question: "Can we change the rollout plan?",
    questionBundle: { ...fallbackBundle, primaryAsk: "Can we change the rollout plan?", scenarioContext: "Production risk is high", primaryAskConfidence: "medium" },
    sessionInfo: { company: "Example Corp", callType: "meeting", details: "Architecture review" },
    answerProfile: meetingProfile,
  });
  assert(meetingPrompt.prompt.includes("<CURRENT_REMOTE_ASK confidence=\"medium\">"), "Meeting prompt did not carry confidence-aware remote ask");
  const givingSystem = buildAnswerSystemInstruction("", false, inferAnswerProfile("How would you design this?", false, "", "giving_interview"), false, { company: "Example Corp", callType: "giving_interview", details: "Interview" });
  assert(givingSystem.includes("fallback: treat INTERVIEWER_SCENARIO_DATA as authoritative"), "Fallback confidence policy is not operational in Giving Interview prompt");
}

function keytermTest() {
  const { getCombinedKeyterms } = loadPureTsModule("lib/audio/keyterms.ts");
  const terms = getCombinedKeyterms("[TERM] YOLOv8\n[TERM] NVIDIA Nemotron\nLead AI Engineer working with VLM and vLLM");
  assert(terms.includes("YOLOv8"), "YOLOv8 was not preserved as an STT keyterm");
  assert(terms.some((term) => /nemotron/i.test(term)), "Nemotron was not prioritized as an STT keyterm");
  assert(terms.includes("VLM") && terms.includes("vLLM"), "VLM/vLLM terminology hints are missing");
  const overloaded = getCombinedKeyterms(Array.from({ length: 30 }, (_, index) => `[TERM] custom-${index}`).join("\n"));
  assert(overloaded.includes("VLM") && overloaded.includes("YOLOv8") && overloaded.includes("Nemotron"), "Session vocabulary crowded out mandatory high-value STT terms");
}

try {
  transcriptStateMachineTest();
  contextSelectorTest();
  qaSelectorTest();
  questionBundleTest();
  answerContractTest();
  promptContractTest();
  callTypePromptTest();
  keytermTest();
  console.log("Smoke tests passed: QuestionBundle + confidence policy + call-type prompts + AnswerContract + Evidence Capsule + Q&A + SessionInfo + STT terminology");
} catch (error) {
  console.error("Smoke test failed:", error);
  process.exit(1);
}
