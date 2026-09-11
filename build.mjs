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
 *
 * They come in two layers, and the split is not cosmetic:
 *
 *   catalogue.schema.json   the shape. It is also the file a consumer reads to
 *                           write a client, so it is enforced here rather than
 *                           left as prose — a schema nobody checks becomes a
 *                           description of what the build used to accept.
 *   the checks in this file the meaning. That an image chain needs vision, that
 *                           an embedding chain must not have a fallback, that a
 *                           version may not be reused: no schema says any of it.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { generateKeyPairSync, sign, verify, createPrivateKey } from "node:crypto";

const SCHEMA = "catalogue.schema.json";
const PUBLIC = "catalogue-public.pem";

/**
 * The catalogues this repository publishes. Same schema, same key, same rules;
 * different files, and a consumer decides for itself which it needs.
 *
 *   config  what every deployment fetches. Its purposes are the routing
 *           decision, so a change here changes which model a feature calls.
 *   lineup  every Flash model the provider publishes, with its rate. Nothing
 *           routes from it. It exists so a cost report can price a model the
 *           routing catalogue has no opinion about, instead of falling back to
 *           fallbackPrice and reading plausibly while being wrong.
 *
 * lineup is stable-only on purpose. Canary exists to break a few deployments
 * first, and nothing breaks from a price table nobody routes from.
 */
const CATALOGUES = {
  config: { src: "catalogue.src.json", prefix: "config", channels: ["stable", "canary"] },
  lineup: { src: "lineup.src.json", prefix: "lineup", channels: ["stable"] },
};

/**
 * Where the private key is, when it is a file at all.
 *
 * CATALOGUE_KEY carries the PEM itself so that CI can sign without the key ever
 * being a file on anyone's laptop. CATALOGUE_KEY_FILE is for the other case: a
 * key kept somewhere other than this directory, which is where the README tells
 * you to keep it.
 */
const PRIVATE_FILE = process.env.CATALOGUE_KEY_FILE ?? "catalogue-private.pem";


const args = process.argv.slice(2);
const nameArg = args.find((a) => a.startsWith("--catalogue="))?.split("=")[1] ?? "config";
const positional = args.filter((a) => !a.startsWith("--"));

if (!Object.hasOwn(CATALOGUES, nameArg)) {
  console.error(`✗ unknown catalogue "${nameArg}" — expected one of: ${Object.keys(CATALOGUES).join(", ")}`);
  process.exit(1);
}
const CATALOGUE = CATALOGUES[nameArg];
const SRC = CATALOGUE.src;
const CHANNELS = CATALOGUE.channels;

if (positional[0] === "keygen") {
  if (existsSync(PRIVATE_FILE)) {
    console.error(`${PRIVATE_FILE} already exists. Refusing to overwrite it — every`);
    console.error("deployment already carrying the matching public key would");
    console.error("reject every catalogue you sign with a new one.");
    process.exit(1);
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // 0600: the key is the whole of the authority this repository has over a
  // fleet, and it spends its life in a directory that is otherwise public.
  writeFileSync(PRIVATE_FILE, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(PUBLIC, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
  console.log(`wrote ${PRIVATE_FILE} (gitignored — back it up elsewhere)`);
  console.log(`wrote ${PUBLIC} (commit this; embed it in the product build)`);
  console.log("to sign from CI, put the private PEM in a secret named CATALOGUE_KEY");
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

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

// ---- channel ---------------------------------------------------------------

/**
 * A typo used to sign perfectly happily into config.<typo>.json: a valid,
 * correctly signed file that nobody fetches, sitting next to a config.stable.json
 * still holding last month's models. Nothing downstream could notice, because
 * every deployment was reading a file that was exactly as it had always been.
 */
const channel = positional[0] || src.channel;
if (!CHANNELS.includes(channel)) {
  console.error(`✗ unknown channel "${channel}" for ${nameArg} — expected one of: ${CHANNELS.join(", ")}`);
  console.error("  nothing was signed.");
  process.exit(1);
}
src.channel = channel;

const out = `${CATALOGUE.prefix}.${channel}.json`;

// ---- shape, against catalogue.schema.json -----------------------------------

/**
 * Just enough JSON Schema to check this repository's own schema, and no more.
 *
 * Rather than take a dependency, this walks the subset catalogue.schema.json
 * actually uses — and throws on any keyword it does not implement, so that a
 * keyword added to the schema later cannot sit there validating nothing while
 * reading as though it validates something.
 */
const SUPPORTED = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description",
  "type", "required", "properties", "additionalProperties",
  "enum", "const", "items", "minItems", "minProperties", "minLength",
  "minimum", "exclusiveMinimum",
]);

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

const child = (path, key) => (path ? `${path}.${key}` : String(key));

function checkSchema(value, schema, root, path, errors) {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) {
      throw new Error(
        `${SCHEMA} uses "${keyword}" at ${path || "the root"}, which build.mjs does not implement. ` +
          `Implement it or take it out — a keyword nobody enforces is worse than no schema at all.`
      );
    }
  }

  if (schema.$ref) {
    const name = schema.$ref.replace("#/$defs/", "");
    const target = root.$defs?.[name];
    if (!target) throw new Error(`${SCHEMA} refers to ${schema.$ref}, which is not defined`);
    return checkSchema(value, target, root, path, errors);
  }

  const here = path || "(root)";
  const actual = typeOf(value);

  if (schema.type) {
    const want = Array.isArray(schema.type) ? schema.type : [schema.type];
    // An integer is a number; a number is not an integer.
    const ok = want.some((w) => w === actual || (w === "number" && actual === "integer"));
    if (!ok) {
      errors.push(`${here} is ${actual}, expected ${want.join(" or ")}`);
      return;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${here} is ${JSON.stringify(value)}, expected one of: ${schema.enum.join(", ")}`);
  }
  if ("const" in schema && value !== schema.const) {
    errors.push(`${here} is ${JSON.stringify(value)}, expected ${JSON.stringify(schema.const)}`);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${here} is ${value}, expected at least ${schema.minimum}`);
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) errors.push(`${here} is ${value}, expected greater than ${schema.exclusiveMinimum}`);
  }
  if (typeof value === "string" && schema.minLength != null && value.length < schema.minLength) {
    errors.push(`${here} is empty`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(`${here} has ${value.length} items, expected at least ${schema.minItems}`);
    }
    if (schema.items) value.forEach((v, i) => checkSchema(v, schema.items, root, `${here}[${i}]`, errors));
    return;
  }

  if (value && typeof value === "object") {
    if (schema.minProperties != null && Object.keys(value).length < schema.minProperties) {
      errors.push(`${here} is empty`);
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${child(path, key)} is required`);
    }
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (sub) { checkSchema(v, sub, root, child(path, key), errors); continue; }
      if (schema.additionalProperties === false) {
        errors.push(`${child(path, key)} is not a field this catalogue has — a typo here is silently ignored by every consumer`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        checkSchema(v, schema.additionalProperties, root, child(path, key), errors);
      }
    }
  }
}

const schemaErrors = [];
const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
checkSchema(src, schema, schema, "", schemaErrors);
for (const e of schemaErrors) fail(e);

// ---- meaning ---------------------------------------------------------------

// Duplicated with the schema on purpose, for the three fields where the message
// is the point: a build that says only "expected at least 1" has told whoever
// is reading the CI log nothing about what it costs to get this wrong.
if (!Number.isInteger(src.version) || src.version < 1) fail("version must be a positive integer");
if (!Number.isInteger(src.minClientVersion) || src.minClientVersion < 1) fail("minClientVersion must be a positive integer");
if (typeof src.usdToThb !== "number" || src.usdToThb <= 0) fail("usdToThb must be a positive number");
if (!src.purposes?.default?.length) fail("purposes.default is required — a feature added later has no chain without it");
if (!src.fallbackPrice) fail("fallbackPrice is required");
if (src.publishedAt != null && Number.isNaN(Date.parse(src.publishedAt))) fail("publishedAt is not a date");

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

for (const [id, m] of Object.entries(src.models ?? {})) {
  const p = m?.price;
  if (!p || typeof p.input !== "number" || typeof p.cachedInput !== "number" || typeof p.output !== "number") {
    fail(`model ${id} has no complete price — the cost report would fall back to fallbackPrice and read plausibly but wrong`);
  }
  if (m?.retiresOn != null && Number.isNaN(Date.parse(m.retiresOn))) fail(`model ${id} retiresOn is not a date`);
  if (m?.embedding && !Number.isInteger(m.dim)) fail(`embedding model ${id} must declare dim`);
}

const VISION_PURPOSES = new Set(["attachment-vision", "booking-slip-ocr", "order-slip-ocr", "inbox-slip-ocr"]);
const EMBED_PURPOSES = new Set(["kb-embed-index", "kb-embed-query"]);

for (const [purpose, chain] of Object.entries(src.purposes ?? {})) {
  if (!Array.isArray(chain) || chain.length === 0) { fail(`purpose ${purpose} has an empty chain`); continue; }
  for (const id of chain) {
    const m = src.models?.[id];
    if (!m) { fail(`purpose ${purpose} names model ${id}, which is not in models`); continue; }
    if (VISION_PURPOSES.has(purpose) && !m.vision) fail(`purpose ${purpose} reads images but ${id} has vision:false`);
    if (m.status === "retired") fail(`purpose ${purpose} names ${id}, which is marked retired`);
  }
  if (EMBED_PURPOSES.has(purpose)) {
    if (chain.length !== 1) fail(`purpose ${purpose} must name exactly one model — a fallback would write two models' vectors into one table that retrieval reads without filtering by model`);
    if (!src.models?.[chain[0]]?.embedding) fail(`purpose ${purpose} names ${chain[0]}, which is not marked embedding:true`);
  }
}

if (process.exitCode) {
  console.error("\nnothing was signed.");
  process.exit(1);
}

// ---- sign -----------------------------------------------------------------

/**
 * The key, from a secret store or from disk.
 *
 * A PEM pasted into a web form usually arrives with its newlines escaped, and
 * the error that produces names nothing that would lead anyone to the cause, so
 * that one case is repaired here rather than reported.
 */
function loadPrivateKey() {
  const inline = process.env.CATALOGUE_KEY;
  if (inline && inline.trim()) {
    const pem = inline.trim().replace(/\\n/g, "\n");
    if (!pem.includes("BEGIN")) {
      console.error("CATALOGUE_KEY is set but does not look like a PEM document.");
      console.error("It carries the key itself, not a path to one — use CATALOGUE_KEY_FILE for a path.");
      process.exit(1);
    }
    return createPrivateKey(pem.endsWith("\n") ? pem : `${pem}\n`);
  }
  if (!existsSync(PRIVATE_FILE)) {
    console.error(`missing ${PRIVATE_FILE}.`);
    console.error("Run `node build.mjs keygen`, or set CATALOGUE_KEY to the private PEM itself.");
    process.exit(1);
  }
  return createPrivateKey(readFileSync(PRIVATE_FILE, "utf8"));
}

// A string, not a nested object: the signature is over exact bytes, and JSON
// key order would otherwise make a valid file fail to verify for no visible
// reason.
const payload = JSON.stringify(src);
const sig = sign(null, Buffer.from(payload, "utf8"), loadPrivateKey()).toString("base64");

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

console.log(`✓ ${out} · ${nameArg} · version ${src.version} · channel ${channel} · minClient ${src.minClientVersion}`);
console.log(`  ${Object.keys(src.models).length} models · ${Object.keys(src.purposes).length} purposes · ${payload.length} bytes signed`);
if (retiring.length) console.log(`  retiring: ${retiring.join(" · ")}`);
