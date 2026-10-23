export * as ModelPool from "./model-pool.js"

import { Option, Schema, SchemaGetter } from "effect"
import { Model } from "./model.js"

/**
 * How a collaboration pool participates in a session.
 *
 * - `off`: the pool is only a fallback chain.
 * - `on-demand`: peer models answer only when the primary model asks for them.
 * - `auto`: peer models answer every user turn in parallel, and the primary
 *   model synthesizes their answers into the final response.
 */
export const Mode = Schema.Literals(["off", "on-demand", "auto"])
export type Mode = typeof Mode.Type

/** A pool needs at least two models to collaborate and at most five to stay reviewable. */
export const MIN_MODELS = 2
export const MAX_MODELS = 5

/** The short form only matches strings that carry a provider, a model and an optional variant. */
const Short = Schema.String.check(Schema.isPattern(/^[^/#]+\/[^#]+(?:#[^#]+)?$/u))

/** Accepts the short `"provider/model#variant"` form alongside the explicit object form. */
export const Selection = Schema.Union([Short, Model.Ref]).pipe(
  Schema.decodeTo(Model.Ref, {
    decode: SchemaGetter.transform((input) => (typeof input === "string" ? Model.Ref.parse(input) : input)),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
)
export type Selection = typeof Selection.Type

/**
 * An ordered set of models that work on the same task. The first entry is the
 * preferred model; the remaining entries are its fallback chain and, in
 * collaboration modes, its peers.
 */
export const Pool = Schema.Struct({
  models: Schema.Array(Selection),
  mode: Mode,
})
export type Pool = typeof Pool.Type

export const decode = (input: unknown): Pool | undefined => {
  if (!input || typeof input !== "object") return undefined
  const raw = input as { models?: unknown; mode?: unknown }
  if (!Array.isArray(raw.models)) return undefined
  const models = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Array(Selection))(raw.models))
  if (!models) return undefined
  // An unknown mode is not a reason to drop the pool: the models still work as a fallback chain.
  const mode: Mode = raw.mode === "auto" || raw.mode === "on-demand" ? raw.mode : "off"
  return { models, mode }
}

/** Whether a decoded pool holds a usable number of models. */
export const valid = (pool: Pool) => pool.models.length >= MIN_MODELS && pool.models.length <= MAX_MODELS

/** Two references address the same model when provider, id and variant all match. */
export const same = (left: Model.Ref, right: Model.Ref) =>
  left.providerID === right.providerID &&
  left.id === right.id &&
  (left.variant ?? "default") === (right.variant ?? "default")

/** Index of `ref` inside `models`, or -1 when the model is not part of the pool. */
export const indexOf = (models: ReadonlyArray<Model.Ref>, ref: Model.Ref) =>
  models.findIndex((model) => same(model, ref))

/**
 * The models that follow `ref` in the pool, in order. The chain starts after the
 * active model, so a fallback never returns to a model that just failed, and it
 * never wraps around: the last entry is the end of the chain.
 */
export const chain = (models: ReadonlyArray<Model.Ref>, ref: Model.Ref) => {
  const index = indexOf(models, ref)
  if (index === -1) return models.slice()
  return models.slice(index + 1)
}

/** The pool members that are not the active model: the collaborators. */
export const peers = (models: ReadonlyArray<Model.Ref>, ref: Model.Ref) =>
  models.filter((model) => !same(model, ref))
