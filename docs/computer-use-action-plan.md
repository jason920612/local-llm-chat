# Plan: Flexible, precise GUI actions for computer use

Status: **in progress** · Scope: `computer_action` + `browser_action` (microVM
sandbox) · Author: design agreed with the project owner in chat.

## 1. Problem

The model can *see* the VM screen (`computer_observe` / `browser_observe`) but its
*hands* are too blunt for complex tasks — "hand–eye uncoordinated":

- **Missing actions**: no double-click, drag, modifier-click, button/key hold.
- **Targeting by raw coordinates only** → the model does the math and clicks the
  wrong place. `browser_action` had element IDs; `computer_action` did not.
- **One VM round-trip per action** → slow `observe → act → observe` loops where
  coordinates "drift"; coherent gestures (move → press → drag → release) can't be
  expressed.
- **No feedback** after an action (need a second `observe`).
- **DOM element IDs are unstable** on fast-updating pages.

## 2. Design summary

One coherent **action program** sent in a single call and executed server-side
(in the guest), for BOTH `computer_action` and `browser_action`:

- **Structured handles**: every observed element has a stable `id`, plus
  pre-computed `center` / `bbox` / `text` / `role`. The model targets elements;
  the server resolves coordinates.
- **Resilient targeting** (3 ways, for the ID-instability problem):
  `id` (handle) · `text` (re-locate fresh by visible text/role) · `x,y` (raw).
- **Multi-step sequences**: a `steps[]` array run in one round-trip, fail-fast.
- **Richer verbs**: `move, left_click, right_click, middle_click, double_click,
  mouse_down, mouse_up, drag, type_text, key, key_down, key_up, scroll, wait`
  (+ `modifiers` for clicks; arbitrary key combos via `key`, e.g. `ctrl+shift+t`).
- **Condition gates** (declarative, recursive boolean tree) used two ways:
  - `when`: instant check — skip the step if false.
  - `wait_for` (+ `timeout_ms`): poll until true before acting; timeout → step
    fails.
- **Logic gates**: `all` (AND), `any` (OR), `not` (NOT), `none` (NOR),
  `nand` (NAND); arbitrarily nestable; leaves may carry a `label`.
- **Wait reason reporting**: when a wait ends, the step result says *why* —
  `wait_result.outcome` = `matched` (with `by`: which labelled leaf/leaves) or
  `timeout` (with `unmet`: which leaves were still false).
- **Failure branches**: `on_fail` = `"stop"` | `"continue"` |
  `{ do: Step[], then?: "return" | "continue" }`. The `do` branch is a recovery
  sub-sequence the model pre-planned (recursive — it can have its own
  `wait_for`/`on_fail`). `then` decides whether to return after recovery
  (default) or resume the main sequence.
- **Auto feedback**: every action call returns an execution-time observation
  (fresh element list; screenshot only when `include_screenshot` is set).

## 3. Schema

### 3.1 Condition (recursive)

```
Condition =
    { text: string, label?: string }        // visible text present
  | { gone: string, label?: string }        // text/element absent
  | { id_present: string, label?: string }  // handle present
  | { id_gone: string, label?: string }
  | { clickable: string, label?: string }   // id or text resolves to a visible element
  | { url_contains: string, label?: string }// browser only
  | { ms: number, label?: string }          // elapsed >= ms
  | { all:  Condition[] }   // AND
  | { any:  Condition[] }   // OR
  | { not:  Condition }     // NOT
  | { none: Condition[] }   // NOR  (= not any)
  | { nand: Condition[] }   // NAND (= not all)
```

### 3.2 Step

```
Step = {
  action: "move" | "left_click" | "right_click" | "middle_click" |
          "double_click" | "mouse_down" | "mouse_up" | "drag" |
          "type_text" | "key" | "key_down" | "key_up" | "scroll" | "wait",
  // target (pointer actions): exactly one of
  id?: string,            // element handle
  text?: string,          // re-locate by visible text/role  (also the text for type_text)
  x?: number, y?: number, // raw coordinates
  // drag destination (one of)
  to_id?: string, to_text?: string, to_x?: number, to_y?: number,
  modifiers?: ("ctrl"|"shift"|"alt"|"meta")[],  // held during a click
  key?: string,           // for key / key_down / key_up (e.g. "Return", "ctrl+shift+t")
  amount?: number,        // for scroll (wheel notches; +down / -up)
  when?: Condition,       // instant gate: skip the step if false
  wait_for?: Condition,   // poll until true before acting
  timeout_ms?: number,    // for wait_for (default 8000)
  delay_ms?: number,      // pause after the step
  on_fail?: "stop" | "continue" | { do: Step[], then?: "return" | "continue" },
}
```

### 3.3 Call & result

Input: `{ steps: Step[], include_screenshot?: boolean }`

```
Result = {
  ok: boolean,            // completed as planned / recovered
  handled?: boolean,      // a step failed but its on_fail branch recovered
  stoppedAt?: number,     // index where it stopped (null if completed)
  steps: StepResult[],
  observation: { url?, title?, screen, elements: Element[], screenshot? },
}
StepResult = {
  i, action, ok, skipped?, error?, waitedMs?,
  wait_result?: { outcome: "matched"|"timeout", by?: string[], unmet?: string[], waited_ms },
  fallback?: { then: "return"|"continue", steps: StepResult[] },
}
```

## 4. Execution semantics (server-side, in the guest)

For each step, in order:
1. `when` present and false → mark `skipped`, continue.
2. `wait_for` present → poll a fresh snapshot until the condition tree is true or
   `timeout_ms`. Record `wait_result`. Timeout → step fails.
3. Resolve the target (id → handle center; text → fresh re-locate; x,y → raw),
   perform the verb. Action error → step fails.
4. `delay_ms` → pause.
5. On failure, apply `on_fail`: `stop` (end, `ok=false`), `continue` (skip),
   or run `do` recovery then `return`/`continue` (recovery success → `handled`).

A fresh snapshot drives both targeting and condition polling; OCR (computer) is
only run when a condition/target actually needs on-screen text (cost control).
The whole sequence is one VM job → one round-trip. A final observation is always
attached.

## 5. Files changed

- `src/lib/sandbox/driver.ts` — new `ActionStep` / `ActionCondition` / sequence
  result types (old single-action types kept for compatibility).
- `sandbox-host/guest/llm-runner.py` — the sequence engine (snapshots, targeting,
  verbs, recursive condition eval with reasons, `on_fail` recursion, results,
  observation) for computer (xdotool) and browser (Playwright).
- `src/lib/grok/responses.ts` — `computer_action` / `browser_action` tool schemas
  accept `steps[]`; dispatch forwards them.
- `src/lib/sandbox/microvm.ts` — pass the `steps` payload through to the guest.
- `src/lib/prompts.ts` — document the action model for the model.

## 6. Safety

Unchanged isolation boundary: all actions target only the conversation's isolated
VM display (Xvfb `:99`) / its Playwright Chromium — never the host desktop,
clipboard, or input devices. Conditions are a fixed declarative set (no arbitrary
code execution). The VM remains the trust boundary.

## 7. Test plan

- Multi-step sequence: type → click → `wait_for` text → assert per-step results.
- `any` with labels → `wait_result.by` reports which branch fired.
- `wait_for` timeout → `outcome:"timeout"`, `unmet` lists missing leaves.
- `on_fail.do` recovery (then=return and then=continue) → `handled` reflects it.
- drag, double_click, modifier-click, key combo execute.
- Auto observation returned with fresh handles; screenshot only on request.
- Backward compatibility: a single legacy action still works.
