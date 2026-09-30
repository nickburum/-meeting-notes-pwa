import test from "node:test";
import assert from "node:assert/strict";
import { corsForOrigin, extractModelText, handleRequest, parseVtt } from "../src/index.js";

test("CORS accepts the configured origin and rejects another", () => {
  assert.equal(corsForOrigin("https://example.github.io", ["https://example.github.io"])["Access-Control-Allow-Origin"], "https://example.github.io");
  assert.equal(corsForOrigin("https://evil.example", ["https://example.github.io"]), null);
});

test("CORS permits localhost for local development", () => {
  assert.equal(corsForOrigin("http://localhost:8080", [])["Access-Control-Allow-Origin"], "http://localhost:8080");
});

test("VTT timestamps become millisecond cues", () => {
  const cues = parseVtt("WEBVTT\n\n00:00:01.250 --> 00:00:03.500\nHello team\n\n00:01:00.000 --> 00:01:02.000\nNext item");
  assert.deepEqual(cues, [
    { relativeStartMs: 1250, relativeEndMs: 3500, text: "Hello team" },
    { relativeStartMs: 60000, relativeEndMs: 62000, text: "Next item" }
  ]);
});

test("model text extraction supports Cloudflare response variants", () => {
  assert.equal(extractModelText({ response: "one" }), "one");
  assert.equal(extractModelText({ response: { title: "Meeting" } }), '{"title":"Meeting"}');
  assert.equal(extractModelText({ choices: [{ message: { content: "two" } }] }), "two");
});

test("health requires the token and accepted origin", async () => {
  const env = { APP_TOKEN: "a-very-long-owner-token", ALLOWED_ORIGINS: "https://example.github.io" };
  const blocked = await handleRequest(new Request("https://api.example/health", { headers: { Origin: "https://example.github.io" } }), env);
  assert.equal(blocked.status, 401);
  const ok = await handleRequest(new Request("https://api.example/health", { headers: { Origin: "https://example.github.io", Authorization: "Bearer a-very-long-owner-token" } }), env);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
});

test("transcription endpoint sends base64 audio and returns timed cues", async () => {
  let captured;
  const env = {
    APP_TOKEN: "a-very-long-owner-token",
    ALLOWED_ORIGINS: "https://example.github.io",
    AI: { run: async (model, input) => {
      captured = { model, input };
      return { text: "Hello team", segments: [{ start: 0.25, end: 1.5, text: "Hello team" }] };
    } }
  };
  const form = new FormData();
  form.append("audio", new File([new Uint8Array([1, 2, 3, 4])], "test.webm", { type: "audio/webm" }));
  form.append("segmentId", "segment-1");
  form.append("language", "en");
  const response = await handleRequest(new Request("https://api.example/v1/transcribe", {
    method: "POST", body: form,
    headers: { Origin: "https://example.github.io", Authorization: "Bearer a-very-long-owner-token" }
  }), env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(captured.model, "@cf/openai/whisper-large-v3-turbo");
  assert.equal(captured.input.audio, "AQIDBA==");
  assert.deepEqual(body.cues, [{ relativeStartMs: 250, relativeEndMs: 1500, text: "Hello team" }]);
});

test("notes endpoint accepts native structured object output", async () => {
  const notes = {
    title: "Planning", overview: "The team planned.", discussionPoints: [], decisions: [],
    actionItems: [], openQuestions: [], parkingLot: []
  };
  const env = {
    APP_TOKEN: "a-very-long-owner-token",
    ALLOWED_ORIGINS: "https://example.github.io",
    AI: { run: async () => ({ response: notes }) }
  };
  const response = await handleRequest(new Request("https://api.example/v1/notes", {
    method: "POST",
    headers: { Origin: "https://example.github.io", Authorization: "Bearer a-very-long-owner-token", "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Planning", transcript: [{ id: "S0001", text: "We should plan." }] })
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).notes, notes);
});

test("participant and vocabulary lists become a readable initial prompt", async () => {
  let captured;
  const env = { APP_TOKEN: "a-very-long-owner-token", ALLOWED_ORIGINS: "https://example.github.io",
    AI: { run: async (_m, input) => { captured = input; return { text: "hi", segments: [] }; } } };
  const form = new FormData();
  form.append("audio", new File([new Uint8Array([1])], "a.webm"));
  form.append("participants", JSON.stringify(["Ana", "Ben"]));
  form.append("vocabulary", JSON.stringify(["Kubernetes"]));
  await handleRequest(new Request("https://api.example/v1/transcribe", { method: "POST", body: form,
    headers: { Origin: "https://example.github.io", Authorization: "Bearer a-very-long-owner-token" } }), env);
  assert.equal(captured.initial_prompt, "Participant names: Ana, Ben. Preferred spellings: Kubernetes");
});

test("wrong token and disallowed origin are rejected", async () => {
  const env = { APP_TOKEN: "a-very-long-owner-token", ALLOWED_ORIGINS: "https://example.github.io" };
  const bad = await handleRequest(new Request("https://api.example/health", { headers: { Origin: "https://example.github.io", Authorization: "Bearer nope" } }), env);
  assert.equal(bad.status, 401);
  const origin = await handleRequest(new Request("https://api.example/health", { headers: { Origin: "https://evil.example", Authorization: "Bearer a-very-long-owner-token" } }), env);
  assert.equal(origin.status, 403);
});
