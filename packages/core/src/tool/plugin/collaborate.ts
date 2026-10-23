export * as CollaborateTool from "./collaborate.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Model } from "../../model.js"
import { ModelPool } from "@opencode/schema/model-pool"
import { Session } from "../../session.js"
import { SessionCollaboration } from "../../session/collaboration.js"
import { SessionModelPool } from "../../session/model-pool.js"

export const name = "collaborate"

export const Input = Schema.Struct({
  prompt: Schema.String.annotate({
    description:
      "The question or task the other models should answer. Be specific: they answer independently, without your conversation.",
  }),
  models: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      'Which models to ask, as "providerID/modelID" or "providerID/modelID#variant". Defaults to every other model in the collaboration pool.',
  }),
  instruction: Schema.optionalKey(Schema.String).annotate({
    description: "Extra guidance for the other models, such as the angle you want them to take.",
  }),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  answers: Schema.Array(
    Schema.Struct({
      model: Schema.String,
      text: Schema.String,
    }),
  ),
})
export type Output = typeof Output.Type

export const description = [
  "Asks other AI models for their answer to the same question, all at once, and returns their answers to you.",
  "Use it to work with models that are stronger at different things, to get a second opinion, or to check your own reasoning.",
  "The models answer independently and in parallel, so this is much faster than asking them one after another.",
  "You then merge their answers with your own into one final answer for the user.",
  "It only works when the session has a collaboration pool of two to five models configured.",
].join(" ")

export const Plugin = {
  id: "opencode.tool.collaborate",
  effect: Effect.fn("CollaborateTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const pools = yield* SessionModelPool.Service

    yield* ctx.tool.transform((editor) => {
      editor.add({
        name,
        options: { codemode: false },
        description,
        input: Input,
        output: Output,
        execute: (input, context) =>
          Effect.gen(function* () {
            const session = yield* sessions.get(context.sessionID).pipe(
              Effect.mapError(
                (error) => new ToolFailure({ message: `Session not found: ${context.sessionID}`, error }),
              ),
            )
            const pool = yield* pools.pool(session)
            if (!pool)
              return yield* new ToolFailure({
                message:
                  "No collaboration pool is configured for this session. Ask the user to pick two to five models for the pool first.",
              })

            const requested = (input.models ?? []).map((value) => {
              try {
                return Model.Ref.parse(value)
              } catch {
                return undefined
              }
            })
            if (requested.some((ref) => ref === undefined))
              return yield* new ToolFailure({
                message: 'Invalid model reference. Use "providerID/modelID" or "providerID/modelID#variant".',
              })

            const refs = (requested.filter((ref) => ref !== undefined) as ReadonlyArray<Model.Ref>).length > 0
              ? (requested.filter((ref) => ref !== undefined) as ReadonlyArray<Model.Ref>)
              : pool.models.filter((ref) => !ModelPool.same(ref, session.model ?? pool.models[0]))

            if (refs.length === 0)
              return yield* new ToolFailure({
                message: "There is no other model in the collaboration pool to ask.",
              })

            const resolved = yield* Effect.forEach(refs, (ref) => pools.resolve(session, ref))
            const targets = resolved.filter((model) => model !== undefined)
            if (targets.length === 0)
              return yield* new ToolFailure({
                message: "None of the requested models are available. Check that they are connected.",
              })

            const prompt = input.instruction
              ? `${input.prompt}\n\nAdditional guidance: ${input.instruction}`
              : input.prompt
            const answers = yield* SessionCollaboration.ask({ models: targets, prompt })
            const usable = answers.filter((answer) => answer.text !== undefined)
            if (usable.length === 0)
              return yield* new ToolFailure({
                message: "The other models did not return an answer.",
              })

            const output = {
              answers: usable.map((answer) => ({
                model: SessionCollaboration.label(answer.model),
                text: answer.text as string,
              })),
            }
            return {
              output,
              content: SessionCollaboration.format(usable),
              metadata: output,
            }
          }),
      })
    })
  }),
}
