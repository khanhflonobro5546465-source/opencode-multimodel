export * as SessionModelPool from "./model-pool.js"

import { ModelPool } from "@opencode/schema/model-pool"
import { Model } from "@opencode/schema/model"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Config } from "../config.js"
import { Model as ModelService } from "../model.js"
import { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"

/** Session metadata key that stores a per-session collaboration pool. */
export const METADATA_KEY = "model_pool"

export interface Interface {
  /** The pool that applies to a session: its own override, else the configured default. */
  readonly pool: (session: SessionSchema.Info) => Effect.Effect<ModelPool.Pool | undefined>
  /** Resolves one pool entry into a runnable model, or nothing when it is unavailable. */
  readonly resolve: (
    session: SessionSchema.Info,
    ref: Model.Ref,
  ) => Effect.Effect<SessionRunnerModel.Resolved | undefined>
  /** The models that follow the active one, ready to take over when it runs out. */
  readonly chain: (
    session: SessionSchema.Info,
    active: Model.Ref,
  ) => Effect.Effect<ReadonlyArray<SessionRunnerModel.Resolved>>
  /** The pool members that are not the active model: the collaborators. */
  readonly peers: (
    session: SessionSchema.Info,
    active: Model.Ref,
  ) => Effect.Effect<ReadonlyArray<SessionRunnerModel.Resolved>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionModelPool") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const models = yield* ModelService.Service
    const runner = yield* SessionRunnerModel.Service

    const available = () => models.available()

    const pool = Effect.fn("SessionModelPool.pool")(function* (session: SessionSchema.Info) {
      const override = session.metadata?.[METADATA_KEY]
      if (override !== undefined) {
        const decoded = ModelPool.decode(override)
        if (decoded && ModelPool.valid(decoded)) return decoded
      }
      const entries = yield* config.entries()
      const configured = Config.latest(entries, "model_pool")
      if (!configured) return undefined
      return ModelPool.valid(configured) ? configured : undefined
    })

    const resolve = Effect.fn("SessionModelPool.resolve")(function* (
      session: SessionSchema.Info,
      ref: Model.Ref,
    ) {
      // Resolution reuses the session model path, so a pool entry gets the same
      // availability checks, variant handling and provider setup as a normal model.
      return yield* runner.resolve({ ...session, model: ref }, available).pipe(Effect.catch(() => undefined))
    })

    const chain = Effect.fn("SessionModelPool.chain")(function* (
      session: SessionSchema.Info,
      active: Model.Ref,
    ) {
      const current = yield* pool(session)
      if (!current) return []
      const refs = ModelPool.chain(current.models, active)
      const resolved = yield* Effect.forEach(refs, (ref) => resolve(session, ref))
      return resolved.filter((model): model is SessionRunnerModel.Resolved => model !== undefined)
    })

    const peers = Effect.fn("SessionModelPool.peers")(function* (
      session: SessionSchema.Info,
      active: Model.Ref,
    ) {
      const current = yield* pool(session)
      if (!current) return []
      const refs = ModelPool.peers(current.models, active)
      const resolved = yield* Effect.forEach(refs, (ref) => resolve(session, ref))
      return resolved.filter((model): model is SessionRunnerModel.Resolved => model !== undefined)
    })

    return Service.of({ pool, resolve, chain, peers })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, ModelService.node, SessionRunnerModel.node],
})
