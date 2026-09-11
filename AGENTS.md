# AGENTS.md

Instructions for an AI coding agent working in this repository. A human reading
this is fine too, but `README.md` is the friendlier door.

## What this repository is

One signed JSON file that tells every deployment of the product which AI model
to call for which feature, what each model costs, and when each is retired.
It is a **data repository with a build step**, not an application. Nothing here
runs in production. Deployments *fetch* what this repo publishes.

Public on purpose: jsDelivr cannot serve a private repo.

## The five facts that change how you edit

1. **`catalogue.src.json` is the only file a human edits.** `config.stable.json`
   and `config.canary.json` are build output. If you are about to edit a
   `config.*.json`, you are doing the wrong thing — edit the source and run the
   build.
2. **`version` only goes up, and a published number is never reused.**
   `build.mjs` refuses. To undo a release, raise `version` and put the old
   content back.
3. **Deleting or reverting a published file undoes nothing.** The CDN keeps
   serving what it cached, for hours. Forward is the only direction that reaches
   anyone.
4. **Nothing customer-specific belongs in the payload.** It is public and it is
   served identically to every deployment. Staged rollout is the `canary`
   channel, not an `if shop == X`.
5. **`catalogue-private.pem` must never be committed.** It is in `.gitignore`.
   If it leaks, anyone can tell every deployment which model to spend the
   customer's API quota on.

## Task recipes

**Change which model a feature uses**
1. Edit the chain under `purposes` in `catalogue.src.json`.
2. Raise `version` by 1. Update `publishedAt` and `notes`.
3. `node build.mjs` then `node build.mjs canary` if that channel also moves.
4. `node verify.mjs` — must end `all good`.
5. Commit source and generated files together. Push.

**Reprice anything, or add a model**
Read <https://ai.google.dev/gemini-api/docs/pricing> first, every time. Not
memory, not the last message in a thread, not another catalogue — that page.
Then set `pricesCheckedOn` on both files to the day you read it.

Two live traps on that page: the quoted rate for 3.8, 3.7 and 3.6-flash is the
one charged **through 31 December 2026**, and a second, doubled rate starts on 1
January 2027. Version 4 of this catalogue published the 2027 rate as today's,
and nothing caught it. The other is that `input` here is one number while the
page charges audio separately from text.

**Add or reprice a model**
Do it in both files, in the same commit. `verify.mjs` fails when a model in both
carries different prices, and that check is the only thing standing between you
and two defensible invoices that disagree. Raise both versions. Build both:
`node build.mjs` and `node build.mjs --catalogue=lineup`.

**Add a model to a chain**
Add it under `models` with a complete `price` (`input`, `cachedInput`,
`output` — all three, always). Set `vision` honestly: an image-reading chain
with a `vision:false` model is refused by the build, and that refusal is the
only thing standing between you and silent OCR failures. Then raise `version`.

**Retire a model**
Set `retiresOn` on it first and publish, so the retirement is visible before it
bites. Move chains off it in a later version. `status: "retired"` makes the
build refuse any chain still naming it, so set that last.

**Add a field to the catalogue**
The build validates the source against `catalogue.schema.json` with
`additionalProperties: false`, so a new field must be added to the schema or the
build refuses it as a typo. Raise `minClientVersion` only if a deployment that
cannot read the new field would behave wrongly — a field an old client merely
ignores is not a reason to lock it out.

**Add a feature id**
Add the key to `purposes` using the *exact* string the product passes to
`callGeminiWithResilience`. Not adding it is safe — the feature falls to
`purposes.default`. A key that does not match the product's string is worse than
no key, because it looks configured and is not.

## Never do these

- Hand-edit `config.stable.json` or `config.canary.json`.
- Reuse or lower a `version`.
- Commit `catalogue-private.pem`, or paste its contents anywhere other than
  the `CATALOGUE_PRIVATE_KEY` repository secret.
- Add a keyword to `catalogue.schema.json` that `build.mjs` does not implement.
  The build throws rather than skipping it, and that is deliberate: a keyword
  nobody enforces reads as protection and is not.
- Run `node build.mjs keygen` in a repo that already has a key pair. Every
  deployment carries the matching public key and would reject everything signed
  by a new one. The script refuses, and you should not work around it.
- Route anything from `lineup`. Its `purposes` is a copy of what `config`
  already routes to, present because the format demands the field. Take chains
  from `config`.
- Add a second model to `kb-embed-index` or `kb-embed-query`. Retrieval reads
  one vector table without filtering by model, so a fallback there makes search
  quietly worse rather than failing.
- Put a shop id, tenant name, or any other customer identifier in the payload.

## Publishing happens in CI

A push to `main` that changes `catalogue.src.json` signs it, commits
`config.stable.json`, and purges the jsDelivr edge. The key is the repository
secret `CATALOGUE_PRIVATE_KEY`; nothing writes it to disk. Canary is never
signed automatically — a canary carrying the same content as stable cannot break
first, which is the only reason to have one. Stage one with **Run workflow**.

Either habit works. Commit the source alone and CI signs it, or run
`node build.mjs` yourself and commit the generated file with it — the workflow
notices the published version already matches the source, verifies it rather
than signing it again, and purges the edge anyway. What you must not do is
commit a generated file that does not match the source; `verify.mjs` fails on
exactly that, in CI as well as locally.

## Before you say you are done

```bash
node build.mjs          # only if you are signing locally; prints the new version
node verify.mjs         # must end: all good
git status              # catalogue-private.pem must NOT be listed
```

`verify.mjs` asserts that `config.stable.json` is byte-for-byte what building
the source produces, so run it *after* the build if you built, and expect it to
fail if you raised the version and did not. Committing the source alone is fine;
CI builds and verifies in that order for you.

If `verify.mjs` fails, the change does not ship. It is not a flaky test suite —
every check in it maps to a mistake that reaches a fleet.

## Repository map

| file | what it is |
|---|---|
| `catalogue.src.json` | the routing catalogue, hand-edited, `_`-prefixed keys are comments stripped at build |
| `lineup.src.json` | the price reference, hand-edited. Every model with a rate, no routing opinion |
| `catalogue.schema.json` | the shape of the source, enforced by the build and readable by a consumer writing a client |
| `build.mjs` | validates shape then meaning, then signs source into `config.<channel>.json` |
| `verify.mjs` | proves the signature holds and that `build.mjs` still refuses what it claims to |
| `config.stable.json` | generated. Every deployment by default |
| `config.canary.json` | generated. The two or three you are willing to break first |
| `lineup.stable.json` | generated. Stable only: nothing breaks from a table nobody routes from |
| `catalogue-public.pem` | committed, embedded in the product build, verifies only |
| `catalogue-private.pem` | gitignored. Signs. On a laptop or in the `CATALOGUE_PRIVATE_KEY` secret, nowhere else |
| `.github/workflows/publish.yml` | signs and publishes on a push to `main`, then purges the CDN edge |
| `llms.txt` | the consumer contract: envelope, checks, prices, failure table |
| `priceSource` | a field in both catalogues, naming the page the rates were read from |
| `INTEGRATING.md` | how a product consumes this. Read it before touching client code |
| `client/catalogue-client.mjs` | reference consumer, copy into the product |
| `CLAUDE.md` | a pointer to this file, so an agent reaches it either way |

## Where the signing key comes from

In order: `CATALOGUE_KEY` (the PEM itself, for CI secrets), then
`CATALOGUE_KEY_FILE` (a path), then `catalogue-private.pem` in this directory.
Signing from CI means the key never has to be a file on anyone's laptop. Never
echo, log, or commit any of the three.

## Payload shape

Published files are `{ "payload": "<the catalogue as a JSON string>", "sig": "<base64 ed25519>" }`.

`payload` is a **string**, not a nested object, because the signature covers
exact bytes. Signing an object would let JSON key order change the bytes and a
perfectly valid catalogue would fail to verify with nothing to show why. Never
re-serialize the payload before verifying it.
