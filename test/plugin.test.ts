import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit, Logger, Option, Queue, References, Scope, Stream } from "effect"
import { makePlugin } from "../src/index.js"
import { DoomLoopDetector } from "../src/detector.js"
import { Tool } from "@opencode/schema/tool"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { SessionEvent } from "@opencode/schema/session-event"

type BeforeHook = (input: { tool: string; input: unknown; sessionID: string; messageID: string; id: string; agent?: string }) => Effect.Effect<void, Tool.Error>
type AfterHook = (input: { tool: string; input: unknown; sessionID: string; status: string; result?: { content: unknown; output?: unknown; metadata?: Record<string, unknown> }; error?: Tool.Error }) => Effect.Effect<void>
type Outcome = () => Effect.Effect<void, Tool.Error>

interface CapturedLog {
  readonly level: string
  readonly message: ReadonlyArray<unknown>
}

interface Harness {
  readonly before: BeforeHook
  readonly after: AfterHook
  readonly asserted: { resources: ReadonlyArray<string> }[]
  readonly interrupts: () => number
  readonly setOutcome: (outcome: Outcome) => void
  readonly publish: (event: SessionEvent.Info) => Effect.Effect<void, Error>
  readonly logs: ReadonlyArray<CapturedLog>
}

const sessionID = "ses_doom_loop"

// Local Effect logger: captures structured log arguments without touching the global console and
// without changing the hook's Exit.
function makeLogCapture() {
  const logs: CapturedLog[] = []
  const logger = Logger.make(({ logLevel, message }) => {
    logs.push({ level: logLevel, message: Array.isArray(message) ? message : [message] })
  })
  const observe = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.provide(
      Effect.provideService(Effect.withLogger(effect, logger), References.MinimumLogLevel, "Debug"),
      Logger.layer([]),
    )
  return { logs, observe }
}

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

async function run(options?: {
  history?: SessionMessage.Info[]
  cap?: number
  storage?: Map<string, unknown>
  eventStream?: Stream.Stream<SessionEvent.Info>
  failContext?: boolean
  failStorage?: boolean
}): Promise<Harness> {
  let beforeHook: BeforeHook | undefined
  let afterHook: AfterHook | undefined
  const asserted: { resources: ReadonlyArray<string> }[] = []
  let interrupts = 0
  let outcome: Outcome = () => Effect.void
  const queue = Effect.runSync(Queue.unbounded<SessionEvent.Info>())
  const storage = options?.storage ?? new Map<string, unknown>()
  const scope = Effect.runSync(Scope.make())
  const capture = makeLogCapture()

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
      context: () =>
        options?.failContext
          ? Effect.fail(new Error("history read failed"))
          : Effect.succeed(options?.history ?? []),
      interrupt: () => {
        interrupts++
        return Effect.void
      },
    },
    storage: {
      get: (key: string) =>
        options?.failStorage ? Effect.fail(new Error("storage read failed")) : Effect.succeed(storage.get(key)),
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
    before: (input) => capture.observe(beforeHook!(input)),
    after: (input) => capture.observe(afterHook!(input)),
    asserted,
    interrupts: () => interrupts,
    setOutcome: (next) => {
      outcome = next
    },
    publish: (event) => Effect.as(Queue.offer(queue, event), undefined),
    logs: capture.logs,
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
    await Effect.runPromise(h.before(beforeEvent("shell", input, "g_1")))
    expect(h.asserted).toHaveLength(1)
    expect(h.asserted[0]?.resources[0]).toContain(":repeat")
  })

  it("challenges the 7th identical output emission of one signature", async () => {
    const h = await run()
    const input = { pattern: "TODO" }
    const out = "src/a.ts:1:TODO\nsrc/b.ts:2:TODO\nsrc/c.ts:3:TODO"
    for (let i = 1; i <= 6; i++) {
      await emit(h, "grep", input, `a_${i}`, text(out))
    }
    expect(h.asserted).toHaveLength(0)
    await Effect.runPromise(Effect.exit(h.before(beforeEvent("grep", input, "a_7"))))
    expect(h.asserted).toHaveLength(1)
  })

  it("resets B and lets the run continue when the circuit ask is allowed", async () => {
    const h = await run()
    const input = { command: "probe" }
    const out = (i: number) => `probe ${i}\nstatic line one\nstatic line two`
    for (let i = 1; i <= 13; i++) {
      await emit(h, "shell", input, `al_${i}`, text(out(i)))
    }
    const exit = await Effect.runPromise(Effect.exit(h.before(beforeEvent("shell", input, "al_14"))))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(h.asserted).toHaveLength(1)
    // The breaker owns its saved resource: allowing B must not exempt the same signature's circuit.
    const sig = DoomLoopDetector.signature("shell", input)
    expect(h.asserted[0]?.resources).toEqual([`shell:${sig}:circuit`])
    const check = h.logs.find((log) => log.message[0] === "doom loop permission check")
    expect(check?.level).toBe("Info")
    expect(check?.message[1]).toMatchObject({ sessionID, tool: "shell", signal: "circuit" })
    const allowed = h.logs.find((log) => log.message[0] === "doom loop permission allowed")
    expect(allowed?.level).toBe("Info")
    expect(allowed?.message[1]).toMatchObject({ sessionID, tool: "shell", signal: "circuit", resource: `shell:${sig}:circuit` })
    expect(h.interrupts()).toBe(0)
  })

  it("makes a denied circuit sticky and does not re-ask on retry", async () => {
    const h = await run()
    const input = { command: "probe" }
    const out = (i: number) => `probe ${i}\nstatic line one\nstatic line two`
    for (let i = 1; i <= 13; i++) {
      await emit(h, "shell", input, `dn_${i}`, text(out(i)))
    }
    h.setOutcome(() => Effect.fail(new Tool.Error({ message: "Permission denied: circuit-secret-value" })))
    await Effect.runPromise(Effect.exit(h.before(beforeEvent("shell", input, "dn_14"))))
    expect(h.asserted).toHaveLength(1)
    const denied = h.logs.find((log) => log.message[0] === "doom loop permission not granted")
    expect(denied?.level).toBe("Warn")
    expect(denied?.message[1]).toMatchObject({ signal: "circuit", error: "Tool.Error" })
    expect((denied?.message[1] as Record<string, unknown>).cause).toBeUndefined()
    await Effect.runPromise(Effect.exit(h.before(beforeEvent("shell", input, "dn_15"))))
    expect(h.asserted).toHaveLength(1)
    const sig = DoomLoopDetector.signature("shell", input)
    const sticky = h.logs.find((log) => log.message[0] === "sticky doom loop circuit blocked the call")
    expect(sticky?.level).toBe("Warn")
    expect(sticky?.message[1]).toMatchObject({
      sessionID,
      tool: "shell",
      signal: "circuit",
      sigHash: sig,
      resource: `shell:${sig}:circuit`,
    })
    // Typed failure text stays out of logs even on the circuit path.
    expect(JSON.stringify(h.logs)).not.toContain("circuit-secret-value")
    expect(h.interrupts()).toBe(2)
  })

  it("returns a host-wrapped CorrectedError as feedback without a sticky stop", async () => {
    const h = await run()
    const input = { command: "probe" }
    const out = (i: number) => `probe ${i}\nstatic line one\nstatic line two`
    for (let i = 1; i <= 13; i++) {
      await emit(h, "shell", input, `ce_${i}`, text(out(i)))
    }
    const feedback = "Use staging instead (corrected-secret-value)"
    h.setOutcome(() =>
      Effect.fail(
        new Tool.Error({
          message: feedback,
          error: { _tag: "Permission.CorrectedError", feedback } as never,
        }),
      ),
    )
    await Effect.runPromise(Effect.exit(h.before(beforeEvent("shell", input, "ce_14"))))
    const denied = h.logs.find((log) => log.message[0] === "doom loop permission not granted")
    expect(denied?.level).toBe("Warn")
    expect(denied?.message[1]).toMatchObject({ signal: "circuit", error: "Permission.CorrectedError" })
    expect((denied?.message[1] as Record<string, unknown>).cause).toBeUndefined()
    expect(h.logs.some((log) => log.message[0] === "sticky doom loop circuit blocked the call")).toBe(false)
    expect(JSON.stringify(h.logs)).not.toContain("corrected-secret-value")
    expect(h.interrupts()).toBe(0)
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
    await Effect.runPromise(Effect.exit(h.before(beforeEvent("grep", input, "a_7"))))
    expect(h.asserted).toHaveLength(1)
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

  it("degrades to a fresh state without throwing when the history read fails", async () => {
    const h = await run({ failContext: true })
    const exit = await Effect.runPromise(Effect.exit(h.before(beforeEvent("grep", { pattern: "TODO" }, "hf_1"))))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(h.asserted).toHaveLength(0)
  })

  it("degrades to a fresh state without throwing when the KV circuit read fails", async () => {
    const input = { pattern: "TODO", path: "src" }
    const out = "src/a.ts:1:TODO\nsrc/b.ts:2:TODO\nsrc/c.ts:3:TODO"
    const history = Array.from({ length: 6 }, (_, i) => makeHistoryCall(`kf_${i}`, "grep", input, out))
    // The history is readable, but losing the fold must also discard its A streak, so the 7th
    // emission passes instead of asking. A failed read must not fail the tool call.
    const h = await run({ history, failStorage: true })
    const exit = await Effect.runPromise(Effect.exit(h.before(beforeEvent("grep", input, "kf_7"))))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(h.asserted).toHaveLength(0)
  })

  it("degrades to a fresh state without throwing when the fold hits a defect", async () => {
    // null content makes DoomLoopFold.fold throw a TypeError while iterating the message.
    const broken = [{ type: "assistant", content: null }] as unknown as SessionMessage.Info[]
    const h = await run({ history: broken })
    const exit = await Effect.runPromise(Effect.exit(h.before(beforeEvent("grep", { pattern: "TODO" }, "df_1"))))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(h.asserted).toHaveLength(0)
  })

  describe("intervention logging", () => {
    const fieldsOf = (h: Harness, message: string) =>
      h.logs.filter((log) => log.message[0] === message).map((log) => log.message[1] as Record<string, unknown>)
    const levelOf = (h: Harness, message: string) =>
      h.logs.find((log) => log.message[0] === message)?.level
    const guardAsk = async (h: Harness, tool: string, input: unknown, messageID: string) => {
      for (let i = 0; i < 2; i++) {
        await Effect.runPromise(Effect.exit(h.before(beforeEvent(tool, input, messageID))))
      }
      return Effect.runPromise(Effect.exit(h.before(beforeEvent(tool, input, messageID))))
    }

    it("logs structured trigger fields and never the tool input", async () => {
      const h = await run()
      const input = { command: "deploy --token super-secret-value" }
      const sig = DoomLoopDetector.signature("shell", input)
      const exit = await guardAsk(h, "shell", input, "log_trigger")
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(fieldsOf(h, "doom loop permission check")).toEqual([
        {
          sessionID,
          tool: "shell",
          signal: "guard",
          sigHash: sig,
          resource: `shell:${sig}:repeat`,
        },
      ])
      expect(levelOf(h, "doom loop permission check")).toBe("Info")
      // Pass calls and soft warnings are not logged; no command text is either.
      expect(h.logs).toHaveLength(2)
      expect(JSON.stringify(h.logs)).not.toContain("super-secret-value")
      expect(JSON.stringify(h.logs)).not.toContain("deploy --token")
    })

    it("logs an allowed permission result without claiming once or always", async () => {
      const h = await run()
      const input = { pattern: "TODO" }
      const exit = await guardAsk(h, "grep", input, "log_allowed")
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(levelOf(h, "doom loop permission allowed")).toBe("Info")
      expect(fieldsOf(h, "doom loop permission allowed")).toEqual([
        {
          sessionID,
          tool: "grep",
          signal: "guard",
          sigHash: DoomLoopDetector.signature("grep", input),
          resource: `grep:${DoomLoopDetector.signature("grep", input)}:repeat`,
        },
      ])
    })

    it("logs a typed rejection as WARN without its free text and preserves the hook failure", async () => {
      const h = await run()
      h.setOutcome(() => Effect.fail(new Tool.Error({ message: "Permission denied: typed-secret-value" })))
      const input = { command: "git status" }
      const exit = await guardAsk(h, "shell", input, "log_denied")
      expect(Exit.isFailure(exit)).toBe(true)
      const error = Option.getOrUndefined(Exit.findErrorOption(exit))
      expect(error).toBeInstanceOf(Tool.Error)
      expect(error instanceof Tool.Error ? error.metadata : undefined).toEqual({ doom_loop: "blocked" })
      expect(levelOf(h, "doom loop permission not granted")).toBe("Warn")
      const fields = fieldsOf(h, "doom loop permission not granted")[0]
      expect(fields?.error).toBe("Tool.Error")
      expect(fields?.cause).toBeUndefined()
      expect(JSON.stringify(h.logs)).not.toContain("typed-secret-value")
    })

    it("logs an interruption at debug level and preserves the interrupted Exit", async () => {
      const h = await run()
      h.setOutcome(() => Effect.interrupt)
      const input = { command: "git status" }
      const exit = await guardAsk(h, "shell", input, "log_interrupt")
      expect(Exit.isSuccess(exit)).toBe(false)
      const cause = Exit.isFailure(exit) ? exit.cause : undefined
      expect(cause !== undefined && Cause.hasInterrupts(cause)).toBe(true)
      expect(levelOf(h, "doom loop permission interrupted")).toBe("Debug")
      const fields = fieldsOf(h, "doom loop permission interrupted")[0]
      expect(fields).toMatchObject({ sessionID, tool: "shell", signal: "guard" })
      expect(fields?.cause).toBeUndefined()
      expect(levelOf(h, "doom loop permission not granted")).toBeUndefined()
    })

    it("logs a plain rejection defect as WARN without converting it to a typed error", async () => {
      const h = await run()
      h.setOutcome(() => Effect.die(new Error("permission transport exploded")))
      const input = { command: "git status" }
      const exit = await guardAsk(h, "shell", input, "log_defect")
      // The defect is observed, not swallowed or replaced by a Tool.Error.
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Option.isNone(Exit.findErrorOption(exit))).toBe(true)
      expect(levelOf(h, "doom loop permission not granted")).toBe("Warn")
      expect(String(fieldsOf(h, "doom loop permission not granted")[0]?.cause)).toContain(
        "permission transport exploded",
      )
    })

    it("logs a circuit defect as WARN and keeps the existing sticky behavior", async () => {
      const h = await run()
      const input = { command: "probe" }
      const out = (i: number) => `probe ${i}\nstatic line one\nstatic line two`
      for (let i = 1; i <= 13; i++) await emit(h, "shell", input, `cdf_${i}`, text(out(i)))
      h.setOutcome(() => Effect.die(new Error("circuit transport exploded")))
      await Effect.runPromise(Effect.exit(h.before(beforeEvent("shell", input, "cdf_14"))))
      expect(h.interrupts()).toBe(1)
      const warned = fieldsOf(h, "doom loop permission not granted")[0]
      expect(levelOf(h, "doom loop permission not granted")).toBe("Warn")
      expect(warned?.error).toBeUndefined()
      expect(String(warned?.cause)).toContain("circuit transport exploded")
      // The defect still follows the existing sticky path; the next call does not re-ask.
      await Effect.runPromise(Effect.exit(h.before(beforeEvent("shell", input, "cdf_15"))))
      expect(h.asserted).toHaveLength(1)
      expect(levelOf(h, "sticky doom loop circuit blocked the call")).toBe("Warn")
    })

    it("logs a circuit interruption at debug level without changing the existing stop", async () => {
      const h = await run()
      const input = { command: "probe" }
      const out = (i: number) => `probe ${i}\nstatic line one\nstatic line two`
      for (let i = 1; i <= 13; i++) await emit(h, "shell", input, `cint_${i}`, text(out(i)))
      h.setOutcome(() => Effect.interrupt)
      const exit = await Effect.runPromise(Effect.exit(h.before(beforeEvent("shell", input, "cint_14"))))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(levelOf(h, "doom loop permission interrupted")).toBe("Debug")
      expect(levelOf(h, "doom loop permission not granted")).toBeUndefined()
      // Existing circuit handling still treats an interrupted ask as a stop and interrupts.
      expect(h.interrupts()).toBe(1)
    })
  })
})
