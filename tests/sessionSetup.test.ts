import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { SessionInfoModal } from "../components/SessionInfoModal";
import { interviewSpeechContext, prepareSessionInfo, sessionSetupError } from "../lib/audio/capturePolicy";
import type { SessionInfo } from "../lib/conversationTypes";

const common = { company: "Example", details: "Backend role" };

test("Giving always uses the saved default resume and requires a job description, not base availability", () => {
  const info = prepareSessionInfo({ ...common, callType: "giving_interview", knowledgeBaseIds: ["other"], candidateProfile: "private" });
  assert.deepEqual(info.knowledgeBaseIds, ["personal-knowledge"]);
  assert.equal(info.candidateProfile, undefined);
  assert.match(sessionSetupError(info, false), /Job description/);
  assert.equal(sessionSetupError({ ...info, jobDescription: "Build distributed systems" }, false), "");
  assert.match(sessionSetupError({ ...info, jobDescription: "x".repeat(12001) }), /12,000/);
});

test("Giving accepts role details with an optional company and trims them per session", () => {
  const info = prepareSessionInfo({ company: "", details: "Architecture round", callType: "giving_interview",
    jobTitle: "  Backend Engineer  ", jobDescription: "  Build reliable queues  ", seniority: "  Senior  " });
  assert.equal(sessionSetupError(info, false), "");
  assert.equal(info.company, "");
  assert.equal(info.jobTitle, "Backend Engineer");
  assert.equal(info.jobDescription, "Build reliable queues");
  assert.equal(info.seniority, "Senior");
  assert.equal(info.details, "Architecture round");
  assert.match(sessionSetupError({ ...info, jobTitle: "x".repeat(201) }), /Job title/);
  assert.match(sessionSetupError({ ...info, seniority: "x".repeat(101) }), /Seniority/);
});

test("Taking uses no personal base or background and requires its own private candidate profile", () => {
  const info = prepareSessionInfo({ ...common, callType: "taking_interview", knowledgeBaseIds: ["personal-knowledge"],
    jobTitle: "Private title", seniority: "Private seniority", jobDescription: "Private JD" });
  assert.deepEqual(info.knowledgeBaseIds, []);
  assert.equal(info.jobTitle, undefined);
  assert.equal(info.seniority, undefined);
  assert.equal(info.jobDescription, undefined);
  assert.match(sessionSetupError(info, false), /Candidate profile/);
  const complete = { ...info, candidateProfile: "Candidate knows Rust" };
  assert.equal(sessionSetupError(complete, false), "");
  const context = interviewSpeechContext(complete, "My private resume");
  assert.ok(context.includes("Candidate knows Rust"));
  assert.ok(context.includes("Backend role"));
  assert.ok(!context.includes("My private resume"));
  assert.ok(!context.includes("Private JD"));
});

test("Meeting retains explicit multi-base validation", () => {
  assert.match(sessionSetupError({ ...common, callType: "meeting", knowledgeBaseIds: [] }), /Select/);
  assert.equal(sessionSetupError({ ...common, callType: "meeting", knowledgeBaseIds: ["one", "two"] }), "");
});

test("Modal enforces Ctrl+Enter, resets private profiles, and never saves them as preferences", async () => {
  const originals = { useState: React.useState, useEffect: React.useEffect, useCallback: React.useCallback, useRef: React.useRef, fetch: globalThis.fetch };
  const slots: unknown[] = [];
  const effects: Array<() => void> = [];
  const patches: Record<string, unknown>[] = [];
  const requests: string[] = [];
  let cursor = 0;
  let open = true;
  let confirmed: SessionInfo | undefined;
  type Element = React.ReactElement<Record<string, any>>;
  const mutableReact = React as unknown as Record<string, unknown>;
  mutableReact.useState = (initial: unknown) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [slots[index], (value: unknown) => { slots[index] = typeof value === "function" ? (value as (previous: unknown) => unknown)(slots[index]) : value; }];
  };
  mutableReact.useRef = (initial: unknown) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  };
  mutableReact.useCallback = (callback: unknown) => callback;
  mutableReact.useEffect = (effect: () => void, dependencies: unknown[]) => {
    const index = cursor++;
    const previous = slots[index] as unknown[] | undefined;
    if (!previous || dependencies.some((value, position) => value !== previous[position])) effects.push(effect);
    slots[index] = dependencies;
  };
  globalThis.fetch = (async (url, options) => {
    requests.push(String(url));
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body));
      patches.push(body.patch);
      return Response.json({ committed: true, settings: Object.entries(body.patch).map(([key, value]) => ({ key, value })) });
    }
    if (String(url) === "/api/settings") return Response.json({ settings: [{ key: "meetingCopilot.lastCompany", value: "Saved company" }] });
    if (String(url) === "/api/knowledge") return Response.json({ profile: { headline: "Saved engineer" }, sources: [{ type: "resume", filename: "resume.pdf" }] });
    throw new Error("Knowledge bases must not be needed for interview setup");
  }) as typeof fetch;
  const render = () => {
    cursor = 0;
    const tree = SessionInfoModal({ open, onConfirm: info => { confirmed = info; open = false; }, onCancel: () => { open = false; } });
    effects.splice(0).forEach(effect => effect());
    return tree as Element;
  };
  const elements = (node: unknown): Element[] => {
    if (!React.isValidElement(node)) return [];
    const element = node as Element;
    return [element, ...React.Children.toArray(element.props.children).flatMap(elements)];
  };
  const find = (tree: Element, predicate: (element: Element) => boolean) => {
    const element = elements(tree).find(predicate);
    assert.ok(element);
    return element;
  };
  const choose = (tree: Element, label: string) => find(tree, element => element.type === "button" && elements(element).some(child => child.props.children === label)).props.onClick();
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const submitWithKeyboard = (tree: Element) => {
    let propagationStopped = false;
    find(tree, element => Boolean(element.props.onKeyDown)).props.onKeyDown({ key: "Enter", ctrlKey: true,
      preventDefault() {}, stopPropagation() { propagationStopped = true; } });
    assert.equal(propagationStopped, true);
  };
  try {
    render(); await flush();
    let tree = render();
    choose(tree, "Taking Interview"); tree = render();
    assert.equal(find(tree, element => element.props.children && Array.isArray(element.props.children) && element.props.children.includes("Start Session")).props.disabled, true);
    submitWithKeyboard(tree);
    await flush(); assert.equal(confirmed, undefined);
    find(tree, element => element.props.id === "session-interview-context").props.onChange({ target: { value: "Candidate A: Rust" } });
    tree = render();
    find(tree, element => element.props["aria-label"] === "Cancel").props.onClick();
    render(); open = true; render(); await flush(); tree = render();
    choose(tree, "Taking Interview"); tree = render();
    assert.equal(find(tree, element => element.props.id === "session-interview-context").props.value, "");
    find(tree, element => element.props.id === "session-interview-context").props.onChange({ target: { value: "Candidate B: Go" } });
    tree = render();
    submitWithKeyboard(tree);
    await flush();
    const savedInfo = confirmed as SessionInfo | undefined;
    assert.equal(savedInfo?.candidateProfile, "Candidate B: Go");
    assert.deepEqual(savedInfo?.knowledgeBaseIds, []);
    assert.ok(patches.every(patch => !Object.keys(patch).some(key => /candidateProfile|jobDescription|jobTitle|seniority/.test(key))));
    assert.ok(!requests.includes("/api/knowledge-bases"));
    render(); open = true; render(); await flush(); tree = render();
    choose(tree, "Giving Interview"); render(); await flush(); tree = render();
    assert.ok(elements(tree).some(element => element.props.children === "Saved engineer"));
    assert.equal(find(tree, element => element.props.id === "session-job-title").props.value, "");
    assert.equal(find(tree, element => element.props.id === "session-seniority").props.value, "");
    assert.ok(React.Children.toArray(find(tree, element => element.props.htmlFor === "session-details").props.children).includes("Additional context"));
    assert.equal(find(tree, element => element.props.id === "session-interview-context").props.value, "");
    assert.equal(find(tree, element => element.props.id === "session-interview-context").props.maxLength, 12000);
    find(tree, element => element.props.id === "session-job-title").props.onChange({ target: { value: "  Backend Engineer  " } });
    find(tree, element => element.props.id === "session-company").props.onChange({ target: { value: "" } });
    find(tree, element => element.props.id === "session-interview-context").props.onChange({ target: { value: "Target role: distributed systems engineer" } });
    find(tree, element => element.props.id === "session-seniority").props.onChange({ target: { value: "Senior" } });
    find(tree, element => element.props.id === "session-details").props.onChange({ target: { value: "  Architecture round  " } });
    tree = render();
    submitWithKeyboard(tree);
    await flush();
    const givingInfo = confirmed as SessionInfo | undefined;
    assert.deepEqual(givingInfo?.knowledgeBaseIds, ["personal-knowledge"]);
    assert.equal(givingInfo?.jobTitle, "Backend Engineer");
    assert.equal(givingInfo?.company, "");
    assert.equal(givingInfo?.jobDescription, "Target role: distributed systems engineer");
    assert.equal(givingInfo?.seniority, "Senior");
    assert.equal(givingInfo?.details, "Architecture round");
    assert.equal(givingInfo?.candidateProfile, undefined);
    assert.ok(patches.every(patch => !Object.keys(patch).some(key => /candidateProfile|jobDescription|jobTitle|seniority/.test(key))));
    render(); open = true; render(); await flush(); tree = render();
    globalThis.fetch = (async url => String(url) === "/api/knowledge" ? Response.json({ error: "No pack" }, { status: 404 }) : Response.json({ settings: [] })) as typeof fetch;
    choose(tree, "Giving Interview"); render(); await flush(); tree = render();
    assert.ok(elements(tree).some(element => element.props.children === "No saved resume"));
    assert.equal(find(tree, element => element.props.id === "session-job-title").props.value, "");
    assert.equal(find(tree, element => element.props.id === "session-seniority").props.value, "");
    assert.equal(find(tree, element => element.props.id === "session-details").props.value, "");
    assert.equal(find(tree, element => element.props.id === "session-interview-context").props.value, "");
    find(tree, element => element.props.id === "session-interview-context").props.onChange({ target: { value: "New role" } });
    tree = render();
    assert.equal(find(tree, element => Array.isArray(element.props.children) && element.props.children.includes("Start Session")).props.disabled, false);
  } finally {
    Object.assign(mutableReact, { useState: originals.useState, useEffect: originals.useEffect, useCallback: originals.useCallback, useRef: originals.useRef });
    globalThis.fetch = originals.fetch;
  }
});