import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { Document, Info } from "@opencode/schema/config"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Config } from "@opencode/core/config"
import { SessionModelPool } from "@opencode/core/session/model-pool"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionSchema } from "@opencode/core/session/schema"

const first = Model.Ref.make({ providerID: Provider.ID.make("fake"), id: Model.ID.make("first") })
const second = Model.Ref.make({ providerID: Provider.ID.make("fake"), id: Model.ID.make("second") })
const third = Model.Ref.make({ providerID: Provider.ID.make("fake"), id: Model.ID.make("third") })

const catalog = [first, second, third].map(
  (ref) =>
    ({
      providerID: ref.providerID,
      id: ref.id,
      name: ref.id,
      limit: { context: 200_000, output: 32_000 },
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      modalities: { input: ["text"], output: ["text"] },
    }) as unknown as Model.Info,
)

const resolvedFor = (ref: Model.Ref) =>
  SessionRunnerModel.resolved(LanguageModel.make({ id: ref.id, provider: ref.providerID, route: OpenAIChat.route }), {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
  })

const modelService = Layer.mock(Model.Service)({
  get: () => Effect.undefined,
  all: () => Effect.succeed(catalog),
  available: () => Effect.succeed(catalog),
  default: () => Effect.undefined,
  small: () => Effect.undefined,
})

const runnerModelService = Layer.mock(SessionRunnerModel.Service)({
  resolve: (session) => Effect.succeed(resolvedFor(session.model ?? first)),
})

const session = (metadata?: Record<string, unknown>) =>
  ({
    id: SessionSchema.ID.make("ses_pool_test"),
    projectID: "prj_test",
    directory: "/project",
    cost: { amount: 0, currency: "USD" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: "/project" },
    version: "test",
    model: first,
    ...(metadata ? { metadata } : {}),
  }) as unknown as SessionSchema.Info

const run = <A>(
  config: Layer.Layer<Config.Interface>,
  build: (pools: SessionModelPool.Interface) => Effect.Effect<A, never, never>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pools = yield* SessionModelPool.Service
      return yield* build(pools)
    }).pipe(
      Effect.provide(
        SessionModelPool.layer.pipe(Layer.provide(Layer.mergeAll(config, modelService, runnerModelService))),
      ),
    ),
  )

describe("SessionModelPool", () => {
  test("reads the pool from the session metadata", async () => {
    const pool = await run(Config.testLayer([]), (pools) =>
      pools.pool(session({ model_pool: { models: ["fake/first", "fake/second"], mode: "auto" } })),
    )

    expect(pool).toBeDefined()
    expect(pool?.models).toHaveLength(2)
    expect(pool?.mode).toBe("auto")
  })

  test("ignores a pool with an unusable number of models", async () => {
    const pool = await run(Config.testLayer([]), (pools) =>
      pools.pool(session({ model_pool: { models: ["fake/first"], mode: "auto" } })),
    )

    expect(pool).toBeUndefined()
  })

  test("falls back to the configured pool", async () => {
    const config = Config.testLayer([
      new Document({
        type: "document",
        info: new Info({ model_pool: { models: [second, third], mode: "on-demand" } }),
      }),
    ])
    const pool = await run(config, (pools) => pools.pool(session()))

    expect(pool?.models).toHaveLength(2)
    expect(pool?.mode).toBe("on-demand")
  })

  test("builds the fallback chain after the active model", async () => {
    const chain = await run(Config.testLayer([]), (pools) =>
      pools.chain(session({ model_pool: { models: ["fake/first", "fake/second", "fake/third"], mode: "off" } }), first),
    )

    expect(chain.map((model) => model.ref.id)).toEqual(["second", "third"])
  })

  test("lists the other models of the pool as peers", async () => {
    const peers = await run(Config.testLayer([]), (pools) =>
      pools.peers(session({ model_pool: { models: ["fake/first", "fake/second"], mode: "auto" } }), first),
    )

    expect(peers.map((model) => model.ref.id)).toEqual(["second"])
  })

  test("has no chain without a pool", async () => {
    const chain = await run(Config.testLayer([]), (pools) => pools.chain(session(), first))

    expect(chain).toHaveLength(0)
  })
})
