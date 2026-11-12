# Design

## Problem

opencode v2 accepts `doom_loop` as a permission action, but no code produces it. A repeated tool-call loop runs until the user notices. The v1 detector also missed periodic rotations, because it required three consecutive identical calls inside one assistant message.

## Detection principle

Count **per signature** (tool + canonical input), not by adjacency. Each signature stores only its last output hash and its current streak. A repeat counts only when the output is byte-identical, so a read-edit-test cycle with real progress never builds a streak. File results are normalized to a bounded hash of their uri, mime, and name, so different attachments are distinguishable and a data URI never enters the line store. No time window, no consecutive requirement: rotations of any period are caught, because each signature's streak is independent of what other signatures do in between.

Four detectors:

- **Same-message guard** (v1's working dimension, unchanged): the same call emitted 3 times inside one assistant message asks once.
- **Signal A**: per-signature identical-output streak, warn 3 / block 6.
- **Signal B**: line-level information novelty, warn 3/5, surgical ask at 8 only when that signature's A streak is ≥3, circuit breaker at 12. Outputs shorter than 3 lines are exempt.
- **Signal C**: per-signature failure-equivalence streak (normalized error hash), warn 4 / block 6. Successes of other signatures do not reset it.

## Intervention

Every stop goes through the existing `doom_loop` permission ask, so intentional polling has an escape hatch. Saved approvals are isolated per signal: approving A does not exempt B or C for the same call, while A keeps its historical resource string so earlier approvals still apply. A user message resets A/C as well as B and the breaker (per-turn scope), so a periodic legitimate re-check cannot accumulate into a block over days. A denial of the circuit-breaker prompt makes the stop sticky; a rejection with feedback (`Permission.CorrectedError`) returns the feedback to the model instead of stopping.

## Cost and bounds

About 0.1 ms per tool call on a real 199-call incident corpus. No I/O, no runtime dependencies beyond the opencode plugin/schema packages and Effect. Memory is bounded: LRU caps on the signature, unobserved and failure maps (4096 each), a 10k line store with FIFO eviction and a 1KB per-line cap, and a 64-session LRU cache. After a restart, state is rebuilt from durable session history (fold).

## Links

- Upstream issue: https://github.com/anomalyco/opencode/issues/59339
- Upstream PR: https://github.com/anomalyco/opencode/pull/61328
- Interactive report: https://metal-huang.github.io/opencode/doom-loop-report/
- Prior-art review of 14 harnesses: https://metal-huang.github.io/opencode/doom-loop-report/prior-art.html
