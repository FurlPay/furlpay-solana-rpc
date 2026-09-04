# @furlpay/solana-rpc

![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript&logoColor=white) ![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=nodedotjs&logoColor=white) ![Edge runtime](https://img.shields.io/badge/Edge_runtime-compatible-000000?logo=vercel&logoColor=white) ![Solana](https://img.shields.io/badge/Solana-mainnet-9945FF?logo=solana&logoColor=white) [![Dependencies](https://img.shields.io/badge/dependencies-1-brightgreen)](https://github.com/FurlPay/furlpay-resilience) ![License](https://img.shields.io/badge/License-MIT-blue)

**The operational half of the Solana payment rail.**

Building a Solana transfer is the well-solved half: `@solana/web3.js` and `@solana/spl-token` construct SOL and SPL transfers, derive associated token accounts and split fees, and FurlPay's own payment app already does exactly that. What none of it does is anything *after* signing.

That is this package.

This package is that missing half: **submit, track, interpret, and stay healthy across multiple providers.**

```ts
import { SolanaRpcPool, HttpRpcProvider, SubmissionError, retryAction } from "@furlpay/solana-rpc";

const pool = new SolanaRpcPool({
  providers: [
    new HttpRpcProvider({ id: "helius", url: process.env.HELIUS_RPC_URL! }),
    new HttpRpcProvider({ id: "triton", url: process.env.TRITON_RPC_URL! }),
  ],
  weights: { helius: 2 },
});

try {
  const { signature } = await pool.submit(base64Tx);
  const { outcome } = await pool.observe(signature, { lastValidBlockHeight });
  // → { state: "landed", commitment: "finalized", slot: 1400 }
} catch (e) {
  if (e instanceof SubmissionError) {
    retryAction(e.classification); // "resend" | "rebuild" | "give_up"
  }
}
```

## It does not build transactions

Deliberately. Construction needs `@solana/web3.js` and belongs wherever you already do it. Submission and tracking are JSON-RPC over HTTP — keeping them free of that dependency lets this run in an Edge runtime *and* on mobile, both of which need to follow a payment's status without shipping a transaction builder.

**No Solana SDK dependency. One runtime dependency: [`@furlpay/resilience`](https://github.com/FurlPay/furlpay-resilience).**

---

## The one decision that matters

> **Resend the same bytes, or rebuild with a fresh blockhash?**

These sit on opposite sides of one question, and confusing them is how a payments company double-charges.

| | | |
|---|---|---|
| **Resend** | Same signature — the network deduplicates | **Safe** |
| **Rebuild** | *New* signature, therefore a new transaction | **Only ever safe once the original is provably dead** |

Generic retry logic — including `executeWithRetry`, which this package uses everywhere else — reasons about HTTP status codes. It cannot know that a Solana transaction carries an expiring blockhash, or that `"already been processed"` means the payment **succeeded**.

```ts
classifyFailure("This transaction has already been processed");
// → { kind: "already_processed", resendSafe: false, rebuildRequired: false, terminal: true }
//   A SUCCESS wearing an error's coat. Rebuilding here charges the customer twice.

classifyFailure(new Error("fetch failed"));
// → { kind: "transport", resendSafe: true, rebuildRequired: false }
//   We don't know if it landed. Same bytes, same signature — safe.

classifyFailure("BlockhashNotFound");
// → { kind: "blockhash_expired", resendSafe: false, rebuildRequired: true }
//   The ONLY classification that authorises a rebuild.
```

Two invariants are asserted globally in the test suite, not just per-case:

- **Only `blockhash_expired` may set `rebuildRequired`.** Any future rule that sets it elsewhere fails the build.
- **`resendSafe` and `rebuildRequired` are never both true.** They are contradictory instructions; a caller acting on both would send the old bytes *and* a new transaction.

An unrecognised error **fails closed** — no resend, no rebuild. The alternative turns any Solana error string this table hasn't seen into an automatic retry loop in a money path.

---

## Submission is never retried automatically

`pool.submit()` makes **one attempt against one provider** and throws a `SubmissionError` carrying the classification.

That looks like a missing feature. It is the opposite: only the caller knows whether these bytes may be resent or the transaction must be rebuilt, and a pool that retried on its own would make that decision blindly — on the one operation where being wrong charges someone twice.

Reads fan out and fail over freely. Writes do not.

---

## Two traps in reading a status

**1. `landed` is not `succeeded`.** A transaction can be in a block, reach `finalized`, and have failed. `err` is checked *before* commitment, so this is unrepresentable:

```ts
interpretStatus({ confirmationStatus: "finalized", err: { InstructionError: [...] } });
// → { state: "landed_failed" }     never "landed", never meetsRequirement()
```

**2. `null` is not `not yet`.** The node returns null both for a signature it has never seen and for one it has forgotten. Expiry is asserted *only* when block heights prove the validity window has passed:

```ts
interpretStatus(null);                                                   // → unknown
interpretStatus(null, { currentBlockHeight: 401, lastValidBlockHeight: 400 }); // → expired
```

Guessing expiry from elapsed time would be a rebuild — and therefore a possible double charge — decided by a stopwatch.

### Providers disagree, and the merge is asymmetric

One node has a transaction finalized while another has never seen it, because they sit at different slots. Highest certainty wins — **except that a reported failure always beats a reported success.** A node reporting an error has seen the execution result; a node reporting success at a lower commitment may simply not have caught up.

---

## Built on `@furlpay/resilience`

`FailoverPool` already provides per-endpoint circuit breakers, EWMA latency scoring and failover. A second implementation here would be duplicated infrastructure in a money path.

What this adds is what resilience cannot know: Solana failure semantics, write/read asymmetry, and **slot lag** —

```ts
const { slotLag, slots } = await pool.health();
// { slotLag: 400, slots: { helius: 1400, triton: 1000 } }
```

A node that answers in 5ms with 400-slot-old state passes every latency check and quietly breaks confirmation tracking. Latency alone cannot see it. Returns `null` for fewer than two samples — lag is a comparison, and there is nothing to compare against.

---

## Where this sits

```
@furlpay/settlement    decides what a payment needs  (confirmed? finalized?)
@furlpay/solana-rpc    reports honestly what happened  ← this package
@furlpay/resilience    failover, circuit breaking, retry
```

Nothing here decides whether a payment is settled. It reports what was observed; `@furlpay/settlement` decides whether that is enough.

## Testing

```
npm test      # builds, then runs 30 tests under node --test
```

Covers the pure logic — classification and status interpretation — where every subtle payment-tracking bug actually lives. Network paths are exercised by injected fake providers, not live RPC.

MIT.
