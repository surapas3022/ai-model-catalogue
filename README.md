# ai-model-catalogue

Which AI model each part of the product should call, which models cost what, and
when each one is due to be retired. One signed file, fetched by every deployment.

It lives in its own repository on purpose, and the reason is not tidiness:
**jsDelivr cannot serve a private repo**, so this has to be public — while the
product it serves is not sold as source. The signing key must also stay away
from the product tree, and this catalogue outlives any single build of it.

## Publishing

```bash
node build.mjs keygen     # once, ever
node build.mjs            # sign for the channel named in catalogue.src.json
node build.mjs canary     # sign the same source as the canary channel
node verify.mjs           # prove the signature and the guards still hold
```

Edit `catalogue.src.json`, raise `version`, run `build.mjs`, commit, push.
`config.stable.json` and `config.canary.json` are generated — never hand-edit them.

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
https://cdn.jsdelivr.net/gh/<user>/ai-model-catalogue/config.stable.json
https://cdn.jsdelivr.net/gh/<user>/ai-model-catalogue/config.canary.json
```

Those paths are mutable, so jsDelivr caches them for hours. **Expect a change to
take hours to reach everyone, and expect some shops to have the new file while
others still have the old one.** That is acceptable for model selection and it is
why the product also keeps a canary channel, a last-known-good copy, and a
hardcoded floor.

A pinned, permanently-cached URL is available if you ever need one:
`https://cdn.jsdelivr.net/gh/<user>/ai-model-catalogue@<tag>/config.stable.json`

## File shape

Published files are `{ "payload": "<json as a string>", "sig": "<base64>" }`.

`payload` is a string rather than a nested object because the signature covers
exact bytes. Signing an object would let JSON key order change the bytes, and a
perfectly valid catalogue would then fail to verify with nothing to show why.

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

## Keys in `purposes`

They are the exact feature ids the product already passes to
`callGeminiWithResilience`, so the model map and the cost report name things the
same way. Adding a feature to the product without adding it here is safe — it
falls to `default`.
