# Agent notes

Framework-free PWA in `docs/` (GitHub Pages) plus a Cloudflare Worker in `worker/`.
Do not add a build stack or paid services. Never commit tokens; `APP_TOKEN` lives only in Cloudflare secrets and the user's browser.
Bump the cache name in `docs/sw.js` whenever cached frontend assets change.
Verify with: `node --check docs/app.js && node --check worker/src/index.js && node --test tests/project.test.js && (cd worker && npm test)`.
