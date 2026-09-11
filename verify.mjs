/**
 * Proves the signature works and that build.mjs refuses the mistakes it claims
 * to refuse. Run it after any change to build.mjs.
 *
 *   node verify.mjs
 */
import { readFileSync, writeFileSync, rmSync, mkdtempSync, copyFileSync } from "node:fs";
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

// ---- build.mjs must refuse bad sources -------------------------------------
console.log("\n3. build.mjs refuses what it says it refuses");
const dir = mkdtempSync(path.join(tmpdir(), "cat-"));
for (const f of ["build.mjs", "catalogue-private.pem", "catalogue-public.pem"]) copyFileSync(f, path.join(dir, f));

const refuses = (name, mutate, expectInMessage) => {
  const src = JSON.parse(readFileSync("catalogue.src.json", "utf8"));
  mutate(src);
  writeFileSync(path.join(dir, "catalogue.src.json"), JSON.stringify(src, null, 2));
  rmSync(path.join(dir, "config.stable.json"), { force: true });
  try {
    execFileSync("node", ["build.mjs"], { cwd: dir, stdio: "pipe" });
    check(name, false, "build succeeded when it should have refused");
  } catch (e) {
    const msg = (e.stderr?.toString() || "") + (e.stdout?.toString() || "");
    check(name, msg.includes(expectInMessage), `message did not mention "${expectInMessage}"`);
  }
};

refuses("a chain naming a model that does not exist",
  (s) => { s.purposes["auto-reply"] = ["gemini-does-not-exist"]; }, "not in models");
refuses("an image chain naming a model with vision:false",
  (s) => { s.purposes["attachment-vision"] = ["gemini-3.1-flash-lite"]; }, "vision:false");
refuses("an embedding chain with a fallback in it",
  (s) => { s.purposes["kb-embed-index"] = ["gemini-embedding-001", "gemini-3.7-flash"]; }, "exactly one model");
refuses("a model with no price",
  (s) => { delete s.models["gemini-3.7-flash"].price; }, "no complete price");
refuses("no default chain",
  (s) => { delete s.purposes.default; }, "purposes.default is required");
refuses("version zero",
  (s) => { s.version = 0; }, "positive integer");

console.log("\n4. version only goes up");
{
  const src = JSON.parse(readFileSync("catalogue.src.json", "utf8"));
  writeFileSync(path.join(dir, "catalogue.src.json"), JSON.stringify(src, null, 2));
  rmSync(path.join(dir, "config.stable.json"), { force: true });
  execFileSync("node", ["build.mjs"], { cwd: dir, stdio: "pipe" });   // first publish
  try {
    execFileSync("node", ["build.mjs"], { cwd: dir, stdio: "pipe" }); // same version again
    check("republishing the same version is refused", false, "it was allowed");
  } catch (e) {
    const msg = (e.stderr?.toString() || "") + (e.stdout?.toString() || "");
    check("republishing the same version is refused", msg.includes("is not newer"));
  }
  src.version += 1;
  writeFileSync(path.join(dir, "catalogue.src.json"), JSON.stringify(src, null, 2));
  let ok = true;
  try { execFileSync("node", ["build.mjs"], { cwd: dir, stdio: "pipe" }); } catch { ok = false; }
  check("a higher version publishes", ok);
}
rmSync(dir, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "all good" : "FAILED"} · ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
