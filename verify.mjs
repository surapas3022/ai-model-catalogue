/**
 * Proves the signature works and that build.mjs refuses the mistakes it claims
 * to refuse. Run it after any change to build.mjs or catalogue.schema.json.
 *
 *   node verify.mjs
 *
 * It needs a private key, because most of what it proves is about signing.
 * Either catalogue-private.pem is here, or CATALOGUE_KEY carries the PEM — the
 * same two ways build.mjs itself takes one, so CI can run this before it
 * publishes.
 */
import { readFileSync, writeFileSync, rmSync, mkdtempSync, copyFileSync, existsSync } from "node:fs";
import { verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
};

const PUB = readFileSync("catalogue-public.pem", "utf8");
const good = JSON.parse(readFileSync("config.stable.json", "utf8"));

/** The key, however it was supplied. Everything below signs with it. */
const PRIVATE_PEM = (() => {
  const inline = process.env.CATALOGUE_KEY;
  if (inline && inline.trim()) return inline.trim().replace(/\\n/g, "\n") + "\n";
  if (existsSync("catalogue-private.pem")) return readFileSync("catalogue-private.pem", "utf8");
  console.error("no private key: put catalogue-private.pem here or set CATALOGUE_KEY.");
  process.exit(1);
})();

console.log("\n1. the signature on what we publish");
check("config.stable.json verifies with the public key",
  verify(null, Buffer.from(good.payload, "utf8"), PUB, Buffer.from(good.sig, "base64")));

const tampered = good.payload.replace("gemini-3.7-flash", "gemini-9.9-evil");
check("payload changed by one model name no longer verifies",
  tampered !== good.payload &&
  !verify(null, Buffer.from(tampered, "utf8"), PUB, Buffer.from(good.sig, "base64")));

const bitflip = good.payload.slice(0, -1) + (good.payload.endsWith("}") ? " " : "}");
check("payload changed by one character no longer verifies",
  !verify(null, Buffer.from(bitflip, "utf8"), PUB, Buffer.from(bitflip === good.payload ? "" : good.sig, "base64")));

const parsed = JSON.parse(good.payload);
console.log("\n2. what the payload carries");
check("no _comment keys reached the wire", !good.payload.includes('"_'));
check("channel is stamped inside the payload, not only in the filename", parsed.channel === "stable");
check("every model in every chain exists in models",
  Object.values(parsed.purposes).flat().every((m) => parsed.models[m]));
check("every model has a complete price",
  Object.values(parsed.models).every((m) => typeof m.price?.input === "number" && typeof m.price?.output === "number"));
check("purposes.default exists", Array.isArray(parsed.purposes.default) && parsed.purposes.default.length > 0);
check("embedding chains name exactly one model",
  ["kb-embed-index", "kb-embed-query"].every((p) => parsed.purposes[p].length === 1));
check("image-reading chains only name vision models",
  ["attachment-vision", "booking-slip-ocr", "order-slip-ocr", "inbox-slip-ocr"]
    .every((p) => parsed.purposes[p].every((m) => parsed.models[m].vision === true)));

// ---- the sandbox every build below runs in ---------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "cat-"));
const SANDBOX_FILES = ["build.mjs", "catalogue.schema.json", "catalogue-public.pem"];
for (const f of SANDBOX_FILES) copyFileSync(f, path.join(dir, f));
writeFileSync(path.join(dir, "catalogue-private.pem"), PRIVATE_PEM, { mode: 0o600 });

const runBuild = (args = [], env = {}) =>
  execFileSync("node", ["build.mjs", ...args], { cwd: dir, stdio: "pipe", env: { ...process.env, ...env } });

const messageOf = (e) => (e.stderr?.toString() || "") + (e.stdout?.toString() || "");

/** Writes a mutated source into the sandbox and expects build.mjs to refuse it. */
const refuses = (name, mutate, expectInMessage) => {
  const src = JSON.parse(readFileSync("catalogue.src.json", "utf8"));
  mutate(src);
  writeFileSync(path.join(dir, "catalogue.src.json"), JSON.stringify(src, null, 2));
  rmSync(path.join(dir, "config.stable.json"), { force: true });
  try {
    runBuild();
    check(name, false, "build succeeded when it should have refused");
  } catch (e) {
    const msg = messageOf(e);
    check(name, msg.includes(expectInMessage), `message did not mention "${expectInMessage}"`);
  }
};

console.log("\n3. build.mjs refuses what it says it refuses");
refuses("a chain naming a model that does not exist",
  (s) => { s.purposes["auto-reply"] = ["gemini-does-not-exist"]; }, "not in models");
refuses("an image chain naming a model with vision:false",
  (s) => { s.purposes["attachment-vision"] = ["gemini-3.1-flash-lite"]; }, "vision:false");
refuses("an embedding chain with a fallback in it",
  (s) => { s.purposes["kb-embed-index"] = ["gemini-embedding-001", "gemini-3.7-flash"]; }, "exactly one model");
refuses("a chain naming a model marked retired",
  (s) => { s.models["gemini-3.5-flash-lite"].status = "retired"; }, "marked retired");
refuses("an embedding model with no dim",
  (s) => { delete s.models["gemini-embedding-001"].dim; }, "must declare dim");
refuses("a model with no price",
  (s) => { delete s.models["gemini-3.7-flash"].price; }, "no complete price");
refuses("no default chain",
  (s) => { delete s.purposes.default; }, "purposes.default is required");
refuses("version zero",
  (s) => { s.version = 0; }, "positive integer");

console.log("\n4. the schema catches what is merely the wrong shape");
refuses("a misspelled top-level field",
  (s) => { s.usdToTHB = s.usdToThb; delete s.usdToThb; }, "not a field this catalogue has");
refuses("a status outside the list",
  (s) => { s.models["gemini-3.7-flash"].status = "probably-fine"; }, "expected one of");
refuses("a missing publishedAt",
  (s) => { delete s.publishedAt; }, "publishedAt is required");
refuses("vision written as a string",
  (s) => { s.models["gemini-3.7-flash"].vision = "yes"; }, "expected boolean");
refuses("a price field that is not a number",
  (s) => { s.models["gemini-3.7-flash"].price.input = "0.3"; }, "expected number");

console.log("\n5. version only goes up");
{
  const src = JSON.parse(readFileSync("catalogue.src.json", "utf8"));
  writeFileSync(path.join(dir, "catalogue.src.json"), JSON.stringify(src, null, 2));
  rmSync(path.join(dir, "config.stable.json"), { force: true });
  runBuild();                                                   // first publish
  try {
    runBuild();                                                 // same version again
    check("republishing the same version is refused", false, "it was allowed");
  } catch (e) {
    check("republishing the same version is refused", messageOf(e).includes("is not newer"));
  }
  src.version += 1;
  writeFileSync(path.join(dir, "catalogue.src.json"), JSON.stringify(src, null, 2));
  let ok = true;
  try { runBuild(); } catch { ok = false; }
  check("a higher version publishes", ok);
}

console.log("\n6. the channel is a closed list");
{
  // Restore the real source, so what follows signs the thing we actually publish.
  copyFileSync("catalogue.src.json", path.join(dir, "catalogue.src.json"));
  rmSync(path.join(dir, "config.stable.json"), { force: true });
  try {
    runBuild(["stabel"]);
    check("a misspelled channel is refused", false, "it was allowed");
  } catch (e) {
    check("a misspelled channel is refused", messageOf(e).includes("unknown channel"));
  }
  check("and no file was written under the misspelled name",
    !existsSync(path.join(dir, "config.stabel.json")));

  let ok = true;
  try { runBuild(["canary"]); } catch { ok = false; }
  const canary = ok && JSON.parse(readFileSync(path.join(dir, "config.canary.json"), "utf8"));
  check("canary still publishes, and says canary inside the payload",
    ok && JSON.parse(canary.payload).channel === "canary");
}

console.log("\n7. the key can come from a secret instead of a file");
{
  rmSync(path.join(dir, "config.stable.json"), { force: true });
  rmSync(path.join(dir, "catalogue-private.pem"), { force: true });
  let ok = true;
  try { runBuild([], { CATALOGUE_KEY: PRIVATE_PEM }); } catch { ok = false; }
  const signed = ok && JSON.parse(readFileSync(path.join(dir, "config.stable.json"), "utf8"));
  check("CATALOGUE_KEY signs a file that verifies with the published public key",
    ok && verify(null, Buffer.from(signed.payload, "utf8"), PUB, Buffer.from(signed.sig, "base64")));

  // A secret pasted into a web form arrives with its newlines escaped.
  rmSync(path.join(dir, "config.stable.json"), { force: true });
  let escapedOk = true;
  try { runBuild([], { CATALOGUE_KEY: PRIVATE_PEM.replace(/\n/g, "\\n") }); } catch { escapedOk = false; }
  check("a PEM whose newlines were escaped is repaired rather than rejected", escapedOk);

  // Each run needs a clean slate: the monotonic check fires before the key is
  // ever read, so a leftover config.stable.json would fail these for the wrong
  // reason and report a guard as working when it had not been reached.
  rmSync(path.join(dir, "config.stable.json"), { force: true });
  try {
    runBuild([], { CATALOGUE_KEY: "/some/path/to/a/key.pem" });
    check("a CATALOGUE_KEY that is a path, not a key, is refused", false, "it was allowed");
  } catch (e) {
    check("a CATALOGUE_KEY that is a path, not a key, is refused",
      messageOf(e).includes("does not look like a PEM"));
  }

  rmSync(path.join(dir, "config.stable.json"), { force: true });
  try {
    runBuild([], { CATALOGUE_KEY: "" });
    check("with no key at all, build refuses instead of writing an unsigned file", false, "it was allowed");
  } catch (e) {
    check("with no key at all, build refuses instead of writing an unsigned file",
      messageOf(e).includes("missing catalogue-private.pem"));
  }
  writeFileSync(path.join(dir, "catalogue-private.pem"), PRIVATE_PEM, { mode: 0o600 });
}

console.log("\n8. the schema cannot quietly stop checking");
{
  const realSchema = readFileSync("catalogue.schema.json", "utf8");
  const withUnknown = JSON.parse(realSchema);
  withUnknown.properties.version.oneOf = [{ type: "integer" }];
  writeFileSync(path.join(dir, "catalogue.schema.json"), JSON.stringify(withUnknown, null, 2));
  copyFileSync("catalogue.src.json", path.join(dir, "catalogue.src.json"));
  rmSync(path.join(dir, "config.stable.json"), { force: true });
  try {
    runBuild();
    check("a schema keyword build.mjs does not implement is refused", false, "it was allowed");
  } catch (e) {
    check("a schema keyword build.mjs does not implement is refused",
      messageOf(e).includes("does not implement"));
  }
  writeFileSync(path.join(dir, "catalogue.schema.json"), realSchema);
}

console.log("\n9. what is published is what this build produces");
{
  copyFileSync("catalogue.src.json", path.join(dir, "catalogue.src.json"));
  rmSync(path.join(dir, "config.stable.json"), { force: true });
  let ok = true;
  try { runBuild(); } catch { ok = false; }
  const rebuilt = ok && readFileSync(path.join(dir, "config.stable.json"), "utf8");
  // Catches a config.*.json edited by hand, and a published file that predates
  // a change to the source or the schema and was never regenerated.
  check("config.stable.json is byte-for-byte what building the source produces now",
    rebuilt === readFileSync("config.stable.json", "utf8"));
}

console.log("\n10. the second catalogue, and the one thing having two of them can break");
{
  const lineupFile = readFileSync("lineup.stable.json", "utf8");
  const { payload, sig } = JSON.parse(lineupFile);
  check("lineup.stable.json verifies with the same public key",
    verify(null, Buffer.from(payload, "utf8"), PUB, Buffer.from(sig, "base64")));

  const lineup = JSON.parse(payload);
  check("no _comment keys reached the wire", !payload.includes('"_'));
  check("it is stamped stable, and has no canary to be confused with", lineup.channel === "stable");
  check("it carries a default chain, because the format requires one",
    Array.isArray(lineup.purposes?.default) && lineup.purposes.default.length > 0);
  check("every model in it has a complete price",
    Object.values(lineup.models).every((m) => typeof m.price?.input === "number" &&
      typeof m.price?.cachedInput === "number" && typeof m.price?.output === "number"));

  // The reason to check this is the reason the two files are dangerous: a rate
  // corrected in one and forgotten in the other produces two defensible cost
  // reports that disagree, and nothing in either file looks wrong.
  const disagree = Object.entries(parsed.models)
    .filter(([id]) => lineup.models[id])
    .filter(([id, m]) => JSON.stringify(m.price) !== JSON.stringify(lineup.models[id].price))
    .map(([id]) => id);
  check("every model in both catalogues carries the same price in both",
    disagree.length === 0, disagree.length ? `disagree on: ${disagree.join(", ")}` : "");

  // A routing catalogue that names a model the lineup has never heard of is not
  // wrong, but it is the case the lineup exists to remove.
  const unpriced = [...new Set(Object.values(parsed.purposes).flat())].filter((id) => !lineup.models[id]);
  check("every model the routing catalogue can reach also appears in the lineup",
    unpriced.length === 0, unpriced.length ? `missing from lineup: ${unpriced.join(", ")}` : "");

  copyFileSync("lineup.src.json", path.join(dir, "lineup.src.json"));
  rmSync(path.join(dir, "lineup.stable.json"), { force: true });
  let ok = true;
  try { runBuild(["--catalogue=lineup"]); } catch { ok = false; }
  const rebuilt = ok && readFileSync(path.join(dir, "lineup.stable.json"), "utf8");
  check("lineup.stable.json is byte-for-byte what building its source produces now",
    rebuilt === lineupFile);

  rmSync(path.join(dir, "lineup.stable.json"), { force: true });
  let refused = false;
  try { runBuild(["canary", "--catalogue=lineup"]); } catch (e) {
    refused = messageOf(e).includes("unknown channel");
  }
  check("the lineup refuses a canary channel it does not have", refused);
}

rmSync(dir, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "all good" : "FAILED"} · ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
