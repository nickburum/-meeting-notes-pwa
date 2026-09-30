# Deploy tonight: shortest safe path

Use the cloud route first. It creates a normal public website and does not require the Mac mini. Budget about 30–45 minutes for account sign-in, deployment, and an iPhone test.

## Before you start

You need:

- A free GitHub account
- A free Cloudflare account
- Node.js 20 or later on the computer used for deployment
- An iPhone with Safari

Do not begin with a real meeting. Finish the 20-second test at the end first.

## A. Put the website on GitHub Pages

1. Unzip the project.
2. Use the new public repository at `https://github.com/nickburum/-meeting-notes-pwa`.
3. Upload every item inside the unzipped `meeting-notes-pwa` folder, including the `docs` and `worker` folders.
4. Commit the upload to `main`.
5. Open **Settings → Pages** in the repository.
6. Under **Build and deployment**, choose **Deploy from a branch**.
7. Choose branch `main`, folder `/docs`, and Save.
8. Wait for GitHub to show the site URL: `https://nickburum.github.io/-meeting-notes-pwa/`.
9. Open that URL and leave the tab available.

## B. Deploy the free backend

Open Terminal, move into the unzipped project, then run:

```bash
cd worker
npm install
npx wrangler login
```

Cloudflare opens a browser login. Accept the authorization. The project is already configured with the correct origin, `https://nickburum.github.io`. Do not add `/-meeting-notes-pwa` or a trailing slash.

Generate a secret token:

```bash
openssl rand -hex 32
```

Copy the output into a password manager. Then run:

```bash
npx wrangler secret put APP_TOKEN
```

Paste the token when prompted. Deploy:

```bash
npm test
npm run deploy
```

Copy the final `https://...workers.dev` URL printed by Wrangler.

## C. Connect the iPhone

1. Open the GitHub Pages URL in iPhone Safari.
2. Tap the gear.
3. Paste the `workers.dev` URL and private owner token.
4. Tap **Test connection**. It must say **Cloud connected**.
5. Tap **Save**.
6. In Safari, tap **Share → Add to Home Screen → Add**.
7. Open Meeting Notes from the new Home Screen icon.

Anyone else who needs to use the app opens the same GitHub Pages URL. Give the owner token only to trusted users; they enter it once on their own phone. They do not need access to your home network.

## D. Mandatory 20-second acceptance test

1. In a quiet room, enter a test meeting title and two sample participant names.
2. Add a deliberately unusual spelling under **Names, acronyms, and specialized terms**.
3. Confirm consent, run the microphone test, and record for about 20 seconds.
4. Say one explicit decision and one explicit action item with an owner and due date.
5. Stop and wait for the notes.
6. Verify the transcript, evidence snippets, decision, owner, and due date.
7. Check **I reviewed these notes**, prepare the Discord text, and paste it into a private Discord draft channel.

Do not use the system for the real meeting if this test fails. Keep the raw iPhone Voice Memos app as a backup for the first live meeting.

## If Cloudflare says the daily allowance is exhausted

The recording remains in the browser’s local database. Retry after Cloudflare’s daily reset at 00:00 UTC.

## Reliability rules for the first meeting

- Keep the installed app visible; do not lock the iPhone or switch apps.
- Put the phone near the center of the table, uncovered and away from fans.
- Ask people not to talk over one another when assigning work or making decisions.
- Enter unusual names and terms before recording.
- Review the transcript and every note before posting.
- No automatic transcript can be guaranteed perfect; the evidence links and human approval step are mandatory safeguards.
