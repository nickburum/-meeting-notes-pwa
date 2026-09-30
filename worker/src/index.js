const TRANSCRIBE_MODEL = "@cf/openai/whisper-large-v3-turbo";
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 600_000;

export const notesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "overview", "discussionPoints", "decisions", "actionItems", "openQuestions", "parkingLot"],
  properties: {
    title: { type: "string" },
    overview: { type: "string" },
    discussionPoints: { type: "array", items: evidenceItemSchema("text") },
    decisions: { type: "array", items: evidenceItemSchema("text") },
    actionItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["task", "owner", "dueDateText", "evidence"],
        properties: {
          task: { type: "string" },
          owner: { type: "string" },
          dueDateText: { type: "string" },
          evidence: evidenceSchema()
        }
      }
    },
    openQuestions: { type: "array", items: evidenceItemSchema("text") },
    parkingLot: { type: "array", items: evidenceItemSchema("text") }
  }
};

function evidenceSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["segmentIds", "quote"],
    properties: {
      segmentIds: { type: "array", minItems: 1, items: { type: "string" } },
      quote: { type: "string" }
    }
  };
}

function evidenceItemSchema(textKey) {
  return {
    type: "object",
    additionalProperties: false,
    required: [textKey, "evidence"],
    properties: { [textKey]: { type: "string" }, evidence: evidenceSchema() }
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }
  });
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

export function corsForOrigin(origin, configuredOrigins) {
  const normalized = String(origin || "").replace(/\/$/, "");
  const allowed = configuredOrigins.includes(normalized) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalized);
  return allowed ? {
    "Access-Control-Allow-Origin": normalized,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  } : null;
}

async function tokensMatch(received, expected) {
  if (!received || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(received)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  let different = aa.length ^ bb.length;
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) different |= (aa[i] || 0) ^ (bb[i] || 0);
  return different === 0;
}

function cleanText(value, max = 5000) {
  return String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim().slice(0, max);
}

function listText(value, max) {
  const raw = String(value || "");
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return cleanText(parsed.map((item) => cleanText(item, 100)).filter(Boolean).join(", "), max);
  } catch {}
  return cleanText(raw, max);
}

function audioToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const block = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += block) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + block, bytes.length)));
  }
  return btoa(binary);
}

export function parseVtt(vtt) {
  const blocks = String(vtt || "").replace(/\r/g, "").split(/\n\n+/);
  const cues = [];
  const toMs = (stamp) => {
    const parts = stamp.replace(",", ".").split(":").map(Number);
    const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    return Math.round(seconds * 1000);
  };
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    const timeIndex = lines.findIndex((line) => line.includes(" --> "));
    if (timeIndex < 0) continue;
    const [start, end] = lines[timeIndex].split(" --> ").map((value) => value.trim().split(" ")[0]);
    const text = lines.slice(timeIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (text) cues.push({ relativeStartMs: toMs(start), relativeEndMs: toMs(end), text });
  }
  return cues;
}

function normalizeCues(result) {
  const raw = result?.segments || result?.transcription_info?.segments || result?.chunks || [];
  const cues = raw.map((segment) => {
    const stamp = segment.timestamp || segment.timestamps;
    const startSeconds = Number(segment.start ?? stamp?.[0] ?? 0);
    const endSeconds = Number(segment.end ?? stamp?.[1] ?? startSeconds);
    return {
      relativeStartMs: Math.max(0, Math.round(startSeconds * 1000)),
      relativeEndMs: Math.max(0, Math.round(endSeconds * 1000)),
      text: cleanText(segment.text, 20_000)
    };
  }).filter((cue) => cue.text);
  if (cues.length) return cues;
  return parseVtt(result?.vtt || result?.transcription_info?.vtt);
}

export function extractModelText(result) {
  if (typeof result === "string") return result;
  if (typeof result?.response === "string") return result.response;
  if (result?.response && typeof result.response === "object") return JSON.stringify(result.response);
  if (typeof result?.result?.response === "string") return result.result.response;
  if (result?.result?.response && typeof result.result.response === "object") return JSON.stringify(result.result.response);
  if (typeof result?.choices?.[0]?.message?.content === "string") return result.choices[0].message.content;
  if (typeof result?.result?.choices?.[0]?.message?.content === "string") return result.result.choices[0].message.content;
  return "";
}

function parseModelJson(text) {
  const trimmed = String(text || "").trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return JSON.parse(fenced);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error("The note model did not return valid JSON.");
}

function minimallyValidateNotes(notes) {
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) return false;
  return ["discussionPoints", "decisions", "actionItems", "openQuestions", "parkingLot"].every((key) => Array.isArray(notes[key]));
}

function quotaError(error) {
  const message = String(error?.message || error || "");
  return error?.code === 3036 || error?.status === 429 || /quota|limit|neurons|exceeded|rate/i.test(message);
}

async function transcribe(request, env, cors) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_AUDIO_BYTES + 100_000) return json({ code: "AUDIO_TOO_LARGE", message: "Audio segment is too large." }, 413, cors);
  const form = await request.formData();
  const file = form.get("audio");
  if (!(file instanceof File) || !file.size) return json({ code: "AUDIO_REQUIRED", message: "An audio file is required." }, 400, cors);
  if (file.size > MAX_AUDIO_BYTES) return json({ code: "AUDIO_TOO_LARGE", message: "Audio segment is too large." }, 413, cors);
  const language = cleanText(form.get("language"), 20);
  const vocabulary = listText(form.get("vocabulary"), 1000);
  const participants = listText(form.get("participants"), 300);
  const promptParts = [participants && `Participant names: ${participants}`, vocabulary && `Preferred spellings: ${vocabulary}`].filter(Boolean);
  const input = {
    audio: audioToBase64(await file.arrayBuffer()),
    task: "transcribe",
    vad_filter: true,
    beam_size: 5,
    condition_on_previous_text: true
  };
  if (language && language !== "auto") input.language = language;
  if (promptParts.length) input.initial_prompt = promptParts.join(". ");
  try {
    const result = await env.AI.run(TRANSCRIBE_MODEL, input);
    return json({
      segmentId: cleanText(form.get("segmentId"), 100),
      text: cleanText(result?.text || result?.transcription || result?.result?.text, 200_000),
      cues: normalizeCues(result),
      language: result?.language || language || "auto",
      model: TRANSCRIBE_MODEL
    }, 200, cors);
  } catch (error) {
    if (quotaError(error)) return json({ code: "DAILY_FREE_QUOTA_EXHAUSTED", message: "The free daily AI allowance is exhausted. Retry after the daily reset." }, 429, cors);
    console.error("transcribe_error", String(error?.message || error).slice(0, 300));
    return json({ code: "TRANSCRIPTION_FAILED", message: "Transcription failed for this audio segment. Retry it in a moment." }, 502, cors);
  }
}

function transcriptForPrompt(transcript) {
  return transcript.map((cue) => `[${cleanText(cue.id, 40)}] ${cleanText(cue.text, 20_000)}`).join("\n");
}

async function makeNotes(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { return json({ code: "INVALID_JSON", message: "The notes request was not valid JSON." }, 400, cors); }
  const transcript = Array.isArray(body.transcript) ? body.transcript.filter((cue) => cue && cue.id && cue.text) : [];
  const transcriptText = transcriptForPrompt(transcript);
  if (!transcript.length) return json({ code: "TRANSCRIPT_REQUIRED", message: "A non-empty transcript is required." }, 400, cors);
  if (transcriptText.length > MAX_TRANSCRIPT_CHARS) return json({ code: "TRANSCRIPT_TOO_LARGE", message: "The transcript is too large for one notes request." }, 413, cors);
  const system = `You create conservative meeting notes from the supplied transcript only. Never invent a decision, owner, deadline, question, or claim. Every list item must cite one or more exact transcript IDs and include a short verbatim quote copied exactly from those cited lines. Use an empty string for an unstated owner or due date. Omit uncertain items. Put explicit commitments such as \"Name will do X by Y\" in actionItems (owner and due date only when spoken), explicit agreements such as \"we decided\" in decisions, and do not repeat an item in more than one list. Keep the overview factual and concise. Example: the line \"[S0009] Maria will send the budget by Monday.\" produces actionItems: task \"Send the budget\", owner \"Maria\", dueDateText \"Monday\", evidence segmentIds [\"S0009\"] and quote \"Maria will send the budget by Monday\", and must not also appear in discussionPoints. Return JSON matching the provided schema only.`;
  const user = `Meeting title: ${cleanText(body.title, 120) || "Meeting"}\nDate: ${cleanText(body.date, 80)}\nParticipants supplied by organizer: ${cleanText(body.participants, 500)}\n\nTranscript:\n${transcriptText}`;
  try {
    const result = await env.AI.run(env.NOTES_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: "json_schema", json_schema: notesSchema }
    });
    const notes = parseModelJson(extractModelText(result));
    if (!minimallyValidateNotes(notes)) throw new Error("The note response did not match the expected shape.");
    return json({ notes, warnings: [], model: env.NOTES_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }, 200, cors);
  } catch (error) {
    if (quotaError(error)) return json({ code: "DAILY_FREE_QUOTA_EXHAUSTED", message: "The free daily AI allowance is exhausted. Retry after the daily reset." }, 429, cors);
    console.error("notes_error", String(error?.message || error).slice(0, 300));
    return json({ code: "NOTES_FAILED", message: "Note generation failed. Your transcript remains saved; retry in a moment." }, 502, cors);
  }
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "";
  const cors = corsForOrigin(origin, allowedOrigins(env));
  if (!cors) return json({ code: "ORIGIN_NOT_ALLOWED", message: "This website origin is not allowed." }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const suppliedToken = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!(await tokensMatch(suppliedToken, env.APP_TOKEN))) return json({ code: "UNAUTHORIZED", message: "The owner token is invalid." }, 401, cors);
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "meeting-notes-api", mode: "cloudflare" }, 200, cors);
  }
  if (request.method === "POST" && url.pathname === "/v1/transcribe") return transcribe(request, env, cors);
  if (request.method === "POST" && url.pathname === "/v1/notes") return makeNotes(request, env, cors);
  return json({ code: "NOT_FOUND", message: "Endpoint not found." }, 404, cors);
}

export default { fetch: handleRequest };
