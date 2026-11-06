import { describe, expect, it } from "bun:test"
import { Effect, Exit, Option, Queue, Scope, Stream } from "effect"
import { makePlugin } from "../src/index.js"
import { DoomLoopDetector } from "../src/detector.js"
import { Tool } from "@opencode/schema/tool"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { SessionEvent } from "@opencode/schema/session-event"

type BeforeHook = (input: { tool: string; input: unknown; sessionID: string; messageID: string; id: string; agent?: string }) => Effect.Effect<void, Tool.Error>
type AfterHook = (input: { tool: string; input: unknown; sessionID: string; status: string; result?: { content: unknown; output?: unknown; metadata?: Record<string, unknown> }; error?: Tool.Error }) => Effect.Effect<void>
type Outcome = () => Effect.Effect<void, Tool.Error>

interface Harness {
  readonly before: BeforeHook
  readonly after: AfterHook
  readonly asserted: { resources: ReadonlyArray<string> }[]
  readonly interrupts: () => number
  readonly setOutcome: (outcome: Outcome) => void
  readonly publish: (event: SessionEvent.Info) => Effect.Effect<void, Error>
}

const sessionID = "ses_doom_loop"

function makeHistoryCall(id: string, tool: string, input: unknown, out: string): SessionMessage.Info {
  return {
    type: "assistant",
    content: [
      {
        type: "tool",
        id,
        name: tool,
        state: { status: "completed", input, content: [{ type: "text", text: out }] },
      },
    ],
  } as unknown as SessionMessage.Info
}

async function run(options?: { history?: SessionMessage.Info[]; cap?: number; storage?: Map<string, unknown>; eventStream?: Stream.Stream<SessionEvent.Info> }): Promise<Harness> {
  let beforeHook: BeforeHook | undefined
  let afterHook: AfterHook | undefined
  const asserted: { resources: ReadonlyArray<string> }[] = []
  let interrupts = 0
  let outcome: Outcome = () => Effect.void
  const queue = Effect.runSync(Queue.unbounded<SessionEvent.Info>())
  const storage = options?.storage ?? new Map<string, unknown>()
  const scope = Effect.runSync(Scope.make())

  const ctx = {
    tool: {
      hook: (name: string, callback: unknown) => {
        if (name === "execute.before") beforeHook = callback as BeforeHook
        if (name === "execute.after") afterHook = callback as AfterHook
        return Effect.void
      },
    },
    permission: {
      assert: (input: { resources: ReadonlyArray<string> }) => {
        asserted.push(input)
        return outcome()
      },
    },
    session: {
      context: () => Effect.succeed(options?.history ?? []),
      interrupt: () => {
        interrupts++
        return Effect.void
      },
    },
    storage: {
      get: (key: string) => Effect.succeed(storage.get(key)),
      set: (key: string, value: unknown) => Effect.sync(() => void storage.set(key, value)),
      remove: (key: string) =>
        Effect.sync(() => {
          console.log("storage.remove", key)
          void storage.delete(key)
        }),
    },
    event: {
      subscribe: () => options?.eventStream ?? Stream.fromQueue(queue),
    },
  }

  await Effect.runPromise(
    Effect.provideService(makePlugin({ maxTrackedSessions: options?.cap }).effect(ctx as never), Scope.Scope, scope),
  )

  return {
    before: (input) => beforeHook!(input),
    after: (input) => afterHook!(input),
    asserted,
    interrupts: () => interrupts,
    setOutcome: (next) => {
      outcome = next
    },
    publish: (event) => Effect.as(Queue.offer(queue, event), undefined),
  }
}

const text = (value: string) => ({ content: [{ type: "text", text: value }] })
const beforeEvent = (tool: string, input: unknown, id: string, ses = sessionID) => ({ tool, input, sessionID: ses, messageID: id, id })
const completedEvent = (tool: string, input: unknown, id: string, result: { content: unknown }, ses = sessionID) => ({
  tool,
  input,
  sessionID: ses,
  status: "completed",
  result,
})
const errorEvent = (tool: string, input: unknown, id: string, error: Tool.Error, ses = sessionID) => ({
  tool,
  input,
  sessionID: ses,
  status: "error",
  error,
})

async function emit(h: Harness, tool: string, input: unknown, id: string, result: { content: unknown }, ses = sessionID) {
  await Effect.runPromise(Effect.exit(h.before(beforeEvent(tool, input, id, ses))))
  await Effect.runPromise(h.after(completedEvent(tool, input, id, result, ses)))
}

describe("doom loop plugin (standalone)", () => {
  it("asks once at the 3rd identical emission within one message", async () => {
    const h = await run()
    const input = { command: "git status" }
    for (let i = 1; i <= 2; i++) {
      await Effect.runPromise(h.before(beforeEvent("shell", input, "g_1")))
      expect(h.asserted).toHaveLength(0)
    }
    const exit = await Effect.runPromise(Effect.exit(h.before(beforeEvent("shell", input, "g_1"))))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(h.asserted).toHaveLength(0)
  })

  it("challenges the 7th identical output emission of one signature", async () => {
    const h = await run()
    const input = { pattern: "TODO" }
    const out = "src/a.ts:1:TODO\nsrc/b.ts:2:TODO\nsrc/c.ts:3:TODO"
    for (let i = 1; i <= 6; i++) {
      await emit(h, "grep", input, `a_${i}`, text(out))
    }
    expect(h.asserted).toHaveLength(0)
    const exit = await Effect.runPromise(Effect.exit(h.before(beforeEvent("grep", input, "a_7"))))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(h.asserted).toHaveLength(0)
  })

  it("resets B and lets the run continue when the circuit ask is allowed", async () => {
    const h = await run()
    const input = { command: "probe" }
    const out = (i: number) => `probe ${i}\nstatic line one\nstatic line two`
    for (let i = 1; i <= 13; i++) {
      await emit(h, "shell", input, `al_${i}`, text(out(i)))
    }
    const exit = await Effect.runPromise(Effect.exit(h.before(beforeEvent("shell", input, "al_14"))))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(h.asserted).toHaveLength(0)
    expect(h.interrupts()).toBe(0)
  })

  it("makes a denied circuit sticky and does not re-ask on retry", async () => {
    const h = await run()
    const input = { command: "probe" }
    const out = (i: number) => `probe ${i}\nstatic line one\nstatic line two`
    for (let i = 1; i <= 13; i++) {
      await emit(h, "shell", input, `dn_${i}`, text(out(i)))
    }
    const exit1 = await Effect.runPromise(Effect.exit(h.before(beforeEvent("shell", input, "dn_14"))))
    expect(Exit.isFailure(exit1)).toBe(true)
    expect(h.asserted).toHaveLength(0)
    const exit2 = await Effect.runPromise(Effect.exit(h.before(beforeEvent("shell", input, "dn_15"))))
    expect(Exit.isFailure(exit2)).toBe(true)
    expect(h.asserted).toHaveLength(0)
    expect(h.interrupts()).toBe(0)
  })

  it("returns a host-wrapped CorrectedError as feedback without a sticky stop", async () => {
    const h = await run()
    const input = { command: "probe" }
    const out = (i: number) => `probe ${i}\nstatic line one\nstatic line two`
    for (let i = 1; i <= 13; i++) {
      await emit(h, "shell", input, `ce_${i}`, text(out(i)))
    }
    h.setOutcome(() =>
      Effect.fail(
        new Tool.Error({
          message: "Use staging instead",
          error: { _tag: "Permission.CorrectedError", feedback: "Use staging instead" } as never,
        }),
      ),
    )
    const exit = await Effect.runPromise(Effect.exit(h.before(beforeEvent("shell", input, "ce_14"))))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(h.interrupts()).toBe(0)
    expect(h.asserted).toHaveLength(0)
  })

  it("resets A and C on a real user message", async () => {
    const deferred = Promise.withResolvers<void>()
    const userEvent = {
      type: "session.inbox.enqueued",
      data: { sessionID, item: { type: "user", payload: { text: "stop that" }, delivery: "queue" } },
    }
    const h = await run({
      // The event stream emits the user message when the test resolves it after six calls.
      eventStream: Stream.fromEffect(Effect.promise(() => deferred.promise)).pipe(
        Stream.map(() => userEvent),
        Stream.concat(Stream.never),
      ) as never,
    })
    const input = { command: "git status" }
    const out = "on branch main\nnothing to commit\nworking tree clean"
    for (let i = 1; i <= 6; i++) {
      await emit(h, "shell", input, `u_${i}`, text(out))
    }
    deferred.resolve()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const exit = await Effect.runPromise(Effect.exit(h.before(beforeEvent("shell", input, "u_7"))))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(h.asserted).toHaveLength(0)
  })

  it("folds durable history into A on first touch and challenges the 7th identical emission", async () => {
    const input = { pattern: "TODO", path: "src" }
    const out = "src/a.ts:1:TODO\nsrc/b.ts:2:TODO\nsrc/c.ts:3:TODO"
    const history = Array.from({ length: 6 }, (_, i) => makeHistoryCall(`a_${i}`, "grep", input, out))
    const h = await run({ history })
    const exit = await Effect.runPromise(Effect.exit(h.before(beforeEvent("grep", input, "a_7"))))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(h.asserted).toHaveLength(0)
  })

  it("evicts the least recently touched session past the cap and re-folds it from history", async () => {
    const sesA = "ses_lru_a"
    const sesB = "ses_lru_b"
    const sesC = "ses_lru_c"
    const input = { pattern: "TODO", path: "src" }
    const out = "src/a.ts:1:TODO\nsrc/b.ts:2:TODO\nsrc/c.ts:3:TODO"
    const h = await run({ history: [makeHistoryCall("lru_a1", "grep", input, out), makeHistoryCall("lru_a2", "grep", input, out)], cap: 2 })
    await emit(h, "grep", input, "lru_a3", text(out), sesA)
    await emit(h, "grep", { pattern: "b" }, "lru_b1", text("b one"), sesB)
    await emit(h, "grep", { pattern: "c" }, "lru_c1", text("c one"), sesC)
    await emit(h, "grep", { pattern: "b" }, "lru_b2", text("b one"), sesB)
    const before = await Effect.runPromise(Effect.exit(h.before(beforeEvent("grep", input, "lru_a4", sesA))))
    expect(Exit.isSuccess(before)).toBe(true)
    expect(h.asserted).toHaveLength(0)
  })
})
