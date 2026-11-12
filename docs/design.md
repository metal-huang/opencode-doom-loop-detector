# Design

## Problem

opencode v2 accepts `doom_loop` as a permission action, but no code produces it. A repeated tool-call loop runs until the user notices. The v1 detector also missed periodic rotations, because it required three consecutive identical calls inside one assistant message.

## Detection principle

Count **per signature** (tool + canonical input), not by adjacency. Each signature stores only its last output hash and its current streak. A repeat counts only when the output is byte-identical, so a read-edit-test cycle with real progress never builds a streak. File results are normalized to a bounded content hash of their uri (plus mime and name), computed over the full string with a BigInt-free pass, so same-length middle-only differences remain distinct and the raw URI never enters the line store. No time window, no consecutive requirement: rotations of any period are caught, because each signature's streak is independent of what other signatures do in between.

Four detectors:

- **Same-message guard** (v1's working dimension, unchanged): the same call emitted 3 times inside one assistant message asks once.
- **Signal A**: per-signature identical-output streak, warn 3 / block 6.
- **Signal B**: line-level information novelty, warn 3/5, surgical ask at 8 only when that signature's A streak is ≥3, circuit breaker at 12. Outputs shorter than 3 lines are exempt.
- **Signal C**: per-signature failure-equivalence streak (normalized error hash), warn 4 / block 6. Successes of other signatures do not reset it.

## Intervention

Every stop goes through the existing `doom_loop` permission ask, so intentional polling has an escape hatch. New saved approvals are isolated per signal: a new approval for A, B, C, or the circuit breaker does not exempt another signal for the same call. A keeps its historical resource string, so approvals saved before this isolation still apply and cover only A. A user message resets A/C as well as B and the breaker (per-turn scope), so a periodic legitimate re-check cannot accumulate into a block over days. A denial of the circuit-breaker prompt makes the stop sticky; a rejection with feedback (`Permission.CorrectedError`) returns the feedback to the model instead of stopping.

## Cost and bounds

About 0.1 ms per tool call on a real 199-call incident corpus. No I/O, no runtime dependencies beyond the opencode plugin/schema packages and Effect. Memory is bounded: LRU caps on the signature, unobserved and failure maps (4096 each), a 10k line store with FIFO eviction and a 1KB per-line cap, and a 64-session LRU cache. After a restart, state is rebuilt from durable session history (fold). Host image handling is a declared uncertainty: opencode may rewrite image file parts after `execute.after` (`normalizeImages`) or during `media_blob` hydration, so the live hook and a later fold can hash slightly different file parts and lose or add one A tick. This is inferred from host behavior, not reproduced in this package.

## Links

- Upstream issue: https://github.com/anomalyco/opencode/issues/59339
- Upstream PR: https://github.com/anomalyco/opencode/pull/61328
- Interactive report: https://metal-huang.github.io/opencode/doom-loop-report/
- Prior-art review of 14 harnesses: https://metal-huang.github.io/opencode/doom-loop-report/prior-art.html
