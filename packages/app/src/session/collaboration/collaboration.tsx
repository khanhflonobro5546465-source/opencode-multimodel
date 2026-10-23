import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Tooltip } from "@opencode/ui/tooltip"
import { For, Show, createMemo, createSignal } from "solid-js"
import { useModels } from "@/providers/models/models"
import { useData } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { useSessionLayout } from "@/session/session-layout"

/** Session metadata key that holds the collaboration pool. */
const METADATA_KEY = "model_pool"

/** A pool holds at least two models to collaborate and at most five to stay reviewable. */
const MIN_MODELS = 2
const MAX_MODELS = 5

type Mode = "off" | "on-demand" | "auto"

type PoolModel = { providerID: string; id: string }

const modelKey = (model: PoolModel) => `${model.providerID}/${model.id}`

/** Reads a pool out of the session metadata, ignoring anything malformed. */
const parsePool = (value: unknown): { models: PoolModel[]; mode: Mode } | undefined => {
  if (!value || typeof value !== "object") return undefined
  const raw = value as { models?: unknown; mode?: unknown }
  if (!Array.isArray(raw.models)) return undefined
  const models: PoolModel[] = []
  for (const item of raw.models) {
    if (typeof item === "string") {
      const separator = item.indexOf("/")
      if (separator <= 0) continue
      models.push({ providerID: item.slice(0, separator), id: item.slice(separator + 1) })
      continue
    }
    if (!item || typeof item !== "object") continue
    const entry = item as { providerID?: unknown; id?: unknown }
    if (typeof entry.providerID !== "string" || typeof entry.id !== "string") continue
    models.push({ providerID: entry.providerID, id: entry.id })
  }
  const mode: Mode = raw.mode === "auto" || raw.mode === "on-demand" ? raw.mode : "off"
  return { models, mode }
}

const MODE_LABEL: Record<Mode, string> = {
  off: "Fallback only",
  "on-demand": "Ask on demand",
  auto: "Answer together",
}

const MODE_HINT: Record<Mode, string> = {
  off: "Models take over from each other when one runs out of quota.",
  "on-demand": "The primary model can ask the other models for their answer.",
  auto: "Every model answers each turn in parallel; the primary model merges the answers.",
}

/**
 * The collaboration pool of a session.
 *
 * The pool is an ordered list of two to five models. The first one answers
 * first and the rest take over when it runs out of quota, which is what keeps
 * a long running task alive across a rate limit. In the collaboration modes the
 * other models answer the same request in parallel, so the answer comes from
 * several models at once.
 */
export function SessionCollaboration() {
  const layout = useSessionLayout()
  const data = useData()
  const sdk = useServerSDK()
  const models = useModels()

  const sessionID = createMemo(() => layout.params.id)
  const info = createMemo(() => {
    const id = sessionID()
    return id ? data.session.get(id) : undefined
  })
  const saved = createMemo(() => parsePool(info()?.metadata?.[METADATA_KEY]))

  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<PoolModel[]>([])
  const [mode, setMode] = createSignal<Mode>("off")
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)

  const available = createMemo(() =>
    models
      .list()
      .map((model) => ({
        providerID: model.provider.id,
        id: model.id,
        label: model.name,
        provider: model.provider.name,
      }))
      .filter((model) => {
        const text = query().trim().toLowerCase()
        if (!text) return true
        return (
          model.label.toLowerCase().includes(text) ||
          model.id.toLowerCase().includes(text) ||
          model.provider.toLowerCase().includes(text)
        )
      })
      .slice(0, 60),
  )

  const chosen = createMemo(() => selected().map(modelKey))

  const isChosen = (model: PoolModel) => chosen().includes(modelKey(model))

  const toggle = (model: PoolModel) => {
    setError(undefined)
    setSelected((current) => {
      if (current.some((item) => modelKey(item) === modelKey(model)))
        return current.filter((item) => modelKey(item) !== modelKey(model))
      if (current.length >= MAX_MODELS) {
        setError(`A pool holds at most ${MAX_MODELS} models.`)
        return current
      }
      return [...current, model]
    })
  }

  const load = () => {
    const current = saved()
    setSelected(current?.models ?? [])
    setMode(current?.mode ?? "off")
    setError(undefined)
  }

  const save = async () => {
    const id = sessionID()
    if (!id) return
    if (selected().length < MIN_MODELS) {
      setError(`Pick at least ${MIN_MODELS} models.`)
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      await sdk.api.session.update({
        sessionID: id,
        metadata: {
          ...(info()?.metadata ?? {}),
          [METADATA_KEY]: {
            models: selected().map(modelKey),
            mode: mode(),
          },
        },
      })
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const clear = async () => {
    const id = sessionID()
    if (!id) return
    setSaving(true)
    setError(undefined)
    try {
      await sdk.api.session.update({
        sessionID: id,
        metadata: {
          ...(info()?.metadata ?? {}),
          [METADATA_KEY]: { models: [], mode: "off" },
        },
      })
      setSelected([])
      setMode("off")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const active = createMemo(() => {
    const model = info()?.model
    if (!model) return undefined
    return `${model.providerID}/${model.id}`
  })

  const configured = createMemo(() => (saved()?.models.length ?? 0) >= MIN_MODELS)

  return (
    <div class="relative" data-slot="session-collaboration">
      <Tooltip class="shrink-0" placement="bottom" value="Collaboration">
        <IconButton
          type="button"
          variant="ghost-muted"
          size="large"
          class="shrink-0"
          state={open() ? "pressed" : undefined}
          onClick={() => {
            if (!open()) load()
            setOpen(!open())
          }}
          aria-label="Collaboration"
          aria-expanded={open()}
          icon={<Icon name="models" />}
        />
      </Tooltip>
      <Show when={configured()}>
        <span
          class="pointer-events-none absolute -end-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-v2-background-bg-base text-[10px] font-medium text-v2-text-text-muted"
          aria-hidden="true"
        >
          {saved()?.models.length}
        </span>
      </Show>
      <Show when={open()}>
        <div
          class="absolute end-0 top-full z-50 mt-2 flex w-[340px] flex-col gap-3 rounded-xl border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3 shadow-lg"
          data-slot="session-collaboration-panel"
        >
          <div class="flex flex-col gap-1">
            <span class="text-[13px] font-medium text-v2-text-text-base">Collaboration pool</span>
            <span class="text-[11px] leading-4 text-v2-text-text-faint">
              Pick two to five models. They answer together, and the next one takes over when a model runs out of
              quota.
            </span>
          </div>
          <Show when={active()}>
            {(value) => (
              <div class="text-[11px] text-v2-text-text-muted">
                Answering now: <span class="text-v2-text-text-base">{value()}</span>
              </div>
            )}
          </Show>
          <div class="flex flex-col gap-1">
            <For each={selected()}>
              {(model, index) => (
                <div
                  class="flex items-center justify-between gap-2 rounded-md bg-v2-background-bg-layer-02 px-2 py-1 text-[12px]"
                >
                  <span class="truncate text-v2-text-text-base">
                    <span class="text-v2-text-text-faint">{index() + 1}.</span> {modelKey(model)}
                  </span>
                  <button
                    type="button"
                    class="shrink-0 text-[11px] text-v2-text-text-faint hover:text-v2-text-text-base"
                    onClick={() => toggle(model)}
                  >
                    Remove
                  </button>
                </div>
              )}
            </For>
          </div>
          <div class="flex flex-col gap-1">
            <For each={Object.keys(MODE_LABEL) as Mode[]}>
              {(option) => (
                <label class="flex cursor-pointer items-start gap-2 text-[12px] text-v2-text-text-base">
                  <input
                    type="radio"
                    name="session-collaboration-mode"
                    class="mt-0.5"
                    checked={mode() === option}
                    onChange={() => setMode(option)}
                  />
                  <span class="flex flex-col gap-0.5">
                    <span>{MODE_LABEL[option]}</span>
                    <span class="text-[11px] leading-4 text-v2-text-text-faint">{MODE_HINT[option]}</span>
                  </span>
                </label>
              )}
            </For>
          </div>
          <input
            type="text"
            placeholder="Filter models"
            class="w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1 text-[12px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <div class="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
            <For each={available()}>
              {(model) => (
                <button
                  type="button"
                  class="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[12px] text-v2-text-text-base hover:bg-v2-background-bg-layer-02"
                  onClick={() => toggle({ providerID: model.providerID, id: model.id })}
                >
                  <span class="truncate">{model.label}</span>
                  <span class="shrink-0 text-[11px] text-v2-text-text-faint">
                    {isChosen({ providerID: model.providerID, id: model.id }) ? "Selected" : model.provider}
                  </span>
                </button>
              )}
            </For>
          </div>
          <Show when={error()}>
            {(value) => <div class="text-[11px] text-v2-text-text-error">{value()}</div>}
          </Show>
          <div class="flex items-center justify-between gap-2">
            <button
              type="button"
              class="rounded-md px-2 py-1 text-[12px] text-v2-text-text-faint hover:text-v2-text-text-base"
              onClick={clear}
              disabled={saving()}
            >
              Clear
            </button>
            <button
              type="button"
              class="rounded-md bg-v2-background-bg-inverse px-3 py-1 text-[12px] font-medium text-v2-text-text-inverse disabled:opacity-50"
              onClick={save}
              disabled={saving() || selected().length < MIN_MODELS}
            >
              Save
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}
