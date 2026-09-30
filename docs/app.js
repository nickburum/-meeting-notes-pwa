const DB_NAME = "meeting-notes-pwa";
const DB_VERSION = 1;
const SEGMENT_MS = 2 * 60 * 1000;
const OVERLAP_MS = 3000;
const DISCORD_PART_LIMIT = 1850;

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries([
  "settingsToggle", "connectionPanel", "connectionBadge", "apiUrl", "apiToken",
  "testConnection", "saveConnection", "setupView", "supportBadge", "meetingTitle",
  "language", "participants", "vocabulary", "consent", "micTestResult", "testMic",
  "startRecording", "recoveryPanel", "recoveryText", "processRecovered", "discardRecovered",
  "recordingView", "recordingTitle", "recordingTimer", "levelBar", "audioHealth",
  "stopRecording", "processingView", "progressBar", "processingStatus", "segmentList",
  "retryProcessing", "reviewView", "reviewBadge", "reviewWarnings", "notesTab",
  "transcriptTab", "notesPanel", "transcriptPanel", "approveNotes", "backToSetup",
  "openShare", "shareView", "shareParts", "copyFull", "shareNewMeeting", "toast"
].map((id) => [id, $(id)]));

let dbPromise;
let micTestPassed = false;
let currentSession = null;
let currentTranscript = [];
let currentNotes = null;
let mediaStream = null;
let audioContext = null;
let analyser = null;
let meterFrame = null;
let wakeLock = null;
let recordingStartedAt = 0;
let recordingInterval = null;
let rotationTimer = null;
let isRecording = false;
let nextSegmentIndex = 0;
let currentRecorderContext = null;
const activeRecorders = new Set();
let retryAction = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
      if (!db.objectStoreNames.contains("segments")) {
        const store = db.createObjectStore("segments", { keyPath: "id" });
        store.createIndex("sessionId", "sessionId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function dbPut(storeName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGet(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getSessionSegments(sessionId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("segments", "readonly");
    const request = tx.objectStore("segments").index("sessionId").getAll(sessionId);
    request.onsuccess = () => resolve(request.result.sort((a, b) => a.index - b.index));
    request.onerror = () => reject(request.error);
  });
}

async function listSessions() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", "readonly");
    const request = tx.objectStore("sessions").getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    request.onerror = () => reject(request.error);
  });
}

async function deleteSession(sessionId) {
  const db = await openDb();
  const segments = await getSessionSegments(sessionId);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["sessions", "segments"], "readwrite");
    tx.objectStore("sessions").delete(sessionId);
    const store = tx.objectStore("segments");
    segments.forEach((segment) => store.delete(segment.id));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function getConnection() {
  return {
    url: (localStorage.getItem("meeting-api-url") || "").replace(/\/+$/, ""),
    token: localStorage.getItem("meeting-api-token") || ""
  };
}

function saveConnection() {
  const url = els.apiUrl.value.trim().replace(/\/+$/, "");
  const token = els.apiToken.value.trim();
  if (!/^https:\/\//.test(url) && !/^http:\/\/localhost(?::\d+)?$/.test(url)) {
    throw new Error("Use an HTTPS backend URL, or localhost while developing.");
  }
  if (token.length < 20) throw new Error("The owner token appears too short.");
  localStorage.setItem("meeting-api-url", url);
  localStorage.setItem("meeting-api-token", token);
  return { url, token };
}

async function apiFetch(path, options = {}) {
  const { url, token } = getConnection();
  if (!url || !token) throw new Error("Open Connection settings and save your backend URL and token first.");
  const response = await fetch(`${url}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    cache: "no-store"
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : { error: await response.text() };
  if (!response.ok) {
    const error = new Error(body.message || body.error || `Request failed (${response.status})`);
    error.code = body.code || `HTTP_${response.status}`;
    throw error;
  }
  return body;
}

function showView(view) {
  [els.setupView, els.recordingView, els.processingView, els.reviewView, els.shareView]
    .forEach((element) => { element.hidden = element !== view; });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { els.toast.hidden = true; }, 3200);
}

function setStatus(element, message, kind = "neutral") {
  element.textContent = message;
  element.className = element.classList.contains("badge") ? `badge ${kind}` : `status-line ${kind}`;
}

function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

async function sha256(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function testConnection() {
  try {
    saveConnection();
    setStatus(els.connectionBadge, "Testing", "neutral");
    const result = await apiFetch("/health");
    setStatus(els.connectionBadge, "Cloud connected", "good");
    showToast("Connection works.");
  } catch (error) {
    setStatus(els.connectionBadge, "Connection failed", "error");
    showToast(error.message);
  }
}

async function testMicrophone() {
  let stream;
  try {
    setStatus(els.micTestResult, "Listening for two seconds…", "neutral");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    const mimeType = getMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start(250);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    recorder.stop();
    await stopped;
    const testBlob = new Blob(chunks, { type: recorder.mimeType });
    if (testBlob.size < 800) throw new Error("The microphone produced no usable audio. Check iPhone microphone permission.");
    micTestPassed = true;
    setStatus(els.micTestResult, `Microphone ready · ${recorder.mimeType || "browser format"}`, "good");
    updateStartButton();
  } catch (error) {
    micTestPassed = false;
    setStatus(els.micTestResult, error.message, "error");
    updateStartButton();
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

function updateStartButton() {
  els.startRecording.disabled = !(micTestPassed && els.consent.checked && els.meetingTitle.value.trim());
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    setStatus(els.audioHealth, "Screen wake lock was unavailable. Keep touching the screen occasionally.", "warning");
  }
}

function setupMeter(stream) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  let quietSince = null;

  const draw = () => {
    if (!isRecording) return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const sample of data) {
      const value = (sample - 128) / 128;
      sum += value * value;
    }
    const rms = Math.sqrt(sum / data.length);
    const level = Math.min(100, Math.max(2, rms * 430));
    els.levelBar.style.width = `${level}%`;
    if (rms < 0.008) {
      quietSince ||= performance.now();
      if (performance.now() - quietSince > 10000) setStatus(els.audioHealth, "Very little sound detected. Move the phone closer.", "warning");
    } else {
      quietSince = null;
      setStatus(els.audioHealth, rms > 0.45 ? "Audio may be clipping. Move the phone farther away." : "Microphone active", rms > 0.45 ? "warning" : "good");
    }
    meterFrame = requestAnimationFrame(draw);
  };
  draw();
}

function startRecorder(startMs) {
  const mimeType = getMimeType();
  const recorder = new MediaRecorder(mediaStream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 });
  const context = { recorder, chunks: [], index: nextSegmentIndex++, startMs, finished: null };
  context.finished = new Promise((resolve, reject) => {
    recorder.ondataavailable = (event) => { if (event.data.size) context.chunks.push(event.data); };
    recorder.onerror = () => reject(recorder.error || new Error("Recording segment failed."));
    recorder.onstop = async () => {
      try {
        const endMs = Math.round(performance.now() - recordingStartedAt);
        const blob = new Blob(context.chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
        if (blob.size > 800) {
          const segment = {
            id: `${currentSession.id}-${String(context.index).padStart(4, "0")}`,
            sessionId: currentSession.id,
            index: context.index,
            startMs: Math.round(context.startMs),
            endMs,
            mimeType: blob.type,
            byteLength: blob.size,
            sha256: await sha256(blob),
            blob,
            state: "local"
          };
          await dbPut("segments", segment);
        }
        activeRecorders.delete(context);
        resolve();
      } catch (error) {
        activeRecorders.delete(context);
        reject(error);
      }
    };
  });
  activeRecorders.add(context);
  recorder.start(1000);
  return context;
}

function scheduleRotation() {
  clearTimeout(rotationTimer);
  rotationTimer = setTimeout(() => {
    if (!isRecording) return;
    const old = currentRecorderContext;
    currentRecorderContext = startRecorder(performance.now() - recordingStartedAt);
    setTimeout(() => {
      if (old.recorder.state !== "inactive") old.recorder.stop();
    }, OVERLAP_MS);
    scheduleRotation();
  }, SEGMENT_MS - OVERLAP_MS);
}

async function startRecording() {
  try {
    const { url, token } = getConnection();
    if (!url || !token) throw new Error("Save and test Connection settings first.");
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    const now = new Date();
    currentSession = {
      id: uuid(),
      title: els.meetingTitle.value.trim(),
      language: els.language.value,
      participants: els.participants.value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 20),
      vocabulary: els.vocabulary.value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 100),
      createdAt: now.toISOString(),
      status: "recording",
      warnings: []
    };
    await dbPut("sessions", currentSession);

    isRecording = true;
    recordingStartedAt = performance.now();
    nextSegmentIndex = 0;
    currentRecorderContext = startRecorder(0);
    scheduleRotation();
    setupMeter(mediaStream);
    await requestWakeLock();
    els.recordingTitle.textContent = currentSession.title;
    els.recordingTimer.textContent = "00:00:00";
    recordingInterval = setInterval(() => {
      els.recordingTimer.textContent = formatTime(performance.now() - recordingStartedAt);
    }, 250);
    showView(els.recordingView);
  } catch (error) {
    mediaStream?.getTracks().forEach((track) => track.stop());
    showToast(error.message);
  }
}

async function stopRecording() {
  if (!isRecording) return;
  els.stopRecording.disabled = true;
  isRecording = false;
  clearTimeout(rotationTimer);
  clearInterval(recordingInterval);
  cancelAnimationFrame(meterFrame);
  const finishers = [...activeRecorders].map((context) => {
    if (context.recorder.state !== "inactive") context.recorder.stop();
    return context.finished;
  });
  await Promise.allSettled(finishers);
  mediaStream?.getTracks().forEach((track) => track.stop());
  await audioContext?.close().catch(() => {});
  await wakeLock?.release().catch(() => {});
  wakeLock = null;
  currentSession.status = "recorded";
  currentSession.durationMs = Math.round(performance.now() - recordingStartedAt);
  await dbPut("sessions", currentSession);
  els.stopRecording.disabled = false;
  await processSession(currentSession.id);
}

function updateProgress(percent, message) {
  els.progressBar.style.width = `${Math.max(3, Math.min(100, percent))}%`;
  els.processingStatus.textContent = message;
}

function renderSegmentStatuses(segments, statusById = {}) {
  els.segmentList.innerHTML = segments.map((segment) => {
    const status = statusById[segment.id] || segment.state || "queued";
    return `<div class="segment-item"><span>Audio ${segment.index + 1} · ${formatTime(segment.endMs - segment.startMs)}</span><strong>${escapeHtml(status)}</strong></div>`;
  }).join("");
}

async function transcribeSegment(segment) {
  const form = new FormData();
  const extension = segment.mimeType.includes("mp4") ? "m4a" : "webm";
  form.append("audio", segment.blob, `segment-${segment.index}.${extension}`);
  form.append("segmentId", segment.id);
  form.append("startMs", String(segment.startMs));
  form.append("endMs", String(segment.endMs));
  form.append("language", currentSession.language);
  form.append("participants", JSON.stringify(currentSession.participants));
  form.append("vocabulary", JSON.stringify(currentSession.vocabulary));
  form.append("sha256", segment.sha256);
  return apiFetch("/v1/transcribe", { method: "POST", body: form });
}

async function runPool(items, concurrency, worker, onUpdate) {
  const results = new Array(items.length);
  let cursor = 0;
  let completed = 0;
  async function runner() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
      completed += 1;
      onUpdate?.(completed, items.length, items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
  return results;
}

function normalizeText(text) {
  return String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function tokenSimilarity(a, b) {
  const aa = new Set(normalizeText(a).split(" ").filter(Boolean));
  const bb = new Set(normalizeText(b).split(" ").filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  aa.forEach((token) => { if (bb.has(token)) common += 1; });
  return common / Math.min(aa.size, bb.size);
}

export function mergeTranscript(segmentResults, segments) {
  const merged = [];
  segmentResults.forEach((result, index) => {
    const audio = segments[index];
    const cues = result.cues?.length ? result.cues : [{ relativeStartMs: 0, relativeEndMs: audio.endMs - audio.startMs, text: result.text }];
    for (const cue of cues) {
      const candidate = {
        startMs: audio.startMs + Number(cue.relativeStartMs || 0),
        endMs: audio.startMs + Number(cue.relativeEndMs || 0),
        text: String(cue.text || "").trim()
      };
      if (!candidate.text) continue;
      const duplicate = merged.slice(-8).some((existing) => {
        const overlaps = candidate.startMs <= existing.endMs + 1500 && candidate.endMs >= existing.startMs - 1500;
        return overlaps && tokenSimilarity(candidate.text, existing.text) >= 0.68;
      });
      if (!duplicate) merged.push(candidate);
    }
  });
  return merged.sort((a, b) => a.startMs - b.startMs).map((cue, index) => ({ ...cue, id: `S${String(index + 1).padStart(4, "0")}` }));
}

async function processSession(sessionId) {
  retryAction = () => processSession(sessionId);
  els.retryProcessing.hidden = true;
  showView(els.processingView);
  updateProgress(5, "Loading locally saved audio…");
  try {
    currentSession = await dbGet("sessions", sessionId);
    const segments = await getSessionSegments(sessionId);
    if (!segments.length) throw new Error("No completed audio segments were found.");
    const statuses = Object.fromEntries(segments.map((segment) => [segment.id, "queued"]));
    renderSegmentStatuses(segments, statuses);
    currentSession.status = "processing";
    await dbPut("sessions", currentSession);

    const results = await runPool(segments, 3, async (segment) => {
      statuses[segment.id] = "transcribing";
      renderSegmentStatuses(segments, statuses);
      try {
        const result = await transcribeSegment(segment);
        statuses[segment.id] = "complete";
        return result;
      } catch (error) {
        statuses[segment.id] = "failed";
        throw error;
      } finally {
        renderSegmentStatuses(segments, statuses);
      }
    }, (done, total) => updateProgress(10 + (done / total) * 60, `Transcribed ${done} of ${total} audio segments`));

    updateProgress(74, "Merging timestamps and overlap…");
    currentTranscript = mergeTranscript(results, segments);
    if (!currentTranscript.length) throw new Error("The transcript was empty. Check that the recording contains audible speech.");
    currentSession.transcript = currentTranscript;
    await dbPut("sessions", currentSession);

    updateProgress(82, "Generating evidence-linked notes…");
    const notesResponse = await apiFetch("/v1/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: currentSession.id,
        title: currentSession.title,
        date: currentSession.createdAt,
        participants: currentSession.participants,
        transcript: currentTranscript
      })
    });
    updateProgress(94, "Checking every note against transcript evidence…");
    const validation = validateNotes(notesResponse.notes, currentTranscript);
    currentNotes = validation.notes;
    currentSession.notes = currentNotes;
    currentSession.warnings = [...(currentSession.warnings || []), ...(notesResponse.warnings || []), ...validation.warnings];
    currentSession.status = "review";
    await dbPut("sessions", currentSession);
    updateProgress(100, "Ready for review");
    renderReview();
    showView(els.reviewView);
  } catch (error) {
    updateProgress(100, error.code === "DAILY_FREE_QUOTA_EXHAUSTED" ? "Free daily AI allowance is exhausted. Your audio is safe locally; retry after 00:00 UTC." : error.message);
    els.retryProcessing.hidden = false;
  }
}

function evidenceText(evidence, transcriptMap) {
  return (evidence?.segmentIds || []).map((id) => transcriptMap.get(id)?.text || "").join(" ");
}

export function validateNotes(notes, transcript) {
  const safe = notes && typeof notes === "object" ? structuredClone(notes) : {};
  const map = new Map(transcript.map((cue) => [cue.id, cue]));
  const warnings = [];
  for (const section of ["discussionPoints", "decisions", "actionItems", "openQuestions", "parkingLot"]) {
    const valid = [];
    for (const item of Array.isArray(safe[section]) ? safe[section] : []) {
      const ids = item.evidence?.segmentIds || [];
      const quote = normalizeText(item.evidence?.quote || "");
      const source = normalizeText(evidenceText(item.evidence, map));
      if (!ids.length || ids.some((id) => !map.has(id)) || !quote || !source.includes(quote)) {
        warnings.push(`One ${section.replace(/[A-Z]/g, (m) => ` ${m.toLowerCase()}`)} item was withheld because its evidence could not be verified.`);
        continue;
      }
      valid.push(item);
    }
    safe[section] = valid;
  }
  safe.overview = String(safe.overview || "").trim();
  safe.title = String(safe.title || "Meeting Notes").trim();
  return { notes: safe, warnings };
}

function cueTimeForEvidence(evidence) {
  const first = currentTranscript.find((cue) => evidence?.segmentIds?.includes(cue.id));
  return first ? formatTime(first.startMs) : "";
}

function renderNotesSection(title, key, formatter) {
  const items = currentNotes[key] || [];
  if (!items.length) return "";
  return `<section class="notes-section"><h3>${escapeHtml(title)}</h3><ul>${items.map((item, index) => {
    const text = formatter(item);
    return `<li><textarea class="note-edit" data-section="${key}" data-index="${index}" rows="2">${escapeHtml(text)}</textarea><span class="evidence">${escapeHtml(cueTimeForEvidence(item.evidence))} · “${escapeHtml(item.evidence.quote)}”</span></li>`;
  }).join("")}</ul></section>`;
}

function renderReview() {
  const warnings = currentSession.warnings || [];
  els.reviewWarnings.hidden = !warnings.length;
  els.reviewWarnings.innerHTML = warnings.map((warning) => `<div>• ${escapeHtml(warning)}</div>`).join("");
  setStatus(els.reviewBadge, warnings.length ? "Check flagged items" : "Evidence verified", warnings.length ? "warning" : "good");
  els.notesPanel.innerHTML = `
    <section class="notes-section"><h3>Summary</h3><textarea id="overviewEdit" rows="4">${escapeHtml(currentNotes.overview)}</textarea></section>
    ${renderNotesSection("Decisions", "decisions", (item) => item.text)}
    ${renderNotesSection("Action items", "actionItems", (item) => `${item.owner || "Unassigned"} — ${item.task}${item.dueDateText ? ` (due ${item.dueDateText})` : ""}`)}
    ${renderNotesSection("Discussion", "discussionPoints", (item) => item.text)}
    ${renderNotesSection("Open questions", "openQuestions", (item) => item.text)}
    ${renderNotesSection("Parking lot", "parkingLot", (item) => item.text)}
  `;
  els.transcriptPanel.innerHTML = currentTranscript.map((cue, index) => `<div class="transcript-cue"><span class="timestamp">${formatTime(cue.startMs)}</span><span contenteditable="true" data-cue-index="${index}">${escapeHtml(cue.text)}</span></div>`).join("");
  els.approveNotes.checked = false;
  els.openShare.disabled = true;
}

function applyReviewEdits() {
  const overview = $("overviewEdit");
  if (overview) currentNotes.overview = overview.value.trim();
  document.querySelectorAll(".note-edit").forEach((field) => {
    const item = currentNotes[field.dataset.section][Number(field.dataset.index)];
    const value = field.value.trim();
    if (field.dataset.section === "actionItems") item.displayText = value;
    else item.text = value;
  });
  document.querySelectorAll("[data-cue-index]").forEach((field) => {
    currentTranscript[Number(field.dataset.cueIndex)].text = field.textContent.trim();
  });
}

export function formatNotesMarkdown(notes, session) {
  const lines = [`# ${notes.title || session.title}`, `_${new Date(session.createdAt).toLocaleString()}_`, ""];
  if (notes.overview) lines.push("## Summary", notes.overview, "");
  const addList = (heading, items, formatter) => {
    if (!items?.length) return;
    lines.push(`## ${heading}`, ...items.map((item) => `- ${formatter(item)}`), "");
  };
  addList("Decisions", notes.decisions, (item) => item.text);
  addList("Action items", notes.actionItems, (item) => item.displayText || `☐ ${item.owner || "Unassigned"} — ${item.task}${item.dueDateText ? ` (due ${item.dueDateText})` : ""}`);
  addList("Discussion", notes.discussionPoints, (item) => item.text);
  addList("Open questions", notes.openQuestions, (item) => item.text);
  addList("Parking lot", notes.parkingLot, (item) => item.text);
  return lines.join("\n").trim();
}

export function splitDiscord(text, maxLength = DISCORD_PART_LIMIT) {
  const lines = text.split("\n");
  const parts = [];
  let current = "";
  for (const rawLine of lines) {
    const line = rawLine.length > maxLength ? rawLine.match(new RegExp(`.{1,${maxLength}}`, "g")) : [rawLine];
    for (const piece of line) {
      const candidate = current ? `${current}\n${piece}` : piece;
      if (candidate.length > maxLength && current) {
        parts.push(current.trim());
        current = piece;
      } else current = candidate;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.map((part, index) => parts.length > 1 ? `**(${index + 1}/${parts.length})**\n${part}` : part);
}

function renderShare() {
  applyReviewEdits();
  const markdown = formatNotesMarkdown(currentNotes, currentSession);
  const parts = splitDiscord(markdown);
  els.shareParts.innerHTML = parts.map((part, index) => `<article class="share-card"><div class="share-card-header"><strong>Part ${index + 1} of ${parts.length}</strong><button class="copy-part" data-copy-index="${index}" type="button">Copy part</button></div><pre>${escapeHtml(part)}</pre></article>`).join("");
  els.shareParts.querySelectorAll(".copy-part").forEach((button) => {
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(parts[Number(button.dataset.copyIndex)]);
      showToast("Copied to clipboard.");
    });
  });
  els.copyFull.onclick = async () => {
    await navigator.clipboard.writeText(markdown);
    showToast("Full Markdown copied.");
  };
  showView(els.shareView);
}

async function findRecovery() {
  const sessions = await listSessions();
  const candidate = sessions.find((session) => ["recording", "recorded", "processing"].includes(session.status));
  if (!candidate) return;
  const segments = await getSessionSegments(candidate.id);
  if (!segments.length) return;
  els.recoveryPanel.hidden = false;
  els.recoveryText.textContent = `${candidate.title} · ${segments.length} saved audio segment${segments.length === 1 ? "" : "s"}`;
  els.processRecovered.onclick = () => processSession(candidate.id);
  els.discardRecovered.onclick = async () => {
    if (confirm("Delete this recovered meeting and its audio?")) {
      await deleteSession(candidate.id);
      els.recoveryPanel.hidden = true;
    }
  };
}

function newMeeting() {
  currentSession = null;
  currentTranscript = [];
  currentNotes = null;
  els.approveNotes.checked = false;
  els.openShare.disabled = true;
  els.consent.checked = false;
  micTestPassed = false;
  setStatus(els.micTestResult, "Run a microphone test before starting.", "neutral");
  updateStartButton();
  showView(els.setupView);
  findRecovery();
}

function initialize() {
  const supported = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && window.indexedDB);
  setStatus(els.supportBadge, supported ? "Device supported" : "Browser unsupported", supported ? "good" : "error");
  els.testMic.disabled = !supported;
  const connection = getConnection();
  els.apiUrl.value = connection.url;
  els.apiToken.value = connection.token;
  if (!connection.url || !connection.token) {
    els.connectionPanel.hidden = false;
    els.settingsToggle.setAttribute("aria-expanded", "true");
  }
  if (!els.meetingTitle.value) els.meetingTitle.value = `Meeting ${new Date().toLocaleDateString()}`;
  updateStartButton();
  findRecovery();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

els.settingsToggle.addEventListener("click", () => {
  els.connectionPanel.hidden = !els.connectionPanel.hidden;
  els.settingsToggle.setAttribute("aria-expanded", String(!els.connectionPanel.hidden));
});
els.saveConnection.addEventListener("click", () => {
  try { saveConnection(); showToast("Connection settings saved."); } catch (error) { showToast(error.message); }
});
els.testConnection.addEventListener("click", testConnection);
els.testMic.addEventListener("click", testMicrophone);
els.meetingTitle.addEventListener("input", updateStartButton);
els.consent.addEventListener("change", updateStartButton);
els.startRecording.addEventListener("click", startRecording);
els.stopRecording.addEventListener("click", stopRecording);
els.retryProcessing.addEventListener("click", () => retryAction?.());
els.notesTab.addEventListener("click", () => {
  els.notesTab.classList.add("active"); els.transcriptTab.classList.remove("active");
  els.notesTab.setAttribute("aria-selected", "true"); els.transcriptTab.setAttribute("aria-selected", "false");
  els.notesPanel.hidden = false; els.transcriptPanel.hidden = true;
});
els.transcriptTab.addEventListener("click", () => {
  els.transcriptTab.classList.add("active"); els.notesTab.classList.remove("active");
  els.transcriptTab.setAttribute("aria-selected", "true"); els.notesTab.setAttribute("aria-selected", "false");
  els.transcriptPanel.hidden = false; els.notesPanel.hidden = true;
});
els.approveNotes.addEventListener("change", () => { els.openShare.disabled = !els.approveNotes.checked; });
els.openShare.addEventListener("click", renderShare);
els.backToSetup.addEventListener("click", newMeeting);
els.shareNewMeeting.addEventListener("click", newMeeting);

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "hidden" && isRecording) {
    currentSession.warnings.push(`The app left the foreground near ${formatTime(performance.now() - recordingStartedAt)}. Review this part of the transcript.`);
    await dbPut("sessions", currentSession);
  } else if (document.visibilityState === "visible" && isRecording) {
    await requestWakeLock();
    setStatus(els.audioHealth, "Recording resumed in the foreground. Review for a possible gap.", "warning");
  }
});

window.addEventListener("beforeunload", (event) => {
  if (isRecording) { event.preventDefault(); event.returnValue = ""; }
});

initialize();
