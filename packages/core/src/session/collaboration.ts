export * as SessionCollaboration from "./collaboration.js"

import { LLM, LLMClient, Message, SystemPart } from "@opencode/ai"
import { Effect } from "effect"
import type { SessionRunnerModel } from "./runner/model.js"

/** The instructions a peer model receives when the pool asks it for an answer. */
export const PEER_SYSTEM = [
  "You are one of several AI models collaborating on the same task.",
  "Answer the request independently, on your own reasoning, without referring to the other models.",
  "Be concrete and complete: give the actual answer, not a plan to produce one later.",
  "Your answer is handed to another model, which merges it with the other answers into the final response.",
].join(" ")

export interface Answer {
  readonly model: SessionRunnerModel.Resolved
  readonly text: string | undefined
  readonly error: string | undefined
}

/**
 * Asks every model for an answer to the same prompt, all at once.
 *
 * The models run concurrently, so the wall-clock cost is that of the slowest
 * model rather than their sum. A model that fails does not stop the others: its
 * failure is reported alongside the answers that did arrive.
 */
export const ask = Effect.fn("SessionCollaboration.ask")(function* (input: {
  readonly models: ReadonlyArray<SessionRunnerModel.Resolved>
  readonly prompt: string
}) {
  const llm = yield* LLMClient.Service
  return yield* Effect.forEach(
    input.models,
    (model) =>
      Effect.gen(function* () {
        const request = LLM.request({
          model: model.model,
          system: [SystemPart.make(PEER_SYSTEM)],
          messages: [Message.user(input.prompt)],
        })
        const response = yield* llm.generate(request, {})
        const text = response.text.trim()
        return { model, text: text === "" ? undefined : text, error: undefined } satisfies Answer
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            model,
            text: undefined,
            error: error instanceof Error ? error.message : String(error),
          } satisfies Answer),
        ),
      ),
    { concurrency: "unbounded" },
  )
})

/** Renders the peer answers as the block handed to the primary model. */
export const format = (answers: ReadonlyArray<Answer>) =>
  answers
    .map((answer) => {
      const name = `${answer.model.ref.providerID}/${answer.model.ref.id}`
      if (answer.text !== undefined) return `### ${name}\n${answer.text}`
      return `### ${name}\n(no answer: ${answer.error ?? "unknown error"})`
    })
    .join("\n\n")

/** The message the primary model receives when the pool answered in parallel. */
export const advice = (answers: ReadonlyArray<Answer>) =>
  [
    "Other models in your collaboration pool answered the same request independently.",
    "Use their answers, correct anything they got wrong, and give the user one final answer.",
    "Do not mention that other models were consulted unless the user asked for it.",
    "",
    format(answers),
  ].join("\n")

/** The label a peer answer is filed under in the transcript and in tool output. */
export const label = (model: SessionRunnerModel.Resolved) => `${model.ref.providerID}/${model.ref.id}`
