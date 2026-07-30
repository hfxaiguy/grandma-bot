// =============================================================================
// src/patterns/agent.ts
// =============================================================================
//
// The agent pattern — a grandma-kat `Tree` that drives one Telegram turn.
// Composed from three standalone branches, each in its own file:
//
//   agentPattern                       (root tree, name = "agent")
//     ├─ classify (branch)             classify.ts — cheap: "tools" | "direct"
//     ├─ direct  (branch, gated)      direct.ts  — cheap: text-only answer
//     └─ tools   (branch, gated)      tools.ts   — strong: tool-using loop
//
// The root tree has THREE children. The first always runs (it produces
// the classification). The other two are gated by `when()` on the
// classify branch's output — exactly one of `direct`/`tools` fires,
// never both, never neither (the classify `.check()` guarantees the
// answer is parseable).
//
// -----------------------------------------------------------------------------
// WHY PER-STEP MODEL SELECTION
// -----------------------------------------------------------------------------
//
// Routing a Telegram turn through a small model first lets us spend the
// expensive model only on cases that need it. A "what's the capital of
// France?" turn should not pay for the 31B MoE running a tools loop;
// it can be answered in one cheap-model call. A "create mock.txt with…"
// turn must reach the strong model. The classifier is the gate.
//
// -----------------------------------------------------------------------------
// RETURN CONTRACT
// -----------------------------------------------------------------------------
//
// `agentPattern` exports the FINAL ASSISTANT TEXT as the tree's `result`.
// The terminal branches end with a `.memory("final", …)` child that
// captures the prompt's text via `m.prev[1]` (the second-to-last
// executed child, which is the prompt). The runner records that value
// in the branch's local scope under the name "final"; the branch's
// last child is "final", so the branch's exported value is the text.
//
// The agent reads `memory.messages` for the full updated conversation
// history (including any tool exchanges from this turn) and copies
// that array back onto the caller's `messages`. The text is the
// return value of `agent.runTurn()`.
//
// -----------------------------------------------------------------------------
// HISTORY MANAGEMENT
// -----------------------------------------------------------------------------
//
// The conversation history lives in the ROOT scope under the name
// "messages" (injected by the agent via `memory: { messages, system }`).
// Each terminal branch's `memoryUpdate("messages", …)` appends this
// turn's exchange to that array. Because grandma-kat's runner now
// correctly writes through the scope chain (the previous "ancestor
// shadow" bug was fixed: `record()` reads `outcome._slotScope` and
// writes to the actual target scope, not always the local), the
// walker's pass-2 lookup hits the root and continues updating the
// correct slot across until() iterations.
//
// For the tools branch specifically, the per-pass child order is:
//
//   #0  prompt(...)                                LLM call + tool execution
//   #1  memoryUpdate("messages", …)               append this turn's exchange
//   #2  memory("final", m => m.prev[1])           capture the prompt's text
//   --  until(no toolCalls, max(12))               container loop (not a child)
//
// At the until check, `m.raw.prev[2]` is the prompt's record from
// this pass (its `.toolCalls` array tells us whether to loop).
//
// -----------------------------------------------------------------------------
// DESIGN PRINCIPLE: branches are standalone trees
// -----------------------------------------------------------------------------
//
// Each branch lives in its own file (`classify.ts`, `direct.ts`,
// `tools.ts`) and exports a single `Tree.name(...)` definition. This
// file imports the branches it needs and composes them with `.branch()`
// and `when()` gates. To add a new behavior:
//
//   1. Create `src/patterns/my-branch.ts`, export a named Tree.
//   2. Import it here.
//   3. `.branch()` it onto the root (with a `when()` gate if conditional).
//
// No registry, no runtime discovery, no plugin system — just imports and
// composition. The branches are plain values; the tree is plain data. If
// a branch needs something from another branch, it reads from the memory
// scope chain (e.g. `m.branch.classify`), not by importing the other
// branch. Branches never import each other.
//
// =============================================================================

// @ts-ignore — grandma-kat ships no .d.ts files.
import { Tree, when, goback, max } from "grandma-kat";
import { readClassifyDecision } from "./shared.js";
import { classifyBranch } from "./classify.js";
import { directBranch } from "./direct.js";
import { toolsBranch } from "./tools.js";

export const agentPattern = Tree.name("agent")
  .branch(classifyBranch)
  .branch(
    // Direct gate: only fires when classify said "direct" (case- and
    // punctuation-normalised). If classify's answer is malformed
    // the check exhausts and KnitError throws before we reach here.
    when((m: { branch: { classify?: unknown } }) => readClassifyDecision(m) === "direct"),
    directBranch,
  )
  .branch(
    // Tools gate: only fires when classify said "tools". Mutually
    // exclusive with the direct branch — exactly one terminal fires.
    when((m: { branch: { classify?: unknown } }) => readClassifyDecision(m) === "tools"),
    toolsBranch,
  );

// Re-export the three grandma-kat markers so callers who want to
// compose or extend this pattern (e.g. add a "summarize" branch gated
// on long histories) can import them from a single place.
export { when, goback, max };
