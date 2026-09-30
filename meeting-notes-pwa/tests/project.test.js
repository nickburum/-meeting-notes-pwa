import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(root, "docs");
const html = readFileSync(join(docs, "index.html"), "utf8");
const app = readFileSync(join(docs, "app.js"), "utf8");
const worker = readFileSync(join(root, "worker/src/index.js"), "utf8");

test("every frontend DOM dependency exists in the HTML", () => {
  const list = app.match(/Object\.fromEntries\(\[([\s\S]*?)\]\.map/)?.[1] || "";
  const ids = [...list.matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)].map((match) => match[1]);
  assert.ok(ids.length > 30);
  for (const id of ids) assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
});

test("manifest and service-worker app-shell files exist", () => {
  const manifest = JSON.parse(readFileSync(join(docs, "manifest.webmanifest"), "utf8"));
  for (const icon of manifest.icons) assert.ok(existsSync(join(docs, icon.src.replace(/^\.\//, ""))), icon.src);
  const serviceWorker = readFileSync(join(docs, "sw.js"), "utf8");
  const assets = [...serviceWorker.matchAll(/"(\.\/[^"?]+)"/g)].map((match) => match[1]);
  for (const asset of assets) {
    if (asset === "./") continue;
    assert.ok(existsSync(join(docs, asset.slice(2))), asset);
  }
});

test("public frontend contains no backend secret", () => {
  assert.doesNotMatch(html + app, /APP_TOKEN|Bearer [a-f0-9]{32,}/i);
});

test("backend has origin, token, size, and quota controls", () => {
  for (const marker of ["ORIGIN_NOT_ALLOWED", "UNAUTHORIZED", "MAX_AUDIO_BYTES", "DAILY_FREE_QUOTA_EXHAUSTED"])
    assert.match(worker, new RegExp(marker));
});
