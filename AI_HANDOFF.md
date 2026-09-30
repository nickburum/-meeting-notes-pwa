# AI handoff

- Frontend: `docs/` (static, ES module `app.js`, service worker `sw.js`). Site: https://nickburum.github.io/-meeting-notes-pwa/
- Backend: `worker/` (Cloudflare Workers AI: Whisper large-v3-turbo transcription, Llama 3.3 70B fp8-fast notes; 3.1 8B is deprecated / lacks JSON Schema). Endpoints: `/health`, `/v1/transcribe`, `/v1/notes`.
- Notes are untrusted model output; the frontend withholds any item whose cited segment IDs and verbatim quote don't verify against the transcript.
- Segments are 2 minutes with 3 s overlap, saved to IndexedDB on rotation/stop.
- Deployment: Pages via `.github/workflows/pages.yml`; Worker via `npm run deploy` in `worker/` (or optional `worker.yml` with repo secrets).
