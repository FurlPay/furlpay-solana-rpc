// ---------------------------------------------------------------------------
// What a Solana submission failure actually means, and whether resending is
// safe.
//
// THIS IS THE MOST DANGEROUS DECISION IN THE PAYMENT PATH. Generic retry logic
// — including @furlpay/resilience's executeWithRetry, which this package uses
// everywhere else — reasons about HTTP status codes and transport faults. It
// cannot know that a Solana transaction carries a blockhash that expires, or
// that "already processed" means the payment SUCCEEDED and must never be sent
// again.
//
// Two failure modes sit on opposite sides of one decision:
//
//   RESEND THE SAME BYTES. Correct for a transport failure — the transaction
//   may never have reached a leader. The signature is unchanged, so if it did
//   land, the network deduplicates it. Safe.
//
//   REBUILD WITH A FRESH BLOCKHASH. Required once the blockhash has expired.
//   This produces a DIFFERENT SIGNATURE, so it is a genuinely new transaction —
//   and if the original somehow lands afterwards, the customer is charged
//   twice. Only safe once the original is provably dead.
//
// Confusing those two is how a payments company double-charges. So the classes
// below are deliberately narrow, the default is the conservative one, and
// `rebuildRequired` is never set on anything that might still land.
//
// EVERY STRING MATCHED HERE IS A REAL SOLANA ERROR. They come from the RPC's
// JSON error bodies and from TransactionError variants in the transaction
// status. Where a match is uncertain the code falls through to `unknown`,
// which does not retry — an unrecognised failure in a money path is not an
// invitation to guess.
// ---------------------------------------------------------------------------

/** What went wrong, in terms the payment engine can act on. */
export type SolanaFailureKind =
  /** The transaction is confirmed. This is a SUCCESS wearing an error's coat. */
  | "already_processed"
  /** Blockhash no longer valid. The bytes can never land. Rebuild required. */
  | "blockhash_expired"
  /** Never reached the network, or the answer was lost. Same bytes are safe. */
  | "transport"
  /** The node refused us — rate limit, auth. Another endpoint may accept it. */
  | "node_rejected"
  /** Simulation says this cannot succeed. Retrying changes nothing. */
  | "simulation_failed"
  /** Payer or token account lacks the funds. Terminal until topped up. */
  | "insufficient_funds"
  /** Compute budget exceeded. Terminal for these bytes. */
  | "compute_exceeded"
  /** The program rejected it. Terminal. */
  | "program_error"
  /** Not recognised. Treated as terminal — see the module header. */
  | "unknown";

export interface FailureClassification {
  kind: SolanaFailureKind;

  /**
   * Safe to resend THE SAME SIGNED BYTES.
   *
   * The signature is unchanged, so a duplicate is deduplicated by the network
   * rather than executed twice. This is the safe kind of retry.
   */
  resendSafe: boolean;

  /**
   * The transaction must be rebuilt with a fresh blockhash to have any chance.
   *
   * DANGEROUS: a rebuild is a new signature, so it is a new transaction. Only
   * ever true when the original is provably incapable of landing — which is
   * exactly and only the expired-blockhash case.
   */
  rebuildRequired: boolean;

  /** Nothing the client can do will change the outcome. */
  terminal: boolean;

  /**
   * Trying a different RPC endpoint may help. Set for node-level refusals,
   * where the transaction is fine and the node is not.
   */
  tryAnotherEndpoint: boolean;

  /** What to show a human. Never a raw error string. */
  message: string;
}

/** Matched case-insensitively against the error text. */
interface Rule {
  kind: SolanaFailureKind;
  patterns: RegExp[];
  classification: Omit<FailureClassification, "kind" | "message">;
  message: string;
}

const RULES: Rule[] = [
  {
    // FIRST, because it is the one that must never be misread. The RPC reports
    // this as an error, but it means the transaction is already in a block.
    // Rebuilding here would charge the customer a second time.
    kind: "already_processed",
    patterns: [
      /already been processed/i,
      /AlreadyProcessed/,
      /this transaction has already been processed/i,
    ],
    classification: {
      resendSafe: false,
      rebuildRequired: false,
      terminal: true,
      tryAnotherEndpoint: false,
    },
    message: "This payment has already gone through.",
  },
  {
    kind: "blockhash_expired",
    patterns: [
      /BlockhashNotFound/,
      /blockhash not found/i,
      /block height exceeded/i,
      /TransactionExpiredBlockheightExceeded/,
    ],
    classification: {
      // The bytes are dead — resending them is pure waste. A rebuild is the
      // only path, and it is safe HERE specifically because an expired
      // blockhash means the original can never be included.
      resendSafe: false,
      rebuildRequired: true,
      terminal: false,
      tryAnotherEndpoint: false,
    },
    message: "The payment took too long to reach the network and needs to be signed again.",
  },
  {
    kind: "insufficient_funds",
    patterns: [
      /InsufficientFundsForRent/,
      /Insufficient funds/i,
      /insufficient lamports/i,
      /InsufficientFunds/,
      /custom program error: 0x1/,
    ],
    classification: {
      resendSafe: false,
      rebuildRequired: false,
      terminal: true,
      tryAnotherEndpoint: false,
    },
    message: "There isn't enough balance in the wallet to cover this payment.",
  },
  {
    kind: "compute_exceeded",
    patterns: [/exceeded CUs meter/i, /ComputationalBudgetExceeded/, /exceeded compute budget/i],
    classification: {
      resendSafe: false,
      rebuildRequired: false,
      terminal: true,
      tryAnotherEndpoint: false,
    },
    message: "This payment was too complex to process in one transaction.",
  },
  {
    kind: "node_rejected",
    patterns: [
      /rate limit/i,
      /too many requests/i,
      /429/,
      /unauthorized/i,
      /forbidden/i,
      /api key/i,
    ],
    classification: {
      // The transaction is fine; this node will not take it. Both resending
      // and switching endpoints are reasonable.
      resendSafe: true,
      rebuildRequired: false,
      terminal: false,
      tryAnotherEndpoint: true,
    },
    message: "The payment network is busy. Retrying.",
  },
  {
    kind: "transport",
    patterns: [
      /fetch failed/i,
      /network error/i,
      /ECONNRESET/,
      /ETIMEDOUT/,
      /ENOTFOUND/,
      /socket hang up/i,
      /timeout/i,
      /aborted/i,
      /502|503|504/,
    ],
    classification: {
      // The critical safe case: we do not know whether it landed, so we resend
      // THE SAME BYTES. Identical signature, so the network deduplicates.
      resendSafe: true,
      rebuildRequired: false,
      terminal: false,
      tryAnotherEndpoint: true,
    },
    message: "Couldn't reach the payment network. Retrying.",
  },
  {
    kind: "simulation_failed",
    patterns: [/simulation failed/i, /Transaction simulation failed/i],
    classification: {
      resendSafe: false,
      rebuildRequired: false,
      terminal: true,
      tryAnotherEndpoint: false,
    },
    message: "This payment can't be completed as built.",
  },
  {
    kind: "program_error",
    patterns: [/custom program error/i, /InstructionError/, /ProgramFailedToComplete/],
    classification: {
      resendSafe: false,
      rebuildRequired: false,
      terminal: true,
      tryAnotherEndpoint: false,
    },
    message: "The payment was rejected on-chain.",
  },
];

/**
 * Read a failure.
 *
 * Rule order is significant and is not alphabetical: `already_processed` is
 * checked before everything because misreading it is the only classification
 * error here that charges a customer twice. `insufficient_funds` precedes the
 * generic `program_error` because it is a custom program error, and the
 * specific message is far more useful than "rejected on-chain".
 */
export function classifyFailure(error: unknown): FailureClassification {
  const text = errorText(error);

  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(text))) {
      return { kind: rule.kind, ...rule.classification, message: rule.message };
    }
  }

  // Unrecognised. Deliberately conservative: no resend, no rebuild, terminal.
  //
  // The alternative — treating unknown as retryable — means any future Solana
  // error string this table has not seen becomes an automatic retry loop in a
  // money path. Failing closed turns that into one visible failure instead.
  return {
    kind: "unknown",
    resendSafe: false,
    rebuildRequired: false,
    terminal: true,
    tryAnotherEndpoint: false,
    message: "This payment couldn't be completed.",
  };
}

/**
 * Flatten anything an RPC layer might throw into searchable text.
 *
 * Solana errors arrive in several shapes: an Error, a JSON-RPC `{ code,
 * message }`, a `TransactionError` object like `{ InstructionError: [0, {
 * Custom: 1 }] }`, or a string. Serialising the whole thing means a nested
 * variant name is still matched, rather than being lost because it was not on
 * `.message`.
 */
function errorText(error: unknown): string {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error;

  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.name, error.message);
    // Node puts ECONNRESET and friends on `.code`, not in the message.
    const code = (error as { code?: unknown }).code;
    if (code !== undefined) parts.push(String(code));
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined) parts.push(errorText(cause));
  }

  try {
    // Captures JSON-RPC bodies and TransactionError variants, including the
    // `logs` array where "insufficient lamports" usually appears.
    parts.push(JSON.stringify(error));
  } catch {
    parts.push(String(error));
  }

  return parts.join(" ");
}

/**
 * The one-line question the retry engine asks.
 *
 * Returns what to DO, not what happened — so a caller cannot accidentally
 * rebuild on a classification that merely allows a resend.
 */
export type RetryAction = "resend" | "rebuild" | "give_up";

export function retryAction(classification: FailureClassification): RetryAction {
  if (classification.rebuildRequired) return "rebuild";
  if (classification.resendSafe) return "resend";
  return "give_up";
}
