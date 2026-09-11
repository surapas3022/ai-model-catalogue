# Implementing the catalogue in a product

How to make a product read this catalogue instead of its own hardcoded model
names. Start to finish, in the order the steps actually have to happen.

`client/catalogue-client.mjs` is a working consumer with the same steps in code.
Copy it and adapt the four marked spots, or write your own from this page.

The whole integration rests on one property: **asking which model to use must
never be able to fail.** If the CDN is down, if the file is corrupt, if the
signature is wrong — the product still answers a customer. Every step below is
written to keep that true.

---

## Step 0 — before you start

You need the catalogue published at least once (`config.stable.json` committed
and pushed), the contents of `catalogue-public.pem`, and a list of the feature
id strings the product already passes to `callGeminiWithResilience`. Those
strings are the keys under `purposes`; they have to match exactly.

## Step 1 — embed the public key in the build

Paste `catalogue-public.pem` into the product as a constant, or load it from a
file that ships with the build. **Do not fetch it.** Whoever can swap the
catalogue can swap a fetched key too, and then the signature proves nothing.

The key only verifies. Publishing it is harmless; it cannot sign.

## Step 2 — decide the channel at build time

```
stable → every deployment by default
canary → the two or three you are willing to break first
```

The channel is stamped when a deployment's build is generated, not chosen at
runtime. A deployment must not be able to promote itself onto `canary`, and it
must not announce which shop it is in order to ask what model to use. The
catalogue is public and identical for everyone on a channel.

```
https://cdn.jsdelivr.net/gh/surapas3022/ai-model-catalogue/config.stable.json
https://cdn.jsdelivr.net/gh/surapas3022/ai-model-catalogue/config.canary.json
```

## Step 3 — write the floor into the build

A small copy of the catalogue, compiled in. It needs `purposes.default`, the
models that chain names, and `fallbackPrice`. Give it `version: 0` so any real
catalogue beats it.

This is what answers on a fresh machine, first boot, with no network. Without a
floor the product has a startup dependency on a CDN, which is exactly what you
are trying not to have.

## Step 4 — verify before you trust, in this order

```js
const { payload, sig } = JSON.parse(fileText);
if (!verify(null, Buffer.from(payload, "utf8"), PUBLIC_KEY, Buffer.from(sig, "base64"))) throw ...;
const cat = JSON.parse(payload);
```

`payload` is a **string**. Verify the exact bytes that arrived. Parsing it and
re-serializing before verifying changes key order, breaks the signature, and
produces a failure with nothing in it that points at the cause.

Then four more refusals, each rejecting a file that is genuinely signed but
still wrong for this deployment:

| check | why |
|---|---|
| `cat.channel === CHANNEL` | a canary file served to a stable build is a mis-deploy, not an upgrade |
| `cat.minClientVersion <= CLIENT_VERSION` | the catalogue uses a field this build cannot read |
| `cat.version > current.version` | a stale copy in a CDN edge must not walk the deployment backwards |
| `cat.version` is an integer | a version that is not a whole number cannot be compared, so nothing can be newer |
| `cat.purposes.default` is non-empty | with no default, any feature id you missed has no chain at all |
| every chain names a model in `models` | the cost report would fall back to `fallbackPrice` and read plausibly but wrong |

## Step 5 — cache the last known good copy

Write the **signed file exactly as received**, not the parsed object. On the
next boot it is re-verified the same way, by the same code, with the same key.
Storing a parsed object means storing something nothing can check.

Read the cache first at boot, then fetch. The product is useful immediately and
current a moment later.

## Step 6 — refresh on a timer, slowly

The published URLs are mutable, so jsDelivr caches them for hours. Polling every
minute costs requests and changes nothing. Every few hours is right.

**A refresh that fails is not an error the caller handles.** Log it, keep the
version you have, carry on. There is nothing useful for a call site to do about
a CDN being slow.

## Step 7 — replace the hardcoded model names

At the call site:

```js
const chain = chainFor("auto-reply");   // ["gemini-3.7-flash", "gemini-3.5-flash-lite", ...]
```

Try the chain in order, falling to the next on failure. Unknown feature ids
return `purposes.default`, so shipping a feature before adding its id here is
safe — it runs on the default chain rather than crashing.

Keep this lookup **synchronous**. It reads a value already in memory. A call
site should never await the network to find out which model to call.

## Step 8 — point the cost report at the same file

```js
const price = priceFor(model);          // falls back to fallbackPrice, never throws
const thb = usd * catalogue().usdToThb;
```

The build refuses a model with an incomplete price precisely so this report
cannot silently fall back and read plausibly but wrong on an invoice the
customer pays.

If your report meets model ids the routing catalogue does not describe, fetch
`lineup.stable.json` too and look there before reaching for `fallbackPrice`. It
is the same envelope, the same key and the same checks, and every step above
applies to it unchanged. Take prices from it and nothing else: routing stays
with `config`.

## Step 9 — prove it before the fleet gets it

1. Point one deployment at `canary`. Publish a change there only. Confirm it
   picks up the new version, and that the old build still refuses a catalogue
   whose `minClientVersion` is too high.
2. Break the signature on purpose in the cached file. The product must fall back
   and keep serving, not crash on boot.
3. Cut the network entirely on a machine with no cache. The floor must answer.

Only then publish to `stable`.

---

## Rolling back

Deleting or reverting a published file **undoes nothing** — the CDN keeps
serving what it cached, for hours.

To undo a release: put the old content back in `catalogue.src.json`, raise
`version` above the bad one, build, commit, push. Forward is the only direction
that reaches anyone.

Expect hours for a change to land everywhere, and expect a window where some
deployments have the new file and others still have the old one. That is
acceptable for model selection, and it is why the canary channel, the cached
copy and the floor all exist.

If you ever need a file that cannot change under you, a tag is permanently
cached:

```
https://cdn.jsdelivr.net/gh/surapas3022/ai-model-catalogue@v3/config.stable.json
```

## Checklist

- [ ] Public key embedded in the build, not fetched
- [ ] Channel stamped at build time, not chosen at runtime
- [ ] Floor compiled in, `version: 0`
- [ ] Signature verified over the raw payload string
- [ ] Channel, `minClientVersion`, `version` and `purposes.default` all checked
- [ ] Signed bytes cached, re-verified on next boot
- [ ] Refresh every few hours, failures logged and swallowed
- [ ] Every hardcoded model name replaced by a `chainFor` lookup
- [ ] Cost report reading prices from the same catalogue
- [ ] Canary, broken-signature and no-network cases all tried
