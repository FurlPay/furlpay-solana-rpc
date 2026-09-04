import { test } from "node:test";
import assert from "node:assert/strict";
import {
  interpretStatus,
  isTerminal,
  meetsRequirement,
  mergeOutcomes,
  satisfies,
  slotLag,
  type ObservedOutcome,
} from "../src/confirmation.js";
import type { SignatureStatus } from "../src/provider.js";

// ---------------------------------------------------------------------------
// Reading signature statuses.
//
// Two traps, and both produce a payment that is reported as settled when it is
// not:
//
//   1. `landed` is not `succeeded`. A transaction can be in a block, reach
//      `finalized`, and have failed — that is what `err` means.
//   2. `null` is not `not yet`. The node returns null both for a signature it
//      has never seen and for one it has forgotten.
//
// Everything below is one of those two, asked from a different direction.
// ---------------------------------------------------------------------------

function status(over: Partial<SignatureStatus> = {}): SignatureStatus {
  return { slot: 100, confirmations: 5, confirmationStatus: "confirmed", err: null, ...over };
}

test("a landed-but-failed transaction is never reported as confirmed", () => {
  // The trap. `err` is checked before commitment, because a failed transaction
  // reaches `finalized` like any other — and reading commitment first would
  // call it a settled payment.
  const outcome = interpretStatus(status({ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }));
  assert.equal(outcome.state, "landed_failed");
  assert.equal(meetsRequirement(outcome, "confirmed"), false);
  assert.equal(meetsRequirement(outcome, "finalized"), false);
  assert.equal(isTerminal(outcome), true);
});

test("a successful landing reports its commitment", () => {
  const outcome = interpretStatus(status({ confirmationStatus: "finalized", confirmations: null }));
  assert.equal(outcome.state, "landed");
  assert.equal(outcome.state === "landed" && outcome.commitment, "finalized");
  assert.equal(meetsRequirement(outcome, "finalized"), true);
});

test("a landing with no reported status is only 'processed'", () => {
  // Defaulting higher would inflate certainty we do not have.
  const outcome = interpretStatus(status({ confirmationStatus: null }));
  assert.equal(outcome.state === "landed" && outcome.commitment, "processed");
  assert.equal(meetsRequirement(outcome, "confirmed"), false);
});

test("null is 'unknown', not 'failed' — and not 'expired' without the heights", () => {
  // Treating a null as failure would abandon in-flight payments; treating it
  // as expiry would authorise a rebuild, which is a double charge.
  assert.equal(interpretStatus(null).state, "unknown");
  assert.equal(interpretStatus(undefined).state, "unknown");
  assert.equal(interpretStatus(null, { currentBlockHeight: 500 }).state, "unknown");
  assert.equal(interpretStatus(null, { lastValidBlockHeight: 400 }).state, "unknown");
});

test("expiry is asserted only when the validity window has provably passed", () => {
  // The one condition under which a rebuild is safe: the original bytes can no
  // longer be included by anyone.
  assert.equal(
    interpretStatus(null, { currentBlockHeight: 401, lastValidBlockHeight: 400 }).state,
    "expired"
  );
  // Exactly at the boundary the blockhash is still valid.
  assert.equal(
    interpretStatus(null, { currentBlockHeight: 400, lastValidBlockHeight: 400 }).state,
    "unknown"
  );
});

test("a known signature is never called expired, whatever the heights say", () => {
  // If the network has it, it is not dead — the height comparison only ever
  // applies to an absent record.
  const outcome = interpretStatus(status(), { currentBlockHeight: 9999, lastValidBlockHeight: 400 });
  assert.equal(outcome.state, "landed");
});

test("commitment ranks in ascending certainty", () => {
  assert.equal(satisfies("finalized", "confirmed"), true);
  assert.equal(satisfies("confirmed", "finalized"), false);
  assert.equal(satisfies("processed", "confirmed"), false);
  assert.equal(satisfies("confirmed", "confirmed"), true);
});

test("terminal means further waiting cannot change the answer", () => {
  assert.equal(isTerminal({ state: "expired" }), true);
  assert.equal(isTerminal({ state: "landed_failed", slot: 1, err: {} }), true);
  assert.equal(
    isTerminal({ state: "landed", slot: 1, commitment: "finalized", confirmations: null }),
    true
  );
  // Still moving.
  assert.equal(isTerminal({ state: "unknown" }), false);
  assert.equal(
    isTerminal({ state: "landed", slot: 1, commitment: "confirmed", confirmations: 3 }),
    false
  );
});

// ── merging across providers ──────────────────────────────────────────────

test("a reported failure beats a reported success", () => {
  // Asymmetric on purpose. A node reporting an error has seen the execution
  // result; a node reporting success at a lower commitment may simply not have
  // caught up. Taking the optimistic answer marks a failed payment as settled.
  const merged = mergeOutcomes([
    { state: "landed", slot: 100, commitment: "confirmed", confirmations: 5 },
    { state: "landed_failed", slot: 100, err: { InstructionError: [0, "Custom"] } },
  ]);
  assert.equal(merged.state, "landed_failed");
});

test("highest certainty wins among successes", () => {
  const merged = mergeOutcomes([
    { state: "unknown" },
    { state: "landed", slot: 100, commitment: "processed", confirmations: 1 },
    { state: "landed", slot: 100, commitment: "finalized", confirmations: null },
    { state: "landed", slot: 100, commitment: "confirmed", confirmations: 5 },
  ]);
  assert.equal(merged.state === "landed" && merged.commitment, "finalized");
});

test("one provider seeing the transaction beats another calling it expired", () => {
  // Providers sit at different slots. If any of them has it, it is not dead.
  const merged = mergeOutcomes([
    { state: "expired" },
    { state: "landed", slot: 100, commitment: "processed", confirmations: 1 },
  ]);
  assert.equal(merged.state, "landed");
});

test("expiry stands only when no provider has any record", () => {
  assert.equal(mergeOutcomes([{ state: "unknown" }, { state: "expired" }]).state, "expired");
});

test("no answers at all is unknown, not expired", () => {
  // Every provider being unreachable says nothing about the payment.
  assert.equal(mergeOutcomes([]).state, "unknown");
  assert.equal(mergeOutcomes([{ state: "unknown" }, { state: "unknown" }]).state, "unknown");
});

// ── slot lag ──────────────────────────────────────────────────────────────

test("slot lag measures the spread across providers", () => {
  // The failure latency alone cannot see: a node that is fast, healthy, and
  // four hundred slots behind.
  assert.equal(slotLag([1000, 1400, 1010]), 400);
  assert.equal(slotLag([1000, 1000]), 0);
});

test("lag needs something to compare against", () => {
  assert.equal(slotLag([]), null);
  assert.equal(slotLag([1000]), null);
});

test("unusable slot values are discarded rather than skewing the answer", () => {
  // A provider that errored contributes 0 or NaN; counting it would report a
  // catastrophic lag that does not exist.
  assert.equal(slotLag([1000, 0, 1010]), 10);
  assert.equal(slotLag([NaN, 1000, 1005]), 5);
  assert.equal(slotLag([NaN, 0]), null);
});

test("an outcome union member is never silently mishandled", () => {
  // Exercises every state through the shared predicates, so adding a state
  // without updating them shows up here.
  const all: ObservedOutcome[] = [
    { state: "unknown" },
    { state: "expired" },
    { state: "landed_failed", slot: 1, err: {} },
    { state: "landed", slot: 1, commitment: "confirmed", confirmations: 2 },
  ];
  for (const outcome of all) {
    assert.equal(typeof isTerminal(outcome), "boolean");
    assert.equal(typeof meetsRequirement(outcome, "confirmed"), "boolean");
  }
});
