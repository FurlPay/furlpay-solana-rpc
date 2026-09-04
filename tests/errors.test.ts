import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, retryAction } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Failure classification.
//
// This decides whether a failed payment is resent, rebuilt, or abandoned — the
// single place in the stack where being wrong charges a customer twice. The
// tests are therefore organised around that consequence rather than around the
// error strings.
//
// ONE INVARIANT ABOVE ALL: `rebuildRequired` may only ever be true for an
// expired blockhash. A rebuild produces a NEW SIGNATURE, so it is a new
// transaction; doing it while the original could still land is a double
// charge. That is asserted globally at the bottom, not just per-case.
// ---------------------------------------------------------------------------

test("'already processed' is a SUCCESS, and must never resend or rebuild", () => {
  // The most dangerous string in the file. The RPC reports it as an error, but
  // it means the transaction is already in a block. Rebuilding would charge
  // the customer a second time.
  for (const raw of [
    "This transaction has already been processed",
    { InstructionError: null, message: "AlreadyProcessed" },
    new Error("Transaction simulation failed: This transaction has already been processed"),
  ]) {
    const c = classifyFailure(raw);
    assert.equal(c.kind, "already_processed", `misread: ${JSON.stringify(raw)}`);
    assert.equal(c.resendSafe, false);
    assert.equal(c.rebuildRequired, false);
    assert.equal(c.terminal, true);
    assert.equal(retryAction(c), "give_up");
  }
});

test("'already processed' outranks the simulation-failure wording it arrives inside", () => {
  // Solana wraps it in "Transaction simulation failed: …". If rule order let
  // simulation_failed win, the message would read "can't be completed" for a
  // payment that already succeeded.
  const c = classifyFailure("Transaction simulation failed: This transaction has already been processed");
  assert.equal(c.kind, "already_processed");
});

test("an expired blockhash is the ONLY thing that authorises a rebuild", () => {
  for (const raw of [
    "BlockhashNotFound",
    "Blockhash not found",
    new Error("TransactionExpiredBlockheightExceeded: block height exceeded"),
  ]) {
    const c = classifyFailure(raw);
    assert.equal(c.kind, "blockhash_expired");
    assert.equal(c.rebuildRequired, true);
    // Resending dead bytes is pure waste — they can never be included.
    assert.equal(c.resendSafe, false);
    assert.equal(c.terminal, false, "a rebuild can still succeed");
    assert.equal(retryAction(c), "rebuild");
  }
});

test("a transport failure resends the SAME bytes", () => {
  // The safe retry: we do not know whether it landed, the signature is
  // unchanged, so a duplicate is deduplicated by the network.
  for (const raw of [
    new Error("fetch failed"),
    Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    new Error("socket hang up"),
    "HTTP 503 from helius",
  ]) {
    const c = classifyFailure(raw);
    assert.ok(["transport", "node_rejected"].includes(c.kind), `unexpected kind ${c.kind}`);
    assert.equal(c.resendSafe, true);
    assert.equal(c.rebuildRequired, false, "a transport fault must NEVER trigger a rebuild");
    assert.equal(retryAction(c), "resend");
  }
});

test("a rate limit suggests another endpoint, not a rebuild", () => {
  const c = classifyFailure("HTTP 429: too many requests");
  assert.equal(c.kind, "node_rejected");
  assert.equal(c.tryAnotherEndpoint, true);
  assert.equal(c.rebuildRequired, false);
});

test("insufficient funds is terminal and says so in plain words", () => {
  for (const raw of ["Insufficient funds", "insufficient lamports for rent", "InsufficientFundsForRent"]) {
    const c = classifyFailure(raw);
    assert.equal(c.kind, "insufficient_funds");
    assert.equal(c.terminal, true);
    assert.equal(retryAction(c), "give_up");
    assert.match(c.message, /balance/i);
    assert.doesNotMatch(c.message, /lamport|InsufficientFunds/, "leaked chain jargon to the user");
  }
});

test("insufficient funds beats the generic program error it technically is", () => {
  // It arrives as `custom program error: 0x1`. "There isn't enough balance" is
  // far more actionable than "rejected on-chain".
  const c = classifyFailure("Transfer: insufficient lamports 100, need 5000");
  assert.equal(c.kind, "insufficient_funds");
});

test("an unrecognised error fails closed", () => {
  // The alternative — unknown means retryable — turns any Solana error string
  // this table has not seen into an automatic retry loop in a money path.
  for (const raw of ["something nobody has seen before", 42, null, undefined, {}]) {
    const c = classifyFailure(raw);
    assert.equal(c.kind, "unknown");
    assert.equal(c.resendSafe, false);
    assert.equal(c.rebuildRequired, false);
    assert.equal(c.terminal, true);
    assert.equal(retryAction(c), "give_up");
  }
});

test("errors are read out of nested shapes, not just .message", () => {
  // Solana returns JSON-RPC bodies and TransactionError variants; the real
  // signal is often in `data.logs` or a nested `cause`.
  const rpcBody = {
    code: -32002,
    message: "Transaction simulation failed",
    data: { logs: ["Program log: Error: insufficient funds"] },
  };
  assert.equal(classifyFailure(rpcBody).kind, "insufficient_funds");

  const wrapped = new Error("submission failed", { cause: new Error("BlockhashNotFound") });
  assert.equal(classifyFailure(wrapped).kind, "blockhash_expired");
});

test("a circular error object does not throw", () => {
  // JSON.stringify would blow up; the classifier must survive whatever an RPC
  // client hands it rather than crashing the payment path.
  const circular: Record<string, unknown> = { message: "ETIMEDOUT" };
  circular.self = circular;
  assert.doesNotThrow(() => classifyFailure(circular));
});

test("GLOBAL INVARIANT: only an expired blockhash may authorise a rebuild", () => {
  // The property that matters more than any individual case. If a future rule
  // sets rebuildRequired on anything else, this fails.
  const samples = [
    "This transaction has already been processed",
    "fetch failed",
    "HTTP 429",
    "Insufficient funds",
    "exceeded CUs meter",
    "custom program error: 0x1770",
    "Transaction simulation failed",
    "total gibberish",
    "ECONNRESET",
    "BlockhashNotFound",
  ];
  for (const raw of samples) {
    const c = classifyFailure(raw);
    if (c.rebuildRequired) {
      assert.equal(c.kind, "blockhash_expired", `${raw} must not authorise a rebuild`);
    }
  }
});

test("GLOBAL INVARIANT: resend and rebuild are never both true", () => {
  // They are contradictory instructions. A caller acting on both would send
  // the old bytes AND a new transaction — the double charge, directly.
  for (const raw of ["fetch failed", "BlockhashNotFound", "already been processed", "HTTP 500", "nonsense"]) {
    const c = classifyFailure(raw);
    assert.ok(!(c.resendSafe && c.rebuildRequired), `${raw} gave contradictory instructions`);
  }
});

test("every classification carries a message fit for a customer", () => {
  for (const raw of ["fetch failed", "BlockhashNotFound", "Insufficient funds", "nonsense", "HTTP 429"]) {
    const c = classifyFailure(raw);
    assert.ok(c.message.length > 15, `${raw} needs a real message`);
    assert.doesNotMatch(c.message, /0x[0-9a-f]+|Err\(|struct |undefined/i, `${raw} leaked internals`);
  }
});
