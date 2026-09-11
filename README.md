# ai-model-catalogue

Which AI model each part of the product should call, which models cost what, and
when each one is due to be retired. One signed file, fetched by every deployment.

It lives in its own repository on purpose, and the reason is not tidiness:
**jsDelivr cannot serve a private repo**, so this has to be public — while the
product it serves is not sold as source. The signing key must also stay away
from the product tree, and this catalogue outlives any single build of it.

## The files

| file | |
|---|---|
| `catalogue.src.json` | the one you edit. Carries `_comment` keys, which are stripped before signing |
| `catalogue.schema.json` | the shape, enforced by `build.mjs` before it signs — not documentation that drifts |
| `build.mjs` | signs, and refuses the mistakes listed below |
| `verify.mjs` | 34 cases proving the signature and every one of those refusals |
| `llms.txt` | the contract, for whoever writes the next consumer |
| `INTEGRATING.md` | the nine steps for wiring this into a product |
| `client/catalogue-client.mjs` | a working consumer, ready to copy |
| `AGENTS.md`, `CLAUDE.md` | the same ground, for an AI agent editing this repository |
| `.github/workflows/publish.yml` | signs on a push to `main`, then purges the CDN edge |
| `config.stable.json`, `config.canary.json` | generated. Never hand-edit them |
| `catalogue-public.pem` | committed, embedded in the product build |
| `catalogue-private.pem` | gitignored, or not on disk at all — see below |

## Publishing

```bash
node build.mjs keygen     # once, ever
node build.mjs            # sign for the channel named in catalogue.src.json
node build.mjs canary     # sign the same source as the canary channel
node verify.mjs           # prove the signature and the guards still hold
```

Edit `catalogue.src.json`, raise `version`, run `build.mjs`, then `verify.mjs`,
commit, push. In that order: `verify.mjs` checks that the published file is
byte-for-byte what building the source produces, which is only true once you
have built it.

## Signing from CI, so the key is not on a laptop

Push to `main` with `catalogue.src.json` changed and
`.github/workflows/publish.yml` signs `stable`, commits the result and purges
the CDN. Put the whole private PEM, `BEGIN` and `END` lines included, in a
repository secret named `CATALOGUE_PRIVATE_KEY`.

`build.mjs` and `verify.mjs` both read the key from `CATALOGUE_KEY` — the PEM
itself, not a path — falling back to `catalogue-private.pem` on disk, or to a
path in `CATALOGUE_KEY_FILE`. A secret pasted into a web form usually comes back
with its newlines escaped; that case is repaired rather than reported, because
the error it otherwise produces names nothing that would lead you to the cause.

**Only `stable` publishes automatically.** Signing canary from the same source
in the same run would make it identical to stable but for one word, and a canary
carrying the same content as stable cannot break first, which is the only reason
to have one. Stage a canary with **Run workflow** and pick the channel.

A push that changes `build.mjs`, `verify.mjs` or the schema but not the
catalogue runs `verify.mjs` and publishes nothing. There is nothing to publish:
the source has not moved, so its version is not newer than what is already out
there.

## Consuming it

[`INTEGRATING.md`](INTEGRATING.md) is the step-by-step for making a product read
this instead of its own hardcoded model names, and
[`client/catalogue-client.mjs`](client/catalogue-client.mjs) is a working
consumer to copy. [`AGENTS.md`](AGENTS.md) is the same ground written for an AI
coding agent editing this repository.

## Three rules

**`version` only ever goes up.** A deployment refuses a catalogue that is not
newer than the one it already has, so a stale copy sitting in a CDN edge can
never walk a shop backwards. `build.mjs` refuses to reuse a number.

**To undo a release, publish a higher version carrying the old content.**
Deleting or reverting the file does nothing: the CDN keeps serving what it
cached, for hours. Forward is the only direction that reaches anyone.

**Nothing customer-specific goes in this file.** It is public, and it is served
to every deployment the same way. Staged rollout is what `canary` is for: move a
deployment to that channel when you generate it, rather than identifying shops
here. No shop should ever have to announce who it is to ask what model to use.

## Channels

| channel | who is on it |
|---|---|
| `stable` | every deployment by default |
| `canary` | the two or three you are willing to break first |

A deployment's channel is set when its build is generated, not at runtime.

## URLs

```
https://cdn.jsdelivr.net/gh/surapas3022/ai-model-catalogue/config.stable.json
https://cdn.jsdelivr.net/gh/surapas3022/ai-model-catalogue/config.canary.json
```

Those paths are mutable, so jsDelivr caches them for hours. **Expect a change to
take hours to reach everyone, and expect some shops to have the new file while
others still have the old one.** That is acceptable for model selection and it is
why the product also keeps a canary channel, a last-known-good copy, and a
hardcoded floor.

A pinned, permanently-cached URL is available if you ever need one:
`https://cdn.jsdelivr.net/gh/surapas3022/ai-model-catalogue@<tag>/config.stable.json`

## File shape

Published files are `{ "payload": "<json as a string>", "sig": "<base64>" }`.

`payload` is a string rather than a nested object because the signature covers
exact bytes. Signing an object would let JSON key order change the bytes, and a
perfectly valid catalogue would then fail to verify with nothing to show why.

The schema describes what is inside `payload`, not the file itself.

Ed25519. `catalogue-public.pem` is committed and embedded in the product build —
it verifies and cannot sign. `catalogue-private.pem` is gitignored; if it leaks,
anyone can tell every deployment which model to spend the customer's API quota
on. Back it up somewhere that is not this directory.

## What `build.mjs` refuses to sign

Each of these is a mistake that is cheap here and expensive once a fleet has
fetched it:

- a chain naming a model that is not in `models`
- an image-reading chain naming a model with `vision: false`
- a model with an incomplete price — the cost report would silently fall back to
  `fallbackPrice` and read plausibly but wrong, on a report the customer pays for
- `kb-embed-index` / `kb-embed-query` with more than one model: a fallback there
  writes two models' vectors into one table that retrieval reads *without*
  filtering by model, so search quietly gets worse rather than failing
- a missing `purposes.default`, which would leave any newly added feature with no
  chain at all
- a `version` that is not newer than what is already published on that channel
- a chain naming a model whose `status` is `retired`
- an embedding model with no `dim`
- a channel name that is not `stable` or `canary`. A typo used to sign happily
  into `config.<typo>.json`: a valid, correctly signed file that nobody fetches,
  sitting next to a `config.stable.json` still holding last month's models
- anything `catalogue.schema.json` rejects — a misspelled field, a `status`
  outside the list, a price written as a string, a missing `publishedAt`

## Keys in `purposes`

They are the exact feature ids the product already passes to
`callGeminiWithResilience`, so the model map and the cost report name things the
same way. Adding a feature to the product without adding it here is safe — it
falls to `default`.
