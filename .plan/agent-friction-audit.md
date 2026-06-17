# Agent Friction Audit — Code-Level Issues

Audit of all 50+ MCP tools in `src/tools/` for patterns that frustrate, confuse, or bottleneck AI agents. Conducted after creating `SKILL.md` and `REMIX.md` to ensure the code supports the Remix-first behavioral skills.

Severity: 🚨 Critical | 🔴 High | 🟡 Medium

---

## 🚨 Critical — Blocks Remix Philosophy

### 1. Seed randomization is the DEFAULT

**File:** `src/tools/workflow-execute.ts:48-50`
**Service:** `src/services/workflow-executor.ts`

`enqueue_workflow` silently overwrites every `seed` / `noise_seed` numeric field in the workflow with `Math.floor(Math.random() * 2**32)` — unless `disable_random_seed: true` is passed.

An agent that carefully sets `seed: 42` for reproducibility has it silently overwritten. The tool description says *"If true, do not randomize seed values"* — this implies the default is *do not randomize*, which is the exact opposite of reality.

The same seed randomization applies transitively to `regenerate` (which calls `enqueueWorkflow`) and to `generate_with_controlnet` / `generate_with_ip_adapter` (which call `enqueueWorkflow` internally).

**Proposed fix:** Flip the default — make seed preservation the default and require opt-in for randomization (`enable_random_seed: false` → true, or change default).

```typescript
// Current (bad):
disable_random_seed: z.boolean().optional()
  .describe("If true, do not randomize seed values")

// Proposed:
preserve_seed: z.boolean().optional().default(true)
  .describe("If true, keep explicit seed values. Set to false to randomize all seeds.")
```

---

### 2. Auto-select first model alphabetically (Conditioned Tools)

**File:** `src/tools/generate-conditioned.ts:12-18`

```typescript
async function resolveFirstModel(type: string): Promise<string | undefined> {
  try {
    const models = await listLocalModels(type);
    return models[0]?.name; // ← first alphabetically, filesystem order
  } catch {
    return undefined;
  }
}
```

Both `generate_with_controlnet` and `generate_with_ip_adapter` silently auto-select the **first model** from the local directory (filesystem order, effectively alphabetical). The agent:
- Has no control over which model is chosen
- Cannot preview the selection before enqueue
- Gets a non-deterministic result (filesystem ordering varies by OS)

`generate_with_controlnet` auto-selects **both** checkpoint and controlnet model this way.

**Proposed fix:** Remove auto-select. Require the agent to specify a checkpoint (like `generate_image` does). Or at minimum, return the selected model name BEFORE enqueue so the agent can abort.

---

### 3. Inconsistent checkpoint handling across generation tools

`generate_image` *blocks* and returns a "please pick one" list if checkpoint is omitted. `generate_with_controlnet` and `generate_with_ip_adapter` *silently auto-select*. The agent learns a pattern from one tool that breaks on another.

| Tool | Checkpoint omitted |
|------|--------------------|
| `generate_image` | Returns model list, asks agent to choose |
| `generate_with_controlnet` | Auto-selects `models[0]?.name` silently |
| `generate_with_ip_adapter` | Auto-selects `models[0]?.name` silently |

**Proposed fix:** Unify checkpoint behavior. Either all three block-and-ask or all three require explicit checkpoint.

---

### 4. `create_workflow` opaque defaults

**File:** `src/services/workflow-composer.ts`

Hardcoded defaults in each template:

```typescript
// txt2img defaults:
const ckpt = "sd_xl_base_1.0.safetensors";
const width = 1024;
const height = 1024;
const steps = 20;
const cfg = 8.0;
const sampler = "euler";
const scheduler = "normal";
```

The agent has **no way to discover these defaults** without reading the source code. The tool description says *"Unsupplied params fall back to template defaults"* but doesn't say what those defaults are. The `params` field is `z.record(z.any())` — no typed schema, so typos like `positve_prompt` are silently ignored.

**Proposed fix:** Add a `get_template_defaults(template)` tool or include defaults in `create_workflow`'s return value (e.g. `{ workflow, defaults_used: {...} }`).

---

### 5. No Remix-first entry point

Every generation path builds from scratch:
- `generate_image` → always builds new txt2img workflow
- `generate_with_controlnet` → always builds new controlnet workflow
- `generate_with_ip_adapter` → always builds new ip_adapter workflow
- `create_workflow` → always builds from template

There is no single-call tool that says: *"Take this existing workflow + tweak these params + save + enqueue"*. The Remix path requires 3–4 separate tool calls:

```
list_workflows → analyze_workflow → get_workflow → modify_workflow → save_workflow → enqueue_workflow
```

**Proposed fix:** Consider a `remix_workflow` tool that wraps the full Remix flow in one call:
```
remix_workflow({
  source: "existing_workflow.json",
  operations: [...modify_workflow ops],
  save_as: "remixed_version.json",
  enqueue: true
})
```

---

## 🔴 High — Confuses & Wastes Tokens

### 6. Most tools return unstructured text

~38 of ~50 tools return human-formatted markdown text instead of structured JSON. The agent must regex-parse filenames, model names, sizes, and lists from text.

| Tool | Returns | Agent must |
|------|---------|------------|
| `list_workflows` | `"1. foo.json\n2. bar.json"` | Regex `.json` filenames from numbered list |
| `list_local_models` | `"## checkpoints (3)\n- model.safetensors (2.3 GB)"` | Parse markdown headings + list items |
| `search_models` | `"1. **org/model** by author"` | Extract modelId from bold markdown |
| `list_output_images` | `"1. **file.png** (2.3 MB) — date"` | Parse bold filenames |
| `save_workflow` | `"Saved successfully."` | Nothing (just ack) |
| `get_history` | Formatted text summary | Extract filenames from text |
| `upload_image` | `"Uploaded.\n\nFilename: x.png\n\nUse..."` | Parse filename from text |

Only 12 of ~50 tools return structured JSON:
- `enqueue_workflow`, `get_system_stats`, `create_workflow`, `modify_workflow`, `get_node_info`, `generate_image`, `generate_with_*`, `get_queue`, `get_job_status`, `list_assets`, `regenerate`

**Proposed fix:** Add `format: "json"` or `format: "text"` parameter to text-returning tools, with `"text"` as default for backward compatibility. When `format: "json"`, return properly typed JSON the agent can parse directly.

---

### 7. `search_models` promises download URLs but doesn't return them

**File:** `src/tools/model-management.ts`

Tool description says: *"Pick a result's download URL and pass it to `download_model` to install it locally."*

But the search results do NOT include a download URL. They include `modelId` (e.g. `"stabilityai/stable-diffusion-xl-base-1.0"`). The agent is told to "pick a download URL" but none is shown — dead end.

**Proposed fix:** Either:
- Remove the misleading description text
- Return actual download URLs in search results
- Or add a `model_to_url(modelId)` helper tool

---

### 8. `save_workflow` always overwrites without safety

**File:** `src/tools/workflow-library.ts`

The tool overwrites any existing file with the same filename without confirmation. The description documents this, but an agent making a `save_workflow` call with a generic name like `"output.json"` will silently destroy the existing file.

**Proposed fix:** Add an `overwrite: boolean` parameter that defaults to `false`. Return an error if the file exists and `overwrite` is not `true`, with the existing workflow name.

---

### 9. `get_image` `save_dir` documentation mismatch

**File:** `src/tools/image-management.ts`

Parameter description says: *"Local directory to save the image file. Defaults to /tmp/comfyui-images/."*

Implementation (line 54):
```typescript
const saveDir = args.save_dir ?? process.cwd();
```

The description says `/tmp/comfyui-images/` but code uses `process.cwd()`. Agent reading the description expects `/tmp/comfyui-images/`.

**Proposed fix:** Update the `.describe()` to match the actual default.

---

### 10. `regenerate` double-randomizes seeds

**File:** `src/tools/assets.ts`

The tool calls `enqueueWorkflow(next, { disable_random_seed })` which randomizes seeds again (unless `disable_random_seed` is true). An agent that passes `seed: 42` in overrides will still have it randomized because the override only sets the seed on the workflow node, but `enqueueWorkflow` then randomizes it back.

The description says *"Seeds are re-randomized by default so each regenerate yields a fresh image unless seed is explicitly passed in overrides"* — but even with seed in overrides, it gets randomized again.

**Proposed fix:** When the agent passes an explicit seed in overrides and does NOT pass `disable_random_seed: false`, the tool should automatically set `disable_random_seed: true` for that seed, or detect seed overrides and skip randomization.

---

## 🟡 Medium — Friction

### 11. `workflow_from_image` context flood

**File:** `src/tools/image-management.ts`

Always returns BOTH `prompt` (API format) and `workflow` (UI format) as full JSON blobs embedded in markdown. For complex workflows, this can be thousands of lines. Agent often needs only one format.

**Proposed fix:** Add `format: "api" | "ui" | "both"` parameter, default to `"both"`.

---

### 12. `get_history` returns formatted text, not structured output

**File:** `src/tools/diagnostics.ts`

Returns human-readable text via `formatHistoryEntry()`. Agent cannot programmatically extract filenames or error details.

**Proposed fix:** Add JSON output option alongside the readable text.

---

### 13. `generate_with_*` vs `generate_image` behavioral inconsistency

`generate_image` waits up to 120s + downloads images. `generate_with_controlnet` and `generate_with_ip_adapter` return `prompt_id` immediately with no wait/download. An agent that learns the "generate" pattern from one tool cannot predict the other's behavior.

**Proposed fix:** Add `wait: boolean` parameter to conditioned tools, consistent with `generate_image`.

---

### 14. `modify_workflow` per-operation documentation gap

**File:** `src/tools/workflow-compose.ts`

The tool description lists 5 operation types but does NOT document the required fields for each. The Zod schema validates them, but the agent must infer fields from the operation name alone. `insert_between` has 6 required fields (`source_id`, `output_index`, `target_id`, `input_name`, `new_class_type`, `new_inputs`) — an agent that guesses wrong gets confusing deep errors.

**Proposed fix:** Document each operation's required fields in the tool description, or add examples of each operation type.

---

### 15. `list_workflows` returns plain text, not JSON array

**File:** `src/tools/workflow-library.ts`

Returns `"Found 3 workflows:\n\n1. foo.json\n2. bar.json\n3. baz.json"` — the agent must regex-parse filenames from a numbered markdown list. If a filename contains a number and dot (e.g. `v2.final.json`), parsing is ambiguous.

**Proposed fix:** Add `format: "json"` option that returns `{ files: [{name: "foo.json"}] }`.

---

## Classification Summary

| Severity | Count | Examples |
|----------|-------|---------|
| 🚨 Critical | 5 | Seed randomization, auto-select model, inconsistent checkpointing, opaque defaults, no Remix tool |
| 🔴 High | 5 | Unstructured text (38/50), `search_models` dead end, `save_workflow` overwrite, doc mismatch, double-randomize |
| 🟡 Medium | 5 | Context flood, history format, behavioral inconsistency, op docs gap, text-only list |

---

## Recommended Priority Order

### Phase 1 — Docstring & Default Changes (Low Effort, High Impact)
1. Flip seed randomization default (#1)
2. Fix `get_image` `save_dir` docstring (#9)
3. Fix `search_models` description — remove false URL promise (#7)
4. Add `create_workflow` defaults to tool description (#4)
5. Add auto-selection warning to `generate_with_*` docstrings (#2 partial)

### Phase 2 — Backward-Compatible Additions (Medium Effort)
6. Add `format: "json"` to text-returning tools (#6, #15)
7. Add `overwrite: boolean` to `save_workflow` (#8)
8. Add `wait: boolean` to `generate_with_*` (#13)

### Phase 3 — New Tool (Higher Effort)
9. Consider `remix_workflow` single-call tool (#5)

---

*Generated from audit of all `src/tools/*.ts` files — June 2026*
