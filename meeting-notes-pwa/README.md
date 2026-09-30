# Meeting Notes PWA

A free, installable iPhone web app that records an in-person meeting, transcribes it, creates evidence-linked notes, and formats the result for Discord.

This version uses GitHub Pages with a Cloudflare Workers AI Free backend. No always-on computer or home-network connection is required.

No API keys or owner tokens are stored in the public frontend repository. The app asks for its backend URL and owner token once, then stores them only in that browser.

## Fastest route tonight

For a click-by-click deadline checklist, open [`DEPLOY_TONIGHT.md`](DEPLOY_TONIGHT.md).

### 1. Publish the website

1. Create a new **public** GitHub repository.
2. Upload this entire folder or push it with Git.
3. In the repository, open **Settings → Pages**.
4. Select **Deploy from a branch**, branch `main`, folder `/docs`, then Save.
5. GitHub will show the URL `https://nickburum.github.io/-meeting-notes-pwa/`.

### 2. Deploy the free cloud backend

Install Node.js 20 or later, then run:

```bash
cd worker
npm install
npx wrangler login
```

`wrangler.jsonc` is already configured for the GitHub Pages origin `https://nickburum.github.io`. Do not add the repository path.

Generate and save an owner token:

```bash
openssl rand -hex 32
npx wrangler secret put APP_TOKEN
```

Paste the generated token into Wrangler when asked, then deploy:

```bash
npm test
npm run deploy
```

Wrangler prints a URL such as `https://meeting-notes-api.YOUR-SUBDOMAIN.workers.dev`.

### 3. Connect and install the iPhone app

1. Open the GitHub Pages URL in Safari.
2. Open **Connection settings**.
3. Paste the Worker URL and owner token, then tap **Test connection**.
4. Tap Safari’s Share button and choose **Add to Home Screen**.
5. Open the installed app and make a 20-second test recording before the real meeting.

## Free-plan limit

Cloudflare Workers AI currently includes 10,000 neurons per day on Workers Free. Whisper Large v3 Turbo uses 46.63 neurons per audio minute, so one hour of audio uses about 2,798 neurons before note generation. When the free allowance is exhausted, requests fail until the daily reset; this project does not automatically enable paid billing.

## Accuracy boundaries

- Review notes before sharing. No transcription system is perfect.
- Version 1 does not invent speaker labels.
- Every generated decision and action item includes transcript evidence.
- Owners and deadlines are left blank unless explicitly supported.
- Keep the iPhone app visible and the screen awake while recording.
- Obtain consent from everyone before recording.

## Project layout

```text
docs/        Static GitHub Pages PWA
worker/      Cloudflare Workers AI backend
tests/       Shared contract and frontend logic tests
```

## Local frontend test

```bash
cd docs
python3 -m http.server 8080
```

Open `http://localhost:8080`. Microphone access on iPhone requires HTTPS, so use the deployed GitHub Pages site for device testing.
