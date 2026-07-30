// =============================================================================
// src/patterns/classify.ts
// =============================================================================
//
// Classify branch — runs on the cheap model, answers "tools" or "direct".
//
// The branch's exported value is the prompt's text (the model's reply),
// which the runner stores in `m.branch.classify` in the parent's scope —
// that's the slot the root tree's `when()` gates on.
//
// Why this branch is NOT gated: the root tree always needs a
// classification before it can decide whether to run `direct` or
// `tools`. Gating `classify` would deadlock the tree.
//
// =============================================================================

// @ts-ignore — grandma-kat ships no .d.ts files.
import { Tree, goback, max } from "grandma-kat";
import { readMessages } from "./shared.js";

/**
 * The system prompt for the classify step. The model is asked to
 * reason briefly about whether the user's latest message requires a
 * workspace tool, then emit exactly one of two sentinel words.
 * Anything else is rejected by the branch's `.check()` and the model
 * is retried with feedback (up to `max(2)` retries = 1 initial + 2
 * retries).
 *
 * Why the strict one-word format: a free-form answer ("I think this
 * needs tools because…") would require fuzzy parsing here and would
 * break the `when()` gates downstream. A small model handles the
 * restricted output reliably; the `.check()` enforces it.
 */
const CLASSIFY_SYSTEM = `Decide whether the user's latest message needs workspace tools (file editing, shell commands, git operations) or can be answered with text alone.

Answer with EXACTLY one word: "tools" or "direct".`;

export const classifyBranch = Tree.name("classify")
  // Use the cheap model — the classification task is trivial (a few
  // hundred input tokens, one output token). Spending the strong
  // model here is pure waste.
  .model("cheap")

  // The prompt sees the FULL conversation history, not just the
  // latest user message. The classifier needs prior context to
  // disambiguate terse follow-ups like "do it" or "fix that" (which
  // "it"?). On the first turn, that's just [system + user]; on later
  // turns it grows.
  .prompt((m: { messages?: unknown }) => [
    { role: "system", content: CLASSIFY_SYSTEM },
    ...readMessages(m),
  ])

  // Validate the answer. If the model emits anything other than
  // exactly "tools" or "direct" (after case + punctuation
  // normalisation), the check fails with feedback and
  // `goback(1, max(2))` rewinds to the prompt and retries. Total
  // budget: 1 initial + 2 retries = 3 calls. Exhaustion throws
  // `KnitError` (the max()'s `errFn` becomes the thrown message);
  // the agent catches and surfaces "Something went wrong" to the
  // user. The `m.error` interpolation in `errFn` is the last
  // check-feedback string the model saw.
  .check(
    (m: { prev: unknown[] }) => {
      const a = String(m.prev[0] ?? "").trim().toLowerCase().replace(/[.!?,]+$/g, "");
      if (a === "tools" || a === "direct") return true;
      return 'Answer with EXACTLY one word: "tools" or "direct".';
    },
    goback(1, max(2, (m: { error?: unknown }) => `classify never answered validly: ${m.error}`)),
  );
