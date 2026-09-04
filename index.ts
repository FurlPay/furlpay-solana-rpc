// ---------------------------------------------------------------------------
// @furlpay/solana-rpc — the operational half of the Solana payment rail.
//
// apps/web already CONSTRUCTS real Solana transfers (lib/actions/solana.ts:
// SOL and SPL transfers, ATA derivation, fee splitting). What it does not do
// is anything after signing — that file says so itself, building payloads
// "WITHOUT a live RPC round-trip".
//
// This package is that missing half: submit, track, interpret, and stay
// healthy across multiple providers.
//
// IT DOES NOT BUILD TRANSACTIONS, and that is deliberate. Construction needs
// @solana/web3.js and belongs where it already is. Submission and tracking are
// JSON-RPC over HTTP, so keeping them free of that dependency lets this run in
// an Edge runtime and in the mobile app — both of which need to follow a
// payment's status without shipping a transaction builder.
//
// THE THREE THINGS WORTH KNOWING:
//
//   1. Failover and retry come from @furlpay/resilience. Its FailoverPool
//      already does per-endpoint circuit breaking and EWMA latency scoring; a
//      second implementation here would be duplicated infrastructure in a
//      money path.
//
//   2. Submission is never retried automatically. `pool.submit()` makes one
//      attempt and throws a SubmissionError carrying a classification. Only
//      the caller knows whether the same bytes may be resent (safe — identical
//      signature, network deduplicates) or the transaction must be rebuilt
//      (a NEW signature, and therefore a possible double charge). See errors.ts.
//
//   3. Nothing here decides what a payment needs. @furlpay/settlement owns
//      that. This package reports honestly what was observed; that one decides
//      whether it is enough.
// ---------------------------------------------------------------------------

export {
  classifyFailure,
  retryAction,
  type FailureClassification,
  type RetryAction,
  type SolanaFailureKind,
} from "./src/errors.js";

export {
  HttpRpcProvider,
  RpcError,
  type Blockhash,
  type Commitment,
  type EpochInfo,
  type HealthResult,
  type HttpProviderOptions,
  type PrioritizationFeeSample,
  type RpcProvider,
  type SendOptions,
  type SignatureStatus,
} from "./src/provider.js";

export {
  interpretStatus,
  isTerminal,
  meetsRequirement,
  mergeOutcomes,
  satisfies,
  slotLag,
  type ObservedOutcome,
} from "./src/confirmation.js";

export {
  SolanaRpcPool,
  SubmissionError,
  type SolanaRpcPoolOptions,
} from "./src/pool.js";
