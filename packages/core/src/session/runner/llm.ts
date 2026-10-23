export * as SessionRunnerLLM from "./llm.js"

import { Message } from "@opencode/ai"
import { ModelPool } from "@opencode/schema/model-pool"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { Cause, Effect, Exit, FiberMap, Layer } from "effect"
import { Database } from "../../database/database.js"
import { Bus } from "../../bus.js"
import { LocationLifecycle } from "../../location-lifecycle.js"
import { InstructionState } from "../instruction-state.js"
import { SessionCollaboration } from "../collaboration.js"
import { SessionCompaction } from "../compaction.js"
import { SessionContext } from "../context.js"
import { SessionEvent } from "../event.js"
import { SessionInbox } from "../inbox.js"
import { SessionHistory } from "../history.js"
import { SessionModelPool } from "../model-pool.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionModelTransport } from "../model-transport.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"
import { SessionStore } from "../store.js"
import { SessionMessageTable } from "../sql.js"
import { SessionTitle } from "../title.js"
import { toSessionError } from "../to-session-error.js"
import { DrainResult, Service, type Interface } from "./index.js"
import { Snapshot } from "../../snapshot.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { llmClient } from "../../effect/app-node-platform.js"
import { StepFailedError } from "../error.js"
import { SessionRunnerRetry } from "./retry.js"
import { SessionRunnerModel } from "./model.js"
import { SessionStep } from "./step.js"
import { ToolOutput } from "../../tool-output.js"
import { Plugin } from "../../plugin.js"
import { MAX_STEPS_PROMPT } from "./max-steps.js"

const CONTINUE_AFTER_INCOMPLETE_STREAM =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."

const CONTINUE_AFTER_OUTPUT_LIMIT =
  "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces."

/**
 * Failures that mean the model itself is out of capacity: its quota is spent, its
 * rate limit is reached, or it cannot finish a single answer within its output
 * limit. These are the failures another model in the pool can take over from.
 */
const TAKEOVER_ERRORS = new Set(["provider.rate-limit", "provider.quota", "provider.free-limit", "output-limit"])

/** The text of the most recent user message, which is what the pool is asked about. */
const latestUserMessage = (messages: ReadonlyArray<SessionMessage.Info>) => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.type !== "user") continue
    if (message.text.trim() === "") continue
    return message.text
  }
  return undefined
}


const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const lifecycle = yield* LocationLifecycle.Service
    const store = yield* SessionStore.Service
    const context = yield* SessionContext.Service
    const modelTransport = yield* SessionModelTransport.Service
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const plugins = yield* Plugin.Service
    const title = yield* SessionTitle.Service
    const steps = yield* SessionStep.make
    const pools = yield* SessionModelPool.Service
    // Title generation starts once input is visible and must not delay model execution.
    const titles = yield* FiberMap.make<SessionSchema.ID, void, never>()

    const drain = Effect.fn("SessionRunner.drain")(function* (input: Parameters<Interface["drain"]>[0]) {
      const sessionID = input.sessionID
      let force = input.force
      let continuing = input.continuation !== undefined
      let step = input.continuation?.step ?? 1
      let entering = true
      const promotable = input.promotable ?? "input"
      if (!force && !continuing) {
        const pending = yield* SessionInbox.nextPromotable(db, sessionID, "input")
        if (!pending) return DrainResult.Complete()
        const control = pending.type === "compaction" || pending.type === "move"
        if (promotable === "steer" && pending.delivery === "queue" && !control) return DrainResult.Complete()
      }
      yield* plugins.awaitActivation
      yield* settleStaleCompactions(sessionID)
      yield* settleStaleToolCalls(sessionID)

      const advanceToStep = Effect.fn("SessionRunner.advanceToStep")(() =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            while (true) {
              if (lifecycle.isClosed()) {
                yield* restore(modelTransport.close(sessionID))
                return DrainResult.Reloaded({ force, continuation: continuing ? { step } : undefined })
              }
              // Location entry and idle boundaries allow queued controls, not necessarily queued prompts.
              const pending = yield* SessionInbox.serialized(
                sessionID,
                Effect.gen(function* () {
                  const next = yield* SessionInbox.nextPromotable(
                    db,
                    sessionID,
                    entering || !continuing ? "input" : "steer",
                  )
                  if (next?.type === "compaction")
                    yield* bus.publishAll([
                      [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                      [SessionEvent.Compaction.Started, { sessionID, reason: "manual", inputID: next.id }],
                    ])
                  if (next?.type === "move")
                    yield* restore(
                      Effect.gen(function* () {
                        yield* modelTransport.close(sessionID)
                        yield* bus.publishAll([
                          [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                          [SessionEvent.Moved, { sessionID, ...next.payload }],
                        ])
                      }),
                    )
                  return next
                }),
              )
              if (!continuing && pending?.delivery !== "steer") {
                entering = true
                step = 1
              }
              if (pending?.type === "move")
                return DrainResult.Moved({ continuation: continuing ? { step } : undefined })
              if (pending?.type === "compaction") {
                const compacted = yield* restore(
                  Effect.gen(function* () {
                    const selected = yield* context.select(sessionID)
                    const model = yield* context.resolveModel(selected.session)
                    // Preview updates without admitting them after the already-delivered compaction marker.
                    const history = yield* SessionHistory.preview(db, sessionID, selected.instructions, model.ref)
                    return yield* compaction.compact({
                      reason: "manual",
                      inputID: pending.id,
                      context: {
                        session: selected.session,
                        agent: selected.agent,
                        tools: selected.tools,
                        model,
                        initial: history.initial,
                        messages: history.messages,
                      },
                    })
                  }).pipe(
                    Effect.catch((error) =>
                      bus.publish(SessionEvent.Compaction.Failed, {
                        sessionID,
                        reason: "manual",
                        inputID: pending.id,
                        error: toSessionError(error),
                      }),
                    ),
                  ),
                ).pipe(Effect.exit)
                if (Exit.isFailure(compacted)) {
                  yield* bus.publish(SessionEvent.Compaction.Failed, {
                    sessionID,
                    reason: "manual",
                    error: Cause.hasInterruptsOnly(compacted.cause)
                      ? { type: "aborted", message: "Compaction cancelled" }
                      : { type: "compaction.failed", message: Cause.pretty(compacted.cause) },
                    inputID: pending.id,
                  })
                  return yield* Effect.failCause(compacted.cause)
                }
                force = false
                continue
              }
              if (!force && !continuing && (!pending || (pending.delivery === "queue" && promotable === "steer")))
                return DrainResult.Complete()
              const ready = yield* restore(
                Effect.gen(function* () {
                  const selected = yield* prepareContext(sessionID)
                  const promoted = yield* SessionInbox.promote(
                    db,
                    bus,
                    sessionID,
                    entering && !continuing ? promotable : "steer",
                  )
                  // A control admitted during context preparation owns this boundary.
                  if (promoted === undefined) return undefined
                  if (promoted > 0 && !selected.session.parentID && SessionTitle.isUntitled(selected.session))
                    yield* FiberMap.run(titles, sessionID, title.generate(sessionID), {
                      onlyIfMissing: true,
                    })
                  if (promoted > 0) step = 1
                  return { _tag: "Ready" as const, context: yield* context.load(selected) }
                }),
              )
              if (ready) return ready
            }
          }),
        ),
      )

      while (true) {
        const next = yield* advanceToStep()
        if (next._tag !== "Ready") return next
        continuing = yield* runStep(next.context, step)
        step++
        force = false
        entering = false
      }
    })

    const prepareContext = Effect.fn("SessionRunner.prepareContext")(function* (sessionID: SessionSchema.ID) {
      const selected = yield* context.select(sessionID)
      // A blocked initial instruction baseline must leave admitted input pending.
      yield* InstructionState.prepare(db, bus, selected.instructions, sessionID)
      return selected
    })

    /**
     * The next model in the collaboration pool that can take the step over.
     *
     * Only failures that mean the model itself is out of capacity qualify: a
     * rate limit, a spent quota or an exhausted output limit. The switch is
     * durable, so the session keeps running on the new model and the user sees
     * which model is answering.
     */
    const takeOver = Effect.fn("SessionRunner.takeOver")(function* (
      loaded: SessionContext.Loaded,
      error: { readonly type: string } | undefined,
    ) {
      if (error && !TAKEOVER_ERRORS.has(error.type)) return undefined
      const chain = yield* pools.chain(loaded.session, loaded.model.ref)
      const next = chain[0]
      if (!next) return undefined
      yield* Effect.logInfo("switching model after the active model ran out of capacity", {
        sessionID: loaded.session.id,
        from: `${loaded.model.ref.providerID}/${loaded.model.ref.id}`,
        to: `${next.ref.providerID}/${next.ref.id}`,
        reason: error?.type,
      })
      yield* bus.publish(SessionEvent.ModelSelected, {
        sessionID: loaded.session.id,
        model: next.ref,
        previous: loaded.model.ref,
      })
      return next
    })

    /**
     * Asks the other models of the pool for an answer, in parallel.
     *
     * Only the first step of a turn consults the pool, so a tool loop does not
     * pay for the same answers twice. The answers are handed to the primary
     * model, which merges them into the response the user sees.
     */
    const consultPeers = Effect.fn("SessionRunner.consultPeers")(function* (loaded: SessionContext.Loaded) {
      const pool = yield* pools.pool(loaded.session)
      if (!pool || pool.mode !== "auto") return undefined
      const peers = yield* pools.peers(loaded.session, loaded.model.ref)
      if (peers.length === 0) return undefined
      const question = latestUserMessage(loaded.messages)
      if (question === undefined) return undefined
      yield* Effect.logInfo("consulting the collaboration pool", {
        sessionID: loaded.session.id,
        models: peers.map((peer) => `${peer.ref.providerID}/${peer.ref.id}`),
      })
      const answers = yield* SessionCollaboration.ask({ models: peers, prompt: question })
      const usable = answers.filter((answer) => answer.text !== undefined)
      if (usable.length === 0) return undefined
      const advice = SessionCollaboration.advice(answers)
      // The peer answers are part of the record, so the user can see which
      // models took part in the answer.
      yield* bus.publish(SessionEvent.Synthetic, { sessionID: loaded.session.id, text: advice })
      return advice
    })

    /** Owns logical Step policy; each attempt owns its streaming, tools, and durable settlement. */
    const runStep = Effect.fn("SessionRunner.runStep")(function* (first: SessionContext.Loaded, step: number) {
      const sessionID = first.session.id
      let assistantMessageID = SessionMessage.ID.create()
      const retry = yield* SessionRunnerRetry.make(bus, sessionID)
      let initial: SessionContext.Loaded | undefined = first
      let recoverOverflow = true
      let recoverContinuation = true
      // The model that takes the step over when the active one runs out of capacity.
      let takeover: SessionRunnerModel.Resolved | undefined
      // The model that ran out of capacity, so a later session model change can be told apart from it.
      let exhaustedModel: SessionRunnerModel.Resolved | undefined
      while (true) {
        // Reuse boundary preparation once; retries refresh context without delivering more input.
        const loaded = initial ?? (yield* prepareContext(sessionID).pipe(Effect.flatMap(context.load)))
        initial = undefined
        // A takeover replaces the session model for the rest of this step. A session model that
        // changed to something else was picked by the user, so it wins over the takeover.
        if (
          takeover &&
          !ModelPool.same(takeover.ref, loaded.model.ref) &&
          !(exhaustedModel && ModelPool.same(exhaustedModel.ref, loaded.model.ref))
        )
          takeover = undefined
        const active = takeover ?? loaded.model
        const current = active === loaded.model ? loaded : { ...loaded, model: active }
        const compacted = yield* compaction.compact({ reason: "auto", context: current })
        if (compacted.status === "failed") return yield* new StepFailedError({ error: compacted.error })
        if (compacted.status === "completed") {
          assistantMessageID = SessionMessage.ID.create()
          continue
        }
        const stepLimitReached = current.agent.info.steps !== undefined && step >= current.agent.info.steps
        const transcript = SessionModelRequest.baseTranscript({
          agent: current.agent.info,
          model: current.model,
          tools: current.tools,
          initial: current.initial,
          messages: current.messages,
        })
        // The pool answers in parallel on the first step of a turn; the primary model merges their answers.
        const advice = step === 1 ? yield* consultPeers(current) : undefined
        const messages = advice
          ? [...transcript.messages, Message.user(advice)]
          : stepLimitReached
            ? [...transcript.messages, Message.assistant(MAX_STEPS_PROMPT)]
            : transcript.messages
        const prepared = yield* context.request.primary({
          session: current.session,
          agent: current.agent.id,
          model: current.model,
          tools: current.tools,
          system: transcript.system,
          messages: stepLimitReached ? [...messages, Message.assistant(MAX_STEPS_PROMPT)] : messages,
          // Keep tool definitions on the final Step to preserve the provider's cached prefix.
          toolChoice: stepLimitReached ? "none" : undefined,
          webSocket: "session",
          inputTokens: SessionCompaction.estimatePrompt(current),
        })
        const outcome = yield* steps.attempt({
          isLocationClosed: lifecycle.isClosed,
          sessionID,
          assistantMessageID,
          agent: current.agent.id,
          model: current.model,
          prepared,
          retry: (cause, error, proposed) =>
            retry.decide({
              cause,
              error,
              agent: current.agent.id,
              model: current.model.ref,
              hook: prepared.retry,
              retry: proposed,
            }),
          recoverContinuation,
          recoverOverflow: Effect.suspend(() =>
            recoverOverflow
              ? compaction
                  .compact({ reason: "overflow", context: current })
                  .pipe(Effect.map((result) => result.status === "completed"))
              : Effect.succeed(false),
          ),
        })
        const completed = yield* SessionStep.Outcome.$match(outcome, {
          Completed: (outcome) => Effect.succeed(outcome.needsContinuation),
          Retry: Effect.fnUntraced(function* (outcome) {
            // A model that ran out of capacity hands the step to the next model in the pool
            // instead of burning the remaining quota on retries of the same model.
            const next = yield* takeOver(current, outcome.error)
            if (next) {
              takeover = next
              exhausted = current.model
              assistantMessageID = SessionMessage.ID.create()
              return
            }
            yield* retry.wait({
              decision: outcome.decision,
              error: outcome.error,
              assistantMessageID,
            })
          }),
          Continue: Effect.fnUntraced(function* (outcome) {
            const next = yield* takeOver(current, outcome.error)
            if (next) {
              takeover = next
              exhausted = current.model
              assistantMessageID = SessionMessage.ID.create()
              return
            }
            yield* retry.wait({
              decision: outcome.decision,
              error: outcome.error,
              assistantMessageID,
            })
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_INCOMPLETE_STREAM })
            assistantMessageID = SessionMessage.ID.create()
          }),
          OutputLimit: Effect.fn("SessionRunner.continueOutputLimit")(function* (outcome) {
            // The current response is included. User input or any other finish breaks the streak.
            const rows = yield* db
              .select()
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.session_id, sessionID),
                  inArray(SessionMessageTable.type, ["user", "assistant"]),
                ),
              )
              .orderBy(desc(SessionMessageTable.seq))
              .limit(3)
              .all()
              .pipe(Effect.orDie)
            const recent = yield* Effect.forEach(rows, SessionHistory.decodeMessageRow)
            const exhausted =
              recent.length === 3 &&
              recent.every((message) => message.type === "assistant" && message.finish === "length")
            if (exhausted) {
              // A model that cannot finish one answer hands over before the step fails.
              const next = yield* takeOver(current, { type: "output-limit", message: "Output token limit reached" })
              if (next) {
                takeover = next
                exhaustedModel = current.model
                assistantMessageID = SessionMessage.ID.create()
                return
              }
              return yield* new StepFailedError({
                error: {
                  type: "output-limit",
                  message: "Response still truncated after two output token limit continuations",
                },
              })
            }
            if (outcome.needsContinuation) return true
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_OUTPUT_LIMIT })
            assistantMessageID = SessionMessage.ID.create()
          }),
          Compacted: Effect.fnUntraced(function* () {
            recoverOverflow = false
            assistantMessageID = SessionMessage.ID.create()
          }),
          RecoverFull: Effect.fnUntraced(function* () {
            recoverContinuation = false
          }),
        })
        if (completed !== undefined) return completed
      }
    })

    const settleStaleCompactions = Effect.fn("SessionRunner.settleStaleCompactions")(function* (
      sessionID: SessionSchema.ID,
    ) {
      // A process death skips compaction finalizers. Include orphans behind a
      // completed checkpoint, and settle newest first to match event projection.
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "compaction"),
            sql`json_extract(${SessionMessageTable.data}, '$.status') = 'running'`,
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        const message = yield* SessionHistory.decodeMessageRow(row)
        if (message.type !== "compaction") continue
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason: message.reason,
          inputID: message.id,
          error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
        })
      }
    })

    const settleStaleToolCalls = Effect.fn("SessionRunner.settleStaleToolCalls")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* store.context(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "streaming" && tool.state.status !== "running")) continue
          const metadata = tool.state.status === "running" ? tool.state.metadata : undefined
          const childID =
            tool.name === "subagent" && typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined
          yield* bus.publish(SessionEvent.Tool.Failed, {
            sessionID,
            assistantMessageID: message.id,
            id: tool.id,
            error: {
              type: "aborted",
              message: `Tool execution interrupted: ${tool.name}${childID ? ` (sessionID: ${childID})` : ""}`,
            },
            ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
            executed: tool.executed === true,
          })
        }
      }
    })

    return Service.of({ drain })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    LocationLifecycle.node,
    llmClient,
    SessionContext.node,
    SessionModelTransport.node,
    SessionStore.node,
    SessionCompaction.node,
    Plugin.node,
    SessionTitle.node,
    Snapshot.node,
    ToolOutput.node,
    Database.node,
    SessionModelPool.node,
  ],
})
