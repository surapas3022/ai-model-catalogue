/**
 * Reference consumer for ai-model-catalogue. Copy this into the product and
 * adapt the four marked spots. No dependencies; Node 18+.
 *
 * The one rule this file exists to enforce: **asking which model to use must
 * never be able to fail.** Every path below ends in a usable answer — the
 * freshly fetched catalogue, the last good one on disk, or the floor compiled
 * into the build. A network outage at the CDN is not an outage of the product.
 *
 *   import { startCatalogue, chainFor, priceFor } from "./catalogue-client.mjs";
 *   await startCatalogue();                       // once, at boot
 *   const chain = chainFor("auto-reply");         // anywhere, hot path, sync
 */
import { verify } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// ---- 1. check: the public key, as committed in catalogue-public.pem -------
// Already filled in, because it is public and it is this repository's. Confirm
// it matches catalogue-public.pem and leave it embedded at build time. Fetching
// the key would defeat the signature entirely: whoever can swap the catalogue
// could swap the key that checks it.
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAiyy9g5HsIBtVmlOo4iWQbWYUBjhKwbppkYedlxoiDXo=
-----END PUBLIC KEY-----
`;

// ---- 2. adapt: who publishes, and which channel this build is on ----------
const GITHUB_USER = "surapas3022";
// Stamped when the build is generated, never decided at runtime. A deployment
// does not get to promote itself onto canary.
const CHANNEL = process.env.CATALOGUE_CHANNEL ?? "stable";

// ---- 3. adapt: where this deployment may write a file ---------------------
const CACHE_DIR = process.env.CATALOGUE_CACHE_DIR ?? "./.cache";

// ---- 4. adapt: the floor — a copy of the catalogue as of this build -------
// Trimmed to what the product cannot start without. It answers when there is no
// cache yet and the network is down: first boot on a fresh machine, offline.
const FLOOR = {
  version: 0,
  channel: CHANNEL,
  usdToThb: 36,
  models: {
    "gemini-3.5-flash-lite": { price: { input: 0.1, cachedInput: 0.025, output: 0.4 }, vision: true },
    "gemini-3.1-flash-lite": { price: { input: 0.1, cachedInput: 0.025, output: 0.4 }, vision: false },
  },
  purposes: { default: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"] },
  fallbackPrice: { input: 0.3, cachedInput: 0.075, output: 2.5 },
};

/** Raise this when the product learns to read a field it could not read before. */
const CLIENT_VERSION = 1;

const URL = `https://cdn.jsdelivr.net/gh/${GITHUB_USER}/ai-model-catalogue/config.${CHANNEL}.json`;
const CACHE_FILE = path.join(CACHE_DIR, `catalogue.${CHANNEL}.json`);

let current = FLOOR;

/**
 * Checks a signed file and returns the catalogue inside it, or throws.
 * The payload is verified as the exact bytes that arrived — never parse and
 * re-serialize before this, or the signature stops matching for no visible
 * reason.
 */
function open(fileText) {
  const { payload, sig } = JSON.parse(fileText);
  if (typeof payload !== "string" || typeof sig !== "string") throw new Error("not a signed catalogue");
  if (!verify(null, Buffer.from(payload, "utf8"), PUBLIC_KEY, Buffer.from(sig, "base64"))) {
    throw new Error("signature does not verify — refusing this catalogue");
  }
  const cat = JSON.parse(payload);
  if (cat.channel !== CHANNEL) throw new Error(`catalogue is for channel ${cat.channel}, this build is ${CHANNEL}`);
  if (cat.minClientVersion > CLIENT_VERSION) {
    throw new Error(`catalogue needs client ${cat.minClientVersion}, this build is ${CLIENT_VERSION}`);
  }
  if (!Number.isInteger(cat.version)) throw new Error("catalogue version is not an integer");
  if (!cat.purposes?.default?.length) throw new Error("catalogue has no default chain");
  // A chain naming a model the catalogue does not describe does not crash
  // anything: it produces a cost report that quietly falls back to
  // fallbackPrice and reads plausibly while being wrong, on an invoice somebody
  // pays. build.mjs refuses to sign one, and this refuses to adopt one anyway,
  // because a consumer that trusts the publisher to have checked is a consumer
  // that stops checking.
  for (const [purpose, chain] of Object.entries(cat.purposes)) {
    for (const id of chain) {
      if (!cat.models?.[id]) throw new Error(`purpose ${purpose} names model ${id}, which this catalogue does not describe`);
    }
  }
  return cat;
}

/** Never goes backwards. A stale copy sitting in a CDN edge cannot walk us back. */
function adopt(cat, source) {
  if (cat.version <= current.version) return false;
  current = cat;
  console.log(`catalogue: version ${cat.version} from ${source}`);
  return true;
}

/**
 * Fetches, verifies, adopts, and writes the last-known-good copy.
 * Resolves either way — the caller is not expected to handle failure, because
 * there is nothing useful for it to do about it.
 */
export async function refresh() {
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const cat = open(text);                       // verify BEFORE writing to disk
    if (adopt(cat, "cdn")) {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(CACHE_FILE, text);            // store the signed bytes, not the parsed object
    }
  } catch (err) {
    console.warn(`catalogue: refresh failed (${err.message}); staying on version ${current.version}`);
  }
}

/**
 * Call once at boot. Loads the cached copy first so the product is useful
 * immediately, then fetches. Awaiting it is optional — the floor already
 * answers — but awaiting means the first request uses a current catalogue.
 */
export async function startCatalogue({ refreshEveryMs = 6 * 60 * 60 * 1000 } = {}) {
  try {
    adopt(open(readFileSync(CACHE_FILE, "utf8")), "cache");
  } catch {
    // No cache, or a cache that no longer verifies. The floor stands.
  }
  await refresh();
  // The published URL is mutable, so jsDelivr caches it for hours. Polling
  // faster than that buys nothing.
  const timer = setInterval(refresh, refreshEveryMs);
  timer.unref?.();
  return current;
}

/** The model chain for a feature id, best first. Unknown ids fall to default. */
export function chainFor(purpose) {
  return current.purposes[purpose] ?? current.purposes.default;
}

/** Per-million-token price for a model. Unknown models fall back, never throw. */
export function priceFor(model) {
  return current.models[model]?.price ?? current.fallbackPrice;
}

/** The whole catalogue, for a cost report or a health endpoint. */
export function catalogue() {
  return current;
}
