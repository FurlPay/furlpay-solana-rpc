// ---------------------------------------------------------------------------
// The Solana RPC surface FurlPay's payment path actually needs.
//
// DELIBERATELY SMALL. A full Solana RPC has well over a hundred methods; a
// payment rail uses eight of them. Keeping the interface to what settlement
// requires means a provider adapter is a morning's work rather than a project,
// and it keeps the mock honest — a mock that has to implement `getBlockTime`
// to satisfy an interface nobody calls is a mock that will drift.
//
// NO @solana/web3.js DEPENDENCY. That is not squeamishness about the size of
// the library — apps/web already depends on it for transaction CONSTRUCTION,
// which is exactly what it is good at. It is that this package is the
// OPERATIONAL layer: submission, tracking, health. Those are JSON-RPC calls
// over HTTP, and taking a heavy dependency for them would make this package
// unusable from an Edge runtime and from the mobile app, both of which need to
// track a payment's status.
//
// COMMITMENT IS NOT A DETAIL. Every method that reads state takes one, and the
// three levels are not interchangeable:
//
//   processed  — a node saw it. Says nothing about the cluster.
//   confirmed  — a supermajority voted. Fast, and NOT irreversible.
//   finalized  — irreversible.
//
// @furlpay/settlement is the module that decides which one a given payment
// needs. This package's job is to report honestly which one was observed.
// ---------------------------------------------------------------------------

/** Solana's three commitment levels, in ascending order of certainty. */
export type Commitment = "processed" | "confirmed" | "finalized";

export interface Blockhash {
  blockhash: string;
  /** The last block height at which this blockhash is still valid. Past it,
   *  the transaction can never land and MUST be rebuilt (see errors.ts). */
  lastValidBlockHeight: number;
}

export interface SignatureStatus {
  slot: number;
  /** Cluster confirmations, or null once the transaction is rooted. */
  confirmations: number | null;
  /** Highest commitment reached. Null when the signature is not yet known. */
  confirmationStatus: Commitment | null;
  /** Non-null when the transaction landed but FAILED. Landing is not success. */
  err: unknown | null;
}

export interface EpochInfo {
  absoluteSlot: number;
  blockHeight: number;
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
}

export interface PrioritizationFeeSample {
  slot: number;
  /** Micro-lamports per compute unit paid in that slot. */
  prioritizationFee: number;
}

export interface HealthResult {
  healthy: boolean;
  latencyMs: number;
  /** How far this node is behind the highest slot it knows about. A node that
   *  answers instantly with hour-old state is worse than one that is slow. */
  slotLag?: number;
  error?: string;
}

/**
 * One Solana endpoint.
 *
 * Adapters implement this; the pool composes them. Nothing here retries or
 * fails over — that is the pool's job, and mixing the two would mean a
 * provider's internal retry silently multiplied the pool's.
 */
export interface RpcProvider {
  readonly id: string;

  getLatestBlockhash(commitment?: Commitment): Promise<Blockhash>;
  /** Returns the signature. Does NOT wait for confirmation. */
  sendRawTransaction(base64Tx: string, opts?: SendOptions): Promise<string>;
  getSignatureStatuses(signatures: string[]): Promise<(SignatureStatus | null)[]>;
  getSlot(commitment?: Commitment): Promise<number>;
  getBlockHeight(commitment?: Commitment): Promise<number>;
  getEpochInfo(commitment?: Commitment): Promise<EpochInfo>;
  getRecentPrioritizationFees(accounts?: string[]): Promise<PrioritizationFeeSample[]>;
  healthCheck(): Promise<HealthResult>;
}

export interface SendOptions {
  /**
   * Skip the node's own simulation.
   *
   * Default TRUE for a resend and false for a first attempt. On a resend the
   * transaction has already been simulated once, and a node that simulates
   * against newer state can reject bytes that are still perfectly valid —
   * turning a safe retry into a spurious failure.
   */
  skipPreflight?: boolean;
  maxRetries?: number;
  /** Commitment used for the node's preflight simulation. */
  preflightCommitment?: Commitment;
}

// ── JSON-RPC over HTTP ─────────────────────────────────────────────────────

export interface HttpProviderOptions {
  id: string;
  url: string;
  headers?: Record<string, string>;
  /** Per-request timeout. A hung socket must not stall the payment path. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

/** Raised for a JSON-RPC `error` body. Carries the code so `classifyFailure`
 *  and the pool's circuit breaker can both reason about it. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly providerId: string;

  constructor(providerId: string, code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
    this.providerId = providerId;
  }
}

/**
 * A plain HTTP JSON-RPC provider. No SDK, no WebSocket, no retry — retry and
 * failover belong to the pool, which composes these.
 */
export class HttpRpcProvider implements RpcProvider {
  readonly id: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(opts: HttpProviderOptions) {
    this.id = opts.id;
    this.url = opts.url;
    this.headers = opts.headers ?? {};
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error("No fetch implementation available; pass fetchImpl explicitly.");
    }
  }

  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Status carried in the message so classifyFailure's 502/503/504 and
        // rate-limit patterns match, and so resilience's own status-based
        // retry rules can read it.
        throw new RpcError(this.id, res.status, `HTTP ${res.status} from ${this.id}`);
      }

      const body = (await res.json()) as JsonRpcResponse<T>;
      if (body.error) {
        throw new RpcError(this.id, body.error.code, body.error.message, body.error.data);
      }
      if (body.result === undefined) {
        throw new RpcError(this.id, -1, `Empty result for ${method} from ${this.id}`);
      }
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async getLatestBlockhash(commitment: Commitment = "confirmed"): Promise<Blockhash> {
    const r = await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
      "getLatestBlockhash",
      [{ commitment }]
    );
    return {
      blockhash: r.value.blockhash,
      lastValidBlockHeight: r.value.lastValidBlockHeight,
    };
  }

  async sendRawTransaction(base64Tx: string, opts: SendOptions = {}): Promise<string> {
    return this.call<string>("sendTransaction", [
      base64Tx,
      {
        encoding: "base64",
        skipPreflight: opts.skipPreflight ?? false,
        preflightCommitment: opts.preflightCommitment ?? "confirmed",
        // Node-level retry is left off by default: the node retrying behind our
        // back makes our own attempt accounting a lie, and this package needs
        // to know exactly how many times the bytes were broadcast.
        maxRetries: opts.maxRetries ?? 0,
      },
    ]);
  }

  async getSignatureStatuses(signatures: string[]): Promise<(SignatureStatus | null)[]> {
    const r = await this.call<{ value: (SignatureStatus | null)[] }>("getSignatureStatuses", [
      signatures,
      // Without this the node only answers for recent signatures, and a
      // payment being tracked across a restart would look like it vanished.
      { searchTransactionHistory: true },
    ]);
    return r.value;
  }

  async getSlot(commitment: Commitment = "confirmed"): Promise<number> {
    return this.call<number>("getSlot", [{ commitment }]);
  }

  async getBlockHeight(commitment: Commitment = "confirmed"): Promise<number> {
    return this.call<number>("getBlockHeight", [{ commitment }]);
  }

  async getEpochInfo(commitment: Commitment = "confirmed"): Promise<EpochInfo> {
    return this.call<EpochInfo>("getEpochInfo", [{ commitment }]);
  }

  async getRecentPrioritizationFees(accounts: string[] = []): Promise<PrioritizationFeeSample[]> {
    return this.call<PrioritizationFeeSample[]>("getRecentPrioritizationFees", [accounts]);
  }

  async healthCheck(): Promise<HealthResult> {
    const started = Date.now();
    try {
      // getSlot rather than getHealth: `getHealth` answers "ok" from a node
      // that is behind, and a node serving stale state breaks confirmation
      // tracking in a way that is very hard to diagnose. A slot number can be
      // compared against the rest of the pool.
      await this.getSlot("confirmed");
      // slotLag is deliberately absent, not zero. This provider can see its own
      // slot but has no view of the rest of the pool, so it cannot know how far
      // behind it is — the pool computes that by comparing across providers.
      // Reporting 0 here would assert "perfectly current" on no evidence.
      return { healthy: true, latencyMs: Date.now() - started };
    } catch (e) {
      return {
        healthy: false,
        latencyMs: Date.now() - started,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
