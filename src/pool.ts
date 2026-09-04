import { FailoverPool, type EndpointHealth } from "@furlpay/resilience";
import { classifyFailure } from "./errors.js";
import { interpretStatus, mergeOutcomes, slotLag, type ObservedOutcome } from "./confirmation.js";
import type {
  Blockhash,
  Commitment,
  PrioritizationFeeSample,
  RpcProvider,
  SendOptions,
} from "./provider.js";

// ---------------------------------------------------------------------------
// Many providers, one Solana RPC.
//
// BUILT ON @furlpay/resilience, NOT ALONGSIDE IT. That package already has a
// FailoverPool with per-endpoint circuit breakers, EWMA latency scoring and
// failover — every generic requirement of a multi-provider RPC layer. Writing a
// second one here would be duplicating tested infrastructure in a money path,
// and the two would drift.
//
// WHAT THIS ADDS IS THE PART RESILIENCE CANNOT KNOW:
//
//   1. Solana failure semantics. A generic pool sees an exception and fails
//      over. This pool asks classifyFailure first, because failing over on
//      `already_processed` would send a SUCCEEDED payment to another node, and
//      failing over on an expired blockhash burns the whole pool on bytes that
//      can never land anywhere.
//
//   2. Reads are fanned out; WRITES ARE NOT RETRIED HERE. `sendRawTransaction`
//      goes to one provider and its failure is returned to the caller with a
//      classification attached. That looks like a missing feature and is the
//      opposite: only the caller knows whether the same bytes may be resent or
//      the transaction must be rebuilt, and a pool that retried a submission on
//      its own would make that decision blindly, on the one operation where
//      being wrong charges someone twice.
//
//   3. Slot lag. A node that answers instantly with stale state passes every
//      latency check and quietly breaks confirmation tracking.
// ---------------------------------------------------------------------------

export interface SolanaRpcPoolOptions {
  providers: RpcProvider[];
  /** Preference multipliers by provider id; higher wins ties. */
  weights?: Record<string, number>;
  name?: string;
  onFailover?: (info: { from: string; to: string; error: unknown }) => void;
}

/** A submission failure, with the classification the caller needs to decide. */
export class SubmissionError extends Error {
  readonly classification: ReturnType<typeof classifyFailure>;
  readonly providerId: string;
  readonly cause: unknown;

  constructor(providerId: string, cause: unknown) {
    const classification = classifyFailure(cause);
    super(classification.message);
    this.name = "SubmissionError";
    this.classification = classification;
    this.providerId = providerId;
    this.cause = cause;
  }
}

export class SolanaRpcPool {
  private readonly pool: FailoverPool;
  private readonly providers: Map<string, RpcProvider>;

  constructor(opts: SolanaRpcPoolOptions) {
    if (!opts.providers.length) throw new RangeError("a pool needs at least one provider");
    this.providers = new Map(opts.providers.map((p) => [p.id, p]));
    this.pool = new FailoverPool({
      name: opts.name ?? "solana-rpc",
      endpoints: opts.providers.map((p) => ({
        id: p.id,
        // FailoverPool models endpoints by URL; this pool addresses providers
        // by id and holds the objects itself, so the URL is only a label here.
        url: p.id,
        weight: opts.weights?.[p.id],
      })),
      onFailover: opts.onFailover,
    });
  }

  /** Run a read against the healthiest provider, failing over as needed. */
  private read<T>(fn: (provider: RpcProvider) => Promise<T>): Promise<T> {
    return this.pool.execute(async (endpoint) => {
      const provider = this.providers.get(endpoint.id);
      if (!provider) throw new Error(`No provider registered for ${endpoint.id}`);
      return fn(provider);
    });
  }

  getLatestBlockhash(commitment: Commitment = "confirmed"): Promise<Blockhash> {
    return this.read((p) => p.getLatestBlockhash(commitment));
  }

  getBlockHeight(commitment: Commitment = "confirmed"): Promise<number> {
    return this.read((p) => p.getBlockHeight(commitment));
  }

  getSlot(commitment: Commitment = "confirmed"): Promise<number> {
    return this.read((p) => p.getSlot(commitment));
  }

  getRecentPrioritizationFees(accounts?: string[]): Promise<PrioritizationFeeSample[]> {
    return this.read((p) => p.getRecentPrioritizationFees(accounts));
  }

  /**
   * Submit signed bytes. ONE provider, ONE attempt.
   *
   * See the header: the retry decision is the caller's, because only the
   * caller knows whether these bytes may be resent or must be rebuilt. What
   * this returns on failure is a `SubmissionError` carrying that
   * classification, so the caller decides with the facts rather than a guess.
   */
  async submit(base64Tx: string, opts?: SendOptions): Promise<{ signature: string; providerId: string }> {
    const [first] = [...this.providers.values()];
    if (!first) throw new RangeError("no providers");

    // Ranked by the pool's health scoring, so this is the healthiest provider
    // rather than an arbitrary one — but the send itself does not fail over.
    const healthiest = this.rankedProviders()[0] ?? first;
    try {
      const signature = await healthiest.sendRawTransaction(base64Tx, opts);
      return { signature, providerId: healthiest.id };
    } catch (e) {
      throw new SubmissionError(healthiest.id, e);
    }
  }

  /**
   * Status for one signature, read from EVERY healthy provider and merged.
   *
   * Fanned out rather than taken from one node because providers disagree: one
   * has the transaction finalized, another has never seen it, because they sit
   * at different slots. `mergeOutcomes` resolves that — highest certainty wins,
   * except that a reported failure always beats a reported success.
   *
   * A provider that throws is skipped, not fatal. This runs while a customer
   * waits at a checkout, and one sick node must not stall the answer.
   */
  async observe(
    signature: string,
    ctx: { lastValidBlockHeight?: number } = {}
  ): Promise<{ outcome: ObservedOutcome; providersAnswered: number }> {
    const providers = this.rankedProviders();

    let currentBlockHeight: number | undefined;
    if (ctx.lastValidBlockHeight !== undefined) {
      // Only fetched when expiry is actually assertable, so a caller that does
      // not track the validity window pays nothing for it.
      currentBlockHeight = await this.getBlockHeight("confirmed").catch(() => undefined);
    }

    const results = await Promise.allSettled(
      providers.map((p) => p.getSignatureStatuses([signature]))
    );

    const outcomes: ObservedOutcome[] = [];
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      outcomes.push(
        interpretStatus(result.value[0], {
          currentBlockHeight,
          lastValidBlockHeight: ctx.lastValidBlockHeight,
        })
      );
    }

    return { outcome: mergeOutcomes(outcomes), providersAnswered: outcomes.length };
  }

  /**
   * Health across the pool, including slot lag.
   *
   * Lag is the reason this is not simply `pool.health()`: latency and error
   * rate are blind to a node that is fast, healthy and four hundred slots
   * behind — which is exactly the failure that makes confirmations appear to
   * hang for no visible reason.
   */
  async health(): Promise<{
    endpoints: EndpointHealth[];
    slotLag: number | null;
    slots: Record<string, number>;
  }> {
    const providers = [...this.providers.values()];
    const results = await Promise.allSettled(providers.map((p) => p.getSlot("confirmed")));

    const slots: Record<string, number> = {};
    const values: number[] = [];
    results.forEach((r, i) => {
      const provider = providers[i];
      if (!provider || r.status !== "fulfilled") return;
      slots[provider.id] = r.value;
      values.push(r.value);
    });

    return { endpoints: this.pool.health(), slotLag: slotLag(values), slots };
  }

  /** Providers ordered by the failover pool's own health scoring. */
  private rankedProviders(): RpcProvider[] {
    const ranked: RpcProvider[] = [];
    for (const h of this.pool.health()) {
      if (!h.healthy) continue;
      const provider = this.providers.get(h.id);
      if (provider) ranked.push(provider);
    }
    // Every endpoint tripped. Returning nothing would make the pool silently
    // dead; returning all of them lets a probe through so the breakers can
    // half-open and recover.
    return ranked.length ? ranked : [...this.providers.values()];
  }
}
