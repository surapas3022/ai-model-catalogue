/**
 * Signs catalogue.src.json into config.<channel>.json.
 *
 *   node build.mjs keygen     once, ever — writes the key pair
 *   node build.mjs            signs for the channel named in the source file
 *   node build.mjs canary     signs the same source as the canary channel
 *
 * The checks below run before anything is signed, because every one of them
 * describes a mistake that is cheap to catch here and expensive once a fleet
 * of deployments has fetched it.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { generateKeyPairSync, sign, verify } from "node:crypto";

const SRC = "catalogue.src.json";
const PRIVATE = process.env.CATALOGUE_KEY ?? "catalogue-private.pem";
const PUBLIC = "catalogue-public.pem";

if (process.argv[2] === "keygen") {
  if (existsSync(PRIVATE)) {
    console.error(`${PRIVATE} already exists. Refusing to overwrite it — every`);
    console.error("deployment already carrying the matching public key would");
    console.error("reject every catalogue you sign with a new one.");
    process.exit(1);
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(PRIVATE, privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(PUBLIC, publicKey.export({ type: "spki", format: "pem" }));
  console.log(`wrote ${PRIVATE} (gitignored — back it up elsewhere)`);
  console.log(`wrote ${PUBLIC} (commit this; embed it in the product build)`);
  process.exit(0);
}

/** Comments are for whoever edits the source; they do not belong on the wire. */
function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !k.startsWith("_"))
        .map(([k, v]) => [k, stripComments(v)])
    );
  }
  return value;
}

const src = stripComments(JSON.parse(readFileSync(SRC, "utf8")));
const channel = process.argv[2] || src.channel;
src.channel = channel;

const out = `config.${channel}.json`;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

// ---- checks ----------------------------------------------------------------

if (!Number.isInteger(src.version) || src.version < 1) fail("version must be a positive integer");
if (!Number.isInteger(src.minClientVersion) || src.minClientVersion < 1) fail("minClientVersion must be a positive integer");
if (typeof src.usdToThb !== "number" || src.usdToThb <= 0) fail("usdToThb must be a positive number");
if (!src.purposes?.default?.length) fail("purposes.default is required — a feature added later has no chain without it");
if (!src.fallbackPrice) fail("fallbackPrice is required");

// version only ever goes up, for this channel
if (existsSync(out)) {
  try {
    const prev = JSON.parse(JSON.parse(readFileSync(out, "utf8")).payload);
    if (src.version <= prev.version) {
      fail(`version ${src.version} is not newer than the published ${prev.version} in ${out}. ` +
           `To undo a release, raise the version and put the old content back — never reuse a number.`);
    }
  } catch {
    console.warn(`! could not read a version out of ${out}; skipping the monotonic check`);
  }
}

for (const [id, m] of Object.entries(src.models)) {
  const p = m.price;
  if (!p || typeof p.input !== "number" || typeof p.cachedInput !== "number" || typeof p.output !== "number") {
    fail(`model ${id} has no complete price — the cost report would fall back to fallbackPrice and read plausibly but wrong`);
  }
  if (m.retiresOn != null && Number.isNaN(Date.parse(m.retiresOn))) fail(`model ${id} retiresOn is not a date`);
  if (m.embedding && !Number.isInteger(m.dim)) fail(`embedding model ${id} must declare dim`);
}

const VISION_PURPOSES = new Set(["attachment-vision", "booking-slip-ocr", "order-slip-ocr", "inbox-slip-ocr"]);
const EMBED_PURPOSES = new Set(["kb-embed-index", "kb-embed-query"]);

for (const [purpose, chain] of Object.entries(src.purposes)) {
  if (!Array.isArray(chain) || chain.length === 0) { fail(`purpose ${purpose} has an empty chain`); continue; }
  for (const id of chain) {
    const m = src.models[id];
    if (!m) { fail(`purpose ${purpose} names model ${id}, which is not in models`); continue; }
    if (VISION_PURPOSES.has(purpose) && !m.vision) fail(`purpose ${purpose} reads images but ${id} has vision:false`);
    if (m.status === "retired") fail(`purpose ${purpose} names ${id}, which is marked retired`);
  }
  if (EMBED_PURPOSES.has(purpose)) {
    if (chain.length !== 1) fail(`purpose ${purpose} must name exactly one model — a fallback would write two models' vectors into one table that retrieval reads without filtering by model`);
    if (!src.models[chain[0]]?.embedding) fail(`purpose ${purpose} names ${chain[0]}, which is not marked embedding:true`);
  }
}

if (process.exitCode) {
  console.error("\nnothing was signed.");
  process.exit(1);
}

// ---- sign -----------------------------------------------------------------

// A string, not a nested object: the signature is over exact bytes, and JSON
// key order would otherwise make a valid file fail to verify for no visible
// reason.
const payload = JSON.stringify(src);
const privateKey = readFileSync(PRIVATE, "utf8");
const sig = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");

// Verify what we are about to publish, with the key the deployments will use.
if (!existsSync(PUBLIC)) { console.error(`missing ${PUBLIC}`); process.exit(1); }
if (!verify(null, Buffer.from(payload, "utf8"), readFileSync(PUBLIC, "utf8"), Buffer.from(sig, "base64"))) {
  console.error("the signature does not verify against the public key in this directory.");
  console.error("the key pair does not match — do not publish this.");
  process.exit(1);
}

writeFileSync(out, JSON.stringify({ payload, sig }, null, 2) + "\n");

const retiring = Object.entries(src.models)
  .filter(([, m]) => m.retiresOn)
  .map(([id, m]) => `${id} → ${m.retiresOn}`);

console.log(`✓ ${out} · version ${src.version} · channel ${channel} · minClient ${src.minClientVersion}`);
console.log(`  ${Object.keys(src.models).length} models · ${Object.keys(src.purposes).length} purposes · ${payload.length} bytes signed`);
if (retiring.length) console.log(`  retiring: ${retiring.join(" · ")}`);
