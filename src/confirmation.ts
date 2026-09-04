import type { Commitment, SignatureStatus } from "./provider.js";

// ---------------------------------------------------------------------------
// Reading a signature status honestly.
//
// THE TRAP THIS MODULE EXISTS TO AVOID: `getSignatureStatuses` returns null for
// a signature the node has never heard of AND for one it has forgotten. Those
// are opposite facts — "not landed yet" versus "we cannot tell you" — and code
// that treats null as "not yet" will poll forever on a transaction that
// actually succeeded and aged out of the node's cache.
//
// LANDING IS NOT SUCCESS. A transaction can be included in a block and have
// failed; that is what `err` means. It is confirmed, it is final, and it did
// not move any money. Any code that reads `confirmationStatus` without also
// reading `err` will report a failed payment as settled — so the outcome type
// below makes that impossible to express: `landed_failed` is its own case and
// is never `confirmed`.
//
// PURE. Nothing here performs I/O. The caller fetches statuses however it
// likes — HTTP poll, WebSocket push, a batch across a pool — and passes the
// result in. That keeps the interpretation logic directly testable, which
// matters because every subtle bug in payment tracking lives in exactly this
// interpretation rather than in the fetching.
// ---------------------------------------------------------------------------

/** What a status observation tells us about one payment. */
export type ObservedOutcome =
  /** The network has no record. It may be in flight, or may never have been
   *  sent. NOT proof it failed. */
  | { state: "unknown" }
  /** In a block, and it FAILED. Terminal — the money did not move. */
  | { state: "landed_failed"; slot: number; err: unknown }
  /** In a block, succeeded, at the given commitment. */
  | { state: "landed"; slot: number; commitment: Commitment; confirmations: number | null }
  /**
   * Provably dead: the blockhash's validity window has passed with no record.
   * The ONLY condition under which rebuilding with a fresh blockhash is safe,
   * because the original bytes can no longer be included by anyone.
   */
  | { state: "expired" };

/**
 * Interpret one status.
 *
 * `currentBlockHeight` and `lastValidBlockHeight` are what turn "unknown" into
 * the actionable "expired". Without them this can only ever say "no record
 * yet", and the caller has no safe moment to rebuild.
 */
export function interpretStatus(
  status: SignatureStatus | null | undefined,
  ctx: { currentBlockHeight?: number; lastValidBlockHeight?: number } = {}
): ObservedOutcome {
  if (!status) {
    const { currentBlockHeight, lastValidBlockHeight } = ctx;
    // Expiry is only assertable with both heights. Guessing it from elapsed
    // time would be a rebuild — and therefore a possible double charge —
    // decided by a stopwatch.
    if (
      typeof currentBlockHeight === "number" &&
      typeof lastValidBlockHeight === "number" &&
      currentBlockHeight > lastValidBlockHeight
    ) {
      return { state: "expired" };
    }
    return { state: "unknown" };
  }

  // Checked BEFORE commitment. A failed transaction reaches `finalized` like
  // any other, and reading commitment first would call it a settled payment.
  if (status.err !== null && status.err !== undefined) {
    return { state: "landed_failed", slot: status.slot, err: status.err };
  }

  return {
    state: "landed",
    slot: status.slot,
    // A landed transaction with no reported status is `processed` at minimum —
    // the node has it in a block. Defaulting to anything higher would inflate
    // certainty we do not have.
    commitment: status.confirmationStatus ?? "processed",
    confirmations: status.confirmations,
  };
}

/** Ascending certainty. Used to compare, never to assume. */
const RANK: Record<Commitment, number> = { processed: 0, confirmed: 1, finalized: 2 };

/** Does an observed commitment satisfy what the payment requires? */
export function satisfies(observed: Commitment, required: Commitment): boolean {
  return RANK[observed] >= RANK[required];
}

/**
 * Has this payment reached what it needs?
 *
 * Deliberately takes the REQUIRED commitment rather than deciding it — that
 * decision belongs to @furlpay/settlement, which knows the amount and the
 * merchant's policy. This module only reports whether a bar was cleared.
 */
export function meetsRequirement(outcome: ObservedOutcome, required: Commitment): boolean {
  return outcome.state === "landed" && satisfies(outcome.commitment, required);
}

/** True when no amount of further waiting can change the answer. */
export function isTerminal(outcome: ObservedOutcome): boolean {
  if (outcome.state === "landed_failed" || outcome.state === "expired") return true;
  return outcome.state === "landed" && outcome.commitment === "finalized";
}

/**
 * Merge statuses for one signature observed across several providers.
 *
 * Providers disagree constantly: one node has a transaction at `finalized`
 * while another has never seen it, because they are at different slots. The
 * merge rule is HIGHEST CERTAINTY WINS, with one exception that matters.
 *
 * THE EXCEPTION: a `landed_failed` from any provider beats a `landed` from
 * another. A node reporting an error has seen the execution result; a node
 * reporting success at a lower commitment may simply not have caught up. Taking
 * the optimistic answer there would mark a failed payment as settled — so
 * failure is sticky, and this is the one place the merge is not symmetric.
 *
 * `expired` ranks below any positive sighting: if even one provider has the
 * transaction, it is not dead, whatever the block heights suggested.
 */
export function mergeOutcomes(outcomes: readonly ObservedOutcome[]): ObservedOutcome {
  if (outcomes.length === 0) return { state: "unknown" };

  const failed = outcomes.find((o) => o.state === "landed_failed");
  if (failed) return failed;

  let best: ObservedOutcome = { state: "unknown" };
  let bestRank = -1;

  for (const outcome of outcomes) {
    if (outcome.state !== "landed") continue;
    const rank = RANK[outcome.commitment];
    if (rank > bestRank) {
      bestRank = rank;
      best = outcome;
    }
  }
  if (best.state === "landed") return best;

  // No provider has it. Only now does an expiry claim stand.
  if (outcomes.some((o) => o.state === "expired")) return { state: "expired" };
  return { state: "unknown" };
}

/**
 * Slot lag across a pool: how far the furthest-behind provider trails the
 * furthest-ahead.
 *
 * A node that answers in 5ms with 400-slot-old state is worse for payment
 * tracking than one that answers in 200ms with current state, and latency
 * alone cannot see the difference. Returns null for fewer than two samples —
 * lag is a comparison, and there is nothing to compare against.
 */
export function slotLag(slots: readonly number[]): number | null {
  const valid = slots.filter((s) => Number.isFinite(s) && s > 0);
  if (valid.length < 2) return null;
  return Math.max(...valid) - Math.min(...valid);
}
