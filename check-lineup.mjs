/**
 * Says where lineup.src.json has fallen behind Google's own pages.
 *
 *   node check-lineup.mjs
 *
 * It reads two pages and changes nothing:
 *
 *   pricing        every model with a section, by the endpoint id under its heading
 *   deprecations   every model's announced shutdown date
 *
 * and reports three kinds of drift:
 *
 *   new            a model on the pricing page that the lineup does not carry
 *   gone           a lineup model the pricing page no longer has a section for
 *   shutdown       a lineup model whose retiresOn differs from the announced date
 *
 * It never writes a rate. AGENTS.md says a rate is read from the page by whoever
 * publishes it, every time, and a scraper that copied numbers would be exactly
 * the pasted list that has been wrong twice. What this does is notice, so that
 * someone goes and reads.
 *
 * Exit codes: 0 nothing drifted, 1 drift found, 2 a page could not be read or
 * no longer looks the way this script expects. 2 is deliberately loud: a parser
 * that silently found zero models would report "nothing new" forever.
 *
 * --pricing=<file> and --deprecations=<file> read saved HTML instead of
 * fetching, for trying a change to the parser against a page you already have.
 */
import { readFileSync } from "node:fs";

// hl=en is not decoration. Without a language the site redirects by guessed
// locale, and a fetch from CI was handed the Chinese page, whose dates read
// "2027 年 5 月 7 日" and do not parse.
const PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing?hl=en";
const DEPRECATIONS_URL = "https://ai.google.dev/gemini-api/docs/deprecations?hl=en";

/**
 * On the pricing page, and deliberately not in the lineup. Each needs a reason,
 * because an entry here is a model nobody will be told about again.
 */
const NOT_TRACKED = [
  [/^veo-/, "billed per second of video, which the price shape cannot carry"],
  [/^lyria-/, "billed per song, which the price shape cannot carry"],
  [/-customtools$/, "a variant endpoint of a model the lineup already prices"],
];

/**
 * In the lineup, and expected to be missing from the pricing page.
 * A deprecated or retired model is expected to vanish and needs no entry.
 */
const OFF_PAGE_OK = {
  "gemini-embedding-001": "no section of its own; priced from the File Search embedding rate",
};

/**
 * Shutdown dates where the lineup knowingly differs from the deprecations page,
 * keyed to the date the lineup carries. When either page moves, the pair stops
 * matching and the model is reported again.
 */
const DATE_DISAGREEMENTS = {
  "gemini-2.5-flash-image": { ours: "2026-10-02", theirs: "2027-03-15", why: "the pricing page announces 2026-10-02; the lineup takes the earlier date" },
};

const arg = (name) => process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

async function page(url, file) {
  if (file) return readFileSync(file, "utf8");
  const res = await fetch(url, { headers: { "user-agent": "ai-model-catalogue check-lineup", "accept-language": "en" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}

const text = (html) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/**
 * Model ids from the endpoint line under each section heading: the <code>
 * elements between an <h2> and the </div> that closes its header. Code further
 * down a section is API field names and examples, not models.
 */
function pricedModels(html) {
  const ids = new Set();
  for (const [, block] of html.matchAll(/<h2[^>]*>[\s\S]*?<\/h2>([\s\S]*?)<\/div>/g)) {
    for (const [, id] of block.matchAll(/<code[^>]*>([^<]+)<\/code>/g)) {
      if (/^[a-z][a-z0-9.-]*$/.test(id.trim())) ids.add(id.trim());
    }
  }
  return ids;
}

/** The wordings that mean "no date". Anything else that is not a date is an error. */
const NO_DATE = new Set(["", "N/A", "No shutdown date announced"]);

/** model id → ISO shutdown date, or null when none is announced. */
function shutdowns(html) {
  const out = new Map();
  for (const [, row] of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, c]) => text(c));
    if (cells.length < 3 || !/^[a-z0-9.-]+$/.test(cells[0])) continue;
    if (NO_DATE.has(cells[2])) { out.set(cells[0], null); continue; }
    const parsed = Date.parse(`${cells[2]} UTC`);
    // Reading an unparseable date as "none announced" is how this script first
    // reported nine shutdowns as withdrawn. Refuse instead.
    if (Number.isNaN(parsed)) throw new Error(`cannot read the shutdown date "${cells[2]}" for ${cells[0]}`);
    out.set(cells[0], new Date(parsed).toISOString().slice(0, 10));
  }
  return out;
}

let pricingHtml, deprecationsHtml;
try {
  [pricingHtml, deprecationsHtml] = await Promise.all([
    page(PRICING_URL, arg("pricing")),
    page(DEPRECATIONS_URL, arg("deprecations")),
  ]);
} catch (e) {
  console.error(`could not read a page: ${e.message}`);
  process.exit(2);
}

const priced = pricedModels(pricingHtml);
let dates;
try {
  dates = shutdowns(deprecationsHtml);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
// The page has carried twenty-odd sections since this was written. Far fewer
// means the markup changed under the parser, not that Google withdrew most of
// its models.
if (priced.size < 10 || dates.size < 10) {
  console.error(`the pages no longer parse as expected: ${priced.size} priced models, ${dates.size} deprecation rows.`);
  process.exit(2);
}

const lineup = JSON.parse(readFileSync("lineup.src.json", "utf8"));
const models = Object.fromEntries(Object.entries(lineup.models).filter(([k]) => !k.startsWith("_")));
const skipped = (id) => NOT_TRACKED.find(([re]) => re.test(id));

const added = [...priced].filter((id) => !models[id] && !skipped(id)).sort();
const gone = Object.keys(models)
  .filter((id) => !priced.has(id) && !OFF_PAGE_OK[id] && !["deprecated", "retired"].includes(models[id].status))
  .sort();
const moved = Object.entries(models)
  .filter(([id, m]) => dates.has(id) && dates.get(id) !== m.retiresOn)
  .filter(([id, m]) => !(DATE_DISAGREEMENTS[id]?.ours === m.retiresOn && DATE_DISAGREEMENTS[id]?.theirs === dates.get(id)))
  .map(([id, m]) => ({ id, ours: m.retiresOn, theirs: dates.get(id) }));

console.log(`Checked ${Object.keys(models).length} lineup models (version ${lineup.version}, prices read ${lineup.pricesCheckedOn})`);
console.log(`against ${priced.size} models on ${PRICING_URL}`);
console.log(`and ${dates.size} rows on ${DEPRECATIONS_URL}\n`);

if (added.length) {
  console.log(`## New on the pricing page (${added.length})\n`);
  for (const id of added) console.log(`- \`${id}\`${dates.has(id) ? ` (shutdown: ${dates.get(id) ?? "none announced"})` : ""}`);
  console.log("\nRead its section and add it to lineup.src.json, or to NOT_TRACKED here with a reason.\n");
}
if (gone.length) {
  console.log(`## In the lineup but gone from the pricing page (${gone.length})\n`);
  for (const id of gone) console.log(`- \`${id}\` (status ${models[id].status})`);
  console.log("\nCheck the deprecations page: an alias, a rename, or a shutdown. Mark it deprecated, or explain it in OFF_PAGE_OK.\n");
}
if (moved.length) {
  console.log(`## Shutdown date differs (${moved.length})\n`);
  for (const { id, ours, theirs } of moved) console.log(`- \`${id}\`: lineup says ${ours ?? "none"}, deprecations page says ${theirs ?? "none announced"}`);
  console.log("\nThe two Google pages have disagreed with each other before; read both before changing retiresOn.\n");
}

if (!added.length && !gone.length && !moved.length) {
  console.log("nothing drifted");
  process.exit(0);
}
console.log("Rates are not checked here. Whoever acts on this reads them from the pricing page, per AGENTS.md.");
process.exit(1);
