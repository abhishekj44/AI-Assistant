import assert from "node:assert/strict";
import test from "node:test";
import { buildAnswerPromptDetailed, buildAnswerSystemInstruction, formatTurnsWithBudget } from "../lib/promptBuilder";
import { openDatabase } from "../lib/server/db/connection";
import { SessionRepository } from "../lib/server/repositories/sessionRepository";
import { buildCandidateResponseBundle } from "../lib/question/questionBundle";
import { conversationSpeakerLabel } from "../lib/callTypes";

test("Giving Interview uses resume evidence and a job description without importing candidate-profile claims", () => {
  const sessionInfo = { company: "Example", details: "Backend interview", callType: "giving_interview" as const,
    jobDescription: "Build reliable distributed queues.", candidateProfile: "Another candidate's profile." };
  const parts = buildAnswerPromptDetailed({ candidateContext: "Saved resume: TypeScript queue project.",
    sessionInfo, recentTurns: [], question: "How do you retry failed tasks?" });
  assert.ok(parts.prompt.includes("Saved resume: TypeScript queue project."));
  assert.ok(parts.prompt.includes("<JOB_DESCRIPTION_DATA>"));
  assert.ok(parts.prompt.includes(sessionInfo.jobDescription));
  assert.ok(!parts.prompt.includes(sessionInfo.candidateProfile));
  assert.ok(buildAnswerSystemInstruction(undefined, false, undefined, false, sessionInfo).includes("not experience the candidate has already gained"));
});

test("Taking Interview uses the candidate profile, local question and remote answer without the user's resume", () => {
  const timestamp = new Date().toISOString();
  const turns = [
    { id: "local", sequenceId: 1, speaker: "me" as const, text: "How did you measure queue latency?", timestamp },
    { id: "remote", sequenceId: 2, speaker: "interviewer" as const, text: "I monitored the p95 wait time.", timestamp },
  ];
  const sessionInfo = { company: "Example", details: "Interview", callType: "taking_interview" as const,
    candidateProfile: "Backend developer with three years of Redis experience.", jobDescription: "Private unrelated role." };
  const parts = buildAnswerPromptDetailed({ candidateContext: "The local user's resume.", background: "The local user's persona.", sessionInfo,
    recentTurns: turns, question: turns[1].text, questionBundle: { primaryAsk: turns[1].text, interviewerBlock: turns[1].text,
      scenarioContext: "", retrievalQuery: turns[1].text, turnIds: ["remote"], turnCount: 1, primaryAskConfidence: "fallback", usedActiveInterim: false } });
  assert.ok(parts.prompt.includes("<CANDIDATE_PROFILE_DATA>"));
  assert.ok(parts.prompt.includes(sessionInfo.candidateProfile));
  assert.ok(parts.recentConversationText.includes(`ME: ${turns[0].text}`));
  assert.ok(parts.recentConversationText.includes(`CANDIDATE: ${turns[1].text}`));
  assert.ok(!parts.prompt.includes("The local user's resume"));
  assert.ok(!parts.prompt.includes("The local user's persona"));
  assert.ok(!parts.prompt.includes(sessionInfo.jobDescription));
  assert.ok(buildAnswerSystemInstruction(undefined, false, undefined, false, sessionInfo).includes("conversation between both speakers"));
});

test("sessions restore role-specific context and automatic resume scope without leaking previous candidate data", context => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const sessions = new SessionRepository(database);
  sessions.start({ id: "giving", ownerTabId: "tab", sessionInfo: { company: "Example", details: "", callType: "giving_interview",
    jobDescription: "Queue reliability role", candidateProfile: "Wrong candidate", knowledgeBaseIds: ["missing"] } });
  const restoredGiving = sessions.get("giving")!.sessionInfo!;
  assert.equal(restoredGiving.jobDescription, "Queue reliability role");
  assert.deepEqual(restoredGiving.knowledgeBaseIds, ["personal-knowledge"]);
  assert.equal(restoredGiving.candidateProfile, undefined);
  sessions.start({ id: "giving", ownerTabId: "tab", sessionInfo: { company: "Example", details: "", callType: "giving_interview" } });
  assert.equal(sessions.get("giving")!.sessionInfo!.jobDescription, "Queue reliability role");
  sessions.start({ id: "taking", ownerTabId: "tab", sessionInfo: { company: "Example", details: "", callType: "taking_interview",
    candidateProfile: "Candidate A: Redis developer", jobDescription: "Wrong role", knowledgeBaseIds: ["personal-knowledge"] } });
  assert.equal(sessions.get("taking")!.sessionInfo!.candidateProfile, "Candidate A: Redis developer");
  assert.equal(sessions.get("taking")!.sessionInfo!.jobDescription, undefined);
  assert.deepEqual(sessions.get("taking")!.sessionInfo!.knowledgeBaseIds, []);
  sessions.start({ id: "next-candidate", ownerTabId: "tab", sessionInfo: { company: "Example", details: "", callType: "taking_interview", candidateProfile: "Candidate B: Python developer" } });
  assert.equal(sessions.get("next-candidate")!.sessionInfo!.candidateProfile, "Candidate B: Python developer");
  assert.equal(sessions.get("taking")!.sessionInfo!.candidateProfile, "Candidate A: Redis developer");
  assert.throws(() => sessions.start({ id: "invalid", ownerTabId: "tab", sessionInfo: { company: "", details: "", callType: "giving_interview", jobDescription: "x".repeat(12001) } }), /12000/);
  sessions.end("next-candidate", "tab");
  assert.equal(sessions.get("next-candidate")!.summaryStatus, "NONE");
});

test("candidate responses remain complete after a local follow-up instead of being extracted as a question", () => {
  const timestamp = new Date().toISOString();
  const turns = [
    { id: "question", speaker: "me" as const, text: "Explain your queue design.", timestamp },
    { id: "answer", speaker: "interviewer" as const, text: "What we did was partition the queue. We measured p95 latency.", timestamp },
    { id: "follow-up", speaker: "me" as const, text: "Which metrics did you collect?", timestamp },
  ];
  const bundle = buildCandidateResponseBundle(turns)!;
  assert.equal(bundle.interviewerBlock, turns[1].text);
  assert.equal(bundle.primaryAsk, turns[1].text);
  assert.deepEqual(bundle.turnIds, ["answer"]);
  assert.equal(bundle.primaryAskConfidence, "fallback");
  assert.equal(buildCandidateResponseBundle(turns.filter(turn => turn.speaker === "me")), null);
});

test("speaker labels follow the local person's interview role", () => {
  assert.equal(conversationSpeakerLabel("me", "taking_interview"), "Me (Interviewer)");
  assert.equal(conversationSpeakerLabel("interviewer", "taking_interview"), "Candidate");
  assert.equal(conversationSpeakerLabel("interviewer", "giving_interview"), "Interviewer");
  assert.equal(conversationSpeakerLabel("interviewer", "meeting"), "Remote");
});

test("a long candidate answer never crowds out the latest interviewer question", () => {
  const timestamp = new Date().toISOString();
  const turns = [
    { id: "question", sequenceId: 1, speaker: "me" as const, text: "Which retry failure did you diagnose?", timestamp },
    ...Array.from({ length: 15 }, (_, index) => ({ id: `answer-${index}`, sequenceId: index + 2, speaker: "interviewer" as const,
      text: `Candidate detail ${index}: ${"Retry evidence. ".repeat(80)}`, timestamp })),
  ];
  for (const budget of [600, 2600]) {
    const text = formatTurnsWithBudget(turns, budget, "taking_interview");
    assert.ok(text.includes("ME: Which retry failure did you diagnose?"));
    assert.ok(text.includes("CANDIDATE: Candidate detail 14:"));
    assert.ok(text.length <= budget);
    assert.ok(text.indexOf("ME:") < text.lastIndexOf("CANDIDATE:"));
  }
});