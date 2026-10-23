import { describe, expect, test } from "bun:test"
import { Model } from "../src/model.js"
import { ModelPool } from "../src/model-pool.js"

const ref = (providerID: string, id: string, variant?: string) =>
  Model.Ref.make({
    providerID: providerID as never,
    id: id as never,
    ...(variant ? { variant: variant as never } : {}),
  })

describe("ModelPool", () => {
  test("decodes a pool from the short and the explicit form", () => {
    const decoded = ModelPool.decode({
      models: ["anthropic/claude-sonnet-4", { providerID: "openai", id: "gpt-5", variant: "high" }],
      mode: "auto",
    })

    expect(decoded).toBeDefined()
    expect(decoded?.models).toHaveLength(2)
    expect(String(decoded?.models[0].providerID)).toBe("anthropic")
    expect(String(decoded?.models[0].id)).toBe("claude-sonnet-4")
    expect(String(decoded?.models[1].providerID)).toBe("openai")
    expect(String(decoded?.models[1].id)).toBe("gpt-5")
    expect(String(decoded?.models[1].variant)).toBe("high")
    expect(decoded?.mode).toBe("auto")
  })

  test("rejects a malformed pool instead of guessing", () => {
    expect(ModelPool.decode(undefined)).toBeUndefined()
    expect(ModelPool.decode({ models: "anthropic/claude", mode: "auto" })).toBeUndefined()
    expect(ModelPool.decode({ models: ["not-a-model"], mode: "auto" })).toBeUndefined()
  })

  test("falls back to the off mode for an unknown mode", () => {
    const decoded = ModelPool.decode({ models: ["a/b", "c/d"], mode: "nonsense" })
    expect(decoded?.mode).toBe("off")
  })

  test("accepts pools of two to five models", () => {
    const two = ModelPool.decode({ models: ["a/b", "c/d"], mode: "off" })
    const five = ModelPool.decode({ models: ["a/b", "c/d", "e/f", "g/h", "i/j"], mode: "off" })
    const one = ModelPool.decode({ models: ["a/b"], mode: "off" })
    const six = ModelPool.decode({ models: ["a/b", "c/d", "e/f", "g/h", "i/j", "k/l"], mode: "off" })

    expect(ModelPool.valid(two!)).toBe(true)
    expect(ModelPool.valid(five!)).toBe(true)
    expect(ModelPool.valid(one!)).toBe(false)
    expect(ModelPool.valid(six!)).toBe(false)
  })

  test("builds the fallback chain after the active model", () => {
    const models = [ref("a", "one"), ref("b", "two"), ref("c", "three")]

    expect(ModelPool.chain(models, models[0]).map((model) => model.id)).toEqual(["two", "three"])
    expect(ModelPool.chain(models, models[1]).map((model) => model.id)).toEqual(["three"])
    // The last model has nothing to fall back to.
    expect(ModelPool.chain(models, models[2])).toHaveLength(0)
  })

  test("falls back to the whole pool when the active model is not part of it", () => {
    const models = [ref("a", "one"), ref("b", "two")]
    const chain = ModelPool.chain(models, ref("z", "other"))
    expect(chain.map((model) => model.id)).toEqual(["one", "two"])
  })

  test("lists the other models of the pool as peers", () => {
    const models = [ref("a", "one"), ref("b", "two"), ref("c", "three")]
    expect(ModelPool.peers(models, models[0]).map((model) => model.id)).toEqual(["two", "three"])
    expect(ModelPool.peers(models, models[1]).map((model) => model.id)).toEqual(["one", "three"])
  })

  test("treats a different variant as a different model", () => {
    const models = [ref("a", "one", "high"), ref("a", "one", "low")]
    expect(ModelPool.peers(models, models[0])).toHaveLength(1)
    expect(ModelPool.chain(models, models[0])).toHaveLength(1)
  })
})
