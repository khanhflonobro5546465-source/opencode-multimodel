# Multi-Model Collaboration & Auto-Fallback

This build of OpenCode adds a **collaboration pool**: an ordered set of two to five
models that work on the same task. The pool drives two features that are meant to
work together:

1. **Multi-model collaboration** — several models answer the same request at the
   same time and the primary model merges their answers into one response.
2. **Auto-fallback (token switching)** — when a model runs out of capacity
   (rate limit, spent quota, exhausted output limit), the session hands the work
   to the next model in the pool without interrupting the running turn.

Everything is opt-in. Without a pool, OpenCode behaves exactly as before.

---

## 1. The model pool

A pool is an ordered list of two to five models:

| Position | Role |
| --- | --- |
| 1 | **Preferred model.** Answers first and owns the conversation. |
| 2..n | **Fallback chain.** Each one takes over when the model above it runs out of capacity. In the collaboration modes they are also the **peers** that answer in parallel. |

The first model of the list is the one that answers; the rest are ordered by
preference, so a fallback always lands on the next model you chose.

A pool lives in one of two places:

* **Per session** — the web app stores it in the session metadata under the
  `model_pool` key. This is what the *Collaboration* button in the session
  header writes.
* **Global default** — `model_pool` in `opencode.json` applies to every session
  that has no pool of its own.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model_pool": {
    "models": [
      "anthropic/claude-sonnet-4",
      "openai/gpt-5",
      "google/gemini-2.5-pro"
    ],
    "mode": "auto"
  }
}
```

The short `"provider/model"` form is accepted, as is the explicit form
`{ "providerID": "openai", "id": "gpt-5", "variant": "high" }`.

### Modes

| Mode | Behaviour |
| --- | --- |
| `off` | Fallback only. The models take over from each other when one runs out of quota. |
| `on-demand` | The preferred model can call the `collaborate` tool to ask the other models for their answer, mid-task. |
| `auto` | Every model of the pool answers each user turn in parallel; the preferred model merges the answers into the final response. |

---

## 2. Auto-fallback / token switching

A step fails for a model in three ways that another model can take over from:

| Failure | Session error type |
| --- | --- |
| Rate limit reached | `provider.rate-limit` |
| Quota or credits exhausted | `provider.quota`, `provider.free-limit` |
| Response cannot finish within the output limit | `output-limit` |

When one of these happens, the runner:

1. asks the pool for the next model in the chain,
2. records the switch as a durable `session.model.selected` event, so the
   session keeps running on the new model and the UI shows which model answers,
3. rebuilds the request for that model and continues the **same turn**.

The turn is never aborted: the assistant message, the tool calls and the
transcript stay intact, and the switch is visible in the timeline. When the pool
is exhausted, the original error is reported as before.

Cross-provider switches are safe: the transcript builder already strips
model-scoped provider metadata (thought signatures, encrypted reasoning) when a
different model reads the history.

## 3. Multi-model collaboration

### `auto` mode

On the first step of a turn the runner asks every peer model the same question
**at the same time** (concurrent requests, so the wall-clock cost is that of the
slowest model, not the sum). The answers are then:

* published as a synthetic message, so the transcript records which models took
  part in the answer, and
* handed to the preferred model, which merges them into one final answer for the
  user.

A model that fails does not stop the others; its failure is reported next to the
answers that did arrive.

### `on-demand` mode

The preferred model receives a `collaborate` tool:

```
collaborate({
  prompt: "Which of these two SQL queries avoids the full table scan, and why?",
  models: ["postgres/postgres-17"],   // optional, defaults to the whole pool
  instruction: "Focus on the query plan", // optional
})
```

The tool asks the selected models in parallel and returns their answers, so the
preferred model can compare a second opinion, a specialist or a reviewer
without leaving the task.

---

## 4. Using it in the web app

Open a session and use the **Collaboration** button next to the review toggle in
the session header:

* pick two to five models from the connected providers (the first pick is the
  preferred model, the order of the picks is the fallback order),
* choose the mode,
* save. The pool is stored on the session and takes effect on the next turn.

The button carries a badge with the number of models in the pool, and the panel
shows which model is answering right now.

## 5. Using it from the API

The pool is plain session metadata, so any client can set it:

```bash
curl -X PATCH "$OPENCODE_URL/api/session/$SESSION_ID" \
  -H 'content-type: application/json' \
  -d '{
    "metadata": {
      "model_pool": {
        "models": ["anthropic/claude-sonnet-4", "openai/gpt-5"],
        "mode": "auto"
      }
    }
  }'
```

The `model_pool` key is also part of the `config` API, so a global default can
be set with the regular `config.update` endpoint.

---

## 6. Implementation map

| File | Purpose |
| --- | --- |
| `packages/schema/src/model-pool.ts` | The pool schema: modes, limits, chain and peer helpers. |
| `packages/schema/src/config.ts` | The `model_pool` config option. |
| `packages/core/src/session/model-pool.ts` | `SessionModelPool` service: merges the session pool with the configured default, resolves pool members into runnable models, and computes the fallback chain and the peers. |
| `packages/core/src/session/collaboration.ts` | Parallel fan-out to the peer models and the formatting of their answers. |
| `packages/core/src/session/runner/llm.ts` | Auto-fallback (`takeOver`) and the automatic parallel consultation (`consultPeers`). |
| `packages/core/src/tool/plugin/collaborate.ts` | The `collaborate` tool for on-demand collaboration. |
| `packages/app/src/session/collaboration/collaboration.tsx` | The web UI: pick the models, pick the mode, save the pool. |

Tests: `packages/schema/test/model-pool.test.ts` and
`packages/core/test/session-model-pool.test.ts`.

## 7. Notes and limits

* A pool holds two to five models. Fewer cannot collaborate, more make the
  fallback chain and the review burden grow without much benefit.
* `auto` mode multiplies the token cost of a turn by the size of the pool, and
  it asks the peers on the first step of a turn only, so a long tool loop does
  not pay for the same answers twice.
* The peers answer without tools: they reason about the request and return
  text. Only the preferred model runs the tool loop.
* A peer that is not connected or not available is skipped; the pool keeps
  working with the models that are available.
