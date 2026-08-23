#!/usr/bin/env node

/**
 * Fast pure-logic regression checks. Requires dev dependency `typescript`, but no API keys,
 * network access, browser, or Next.js server.
 */
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function loadPureTsModule(file) {
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
  const sandbox = {
    module,
    exports: module.exports,
    require,
    console,
    Date,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(output, sandbox, { filename: file });
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

try {
  transcriptStateMachineTest();
  contextSelectorTest();
  qaSelectorTest();
  console.log("Smoke tests passed: transcript focus/follow-up + local knowledge + Q&A selection");
} catch (error) {
  console.error("Smoke test failed:", error);
  process.exit(1);
}
