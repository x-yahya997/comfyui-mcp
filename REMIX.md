---
name: comfyui-workflow-remix
description: Default agent behavior for comfyui-mcp — remix existing workflows instead of creating from scratch. Only Create when explicitly told to.
---

## MCP Tools First — Never Use CLI

comfyui-mcp is already installed and configured as an MCP server with 88+ tools covering image generation, workflow authoring, model management, queue control, and more.

**Every ComfyUI operation MUST be done through MCP tool calls.** Never suggest or run CLI commands (`comfyui-mcp --help`, `node dist/index.js`, etc.), curl requests, or manual scripts. Before acting, verify you have these MCP tools available in your toolset — if you see `list_local_models`, `enqueue_workflow`, `create_workflow`, etc., use them directly.

# Workflow Remix — Default Agent Behavior

## The Remix Rule

**By default, do NOT create new workflows from scratch.** Instead:

1. Search your workspace's workflow library first with `list_workflows`
2. Use `analyze_workflow` to understand the closest match
3. Remix it via `get_workflow` + `modify_workflow`
4. Save the result with `save_workflow`, then `enqueue_workflow`

Only reach for `create_workflow` or raw JSON when:
- The user explicitly says **"Create"**, "from scratch", or "new workflow"
- No saved workflow is remotely close to the request (and you've asked the user first)

## The Two Modes

| Mode | When to Use | Flow |
|------|-------------|------|
| **Remix** (default) | User says "generate an image", "make a portrait", "turn this into a painting", or any general request | `list_workflows` → `analyze_workflow` → pick closest → `get_workflow` + `modify_workflow` → `save_workflow` + `enqueue_workflow` |
| **Create** (explicit) | User says **"Create a workflow"**, **"from scratch"**, **"new workflow"** | `create_workflow(template, params)` or hand-crafted API-format JSON → `enqueue_workflow` |

Never default to Create. Always remix first.

## Remix Flow

### Step 1: Discover saved workflows

```
list_workflows()
```

Returns filenames of all saved workflows in ComfyUI's user library. If the list is empty, there's nothing to remix — ask the user if they want to Create one.

### Step 2: Analyze candidates

```
analyze_workflow({ filename: "my_workflow.json" })
```

Returns a structured text summary: node IDs grouped by section (loading, conditioning, sampling, image, output), key settings (model, dimensions, sampler, scheduler), virtual wires, and connection graph. No raw JSON — just what you need to compare against the user's request.

Run `analyze_workflow` on promising candidates until you find the closest match.

### Step 3: Identify the closest match

Compare each candidate against the user's request. Consider:
- **Model family** — same checkpoint type? (SDXL vs Flux vs SD 1.5)
- **Pipeline shape** — txt2img vs img2img vs upscale vs inpaint?
- **Special features** — has ControlNet? LoRA loaders? API nodes?
- **Output type** — image vs video?

Pick the one with the most overlap. If none are close, ask the user: "I found these saved workflows — none closely match your request. Should I Create one from scratch, or remix the closest one anyway?"

### Step 4: Remix it

```
get_workflow({ filename: "closest_match.json" })
```

Returns the raw API-format JSON. Now remix it with `modify_workflow`:

```
modify_workflow({
  workflow: <workflow JSON>,
  operations: [
    { op: "set_input", node_id: "5", input_name: "steps", value: 30 },
    { op: "set_input", node_id: "4", input_name: "width", value: 896 },
    { op: "set_input", node_id: "4", input_name: "height", value: 1152 },
    { op: "set_input", node_id: "2", input_name: "text", value: "the user's new prompt" },
    { op: "set_input", node_id: "3", input_name: "text", value: "negative prompt text" }
  ]
})
```

Chain multiple operations in one call — no need for separate `set_input` calls.

### Step 5: Save and execute

```
save_workflow({ filename: "remixed_portrait.json", workflow: <modified JSON> })
enqueue_workflow({ workflow: <modified JSON> })
```

Saving preserves the remix for future reuse. Next time, the saved remix will appear in `list_workflows`.

## Remix Operations Reference

| Operation | Purpose | Example |
|-----------|---------|---------|
| `set_input` | Change a widget value or swap a connection | Change prompt, model, seed, steps, dimensions, denoise |
| `add_node` | Insert a new node | Add a LoRA loader, attach a second KSampler, add an upscale pass |
| `remove_node` | Delete a node (auto-cleans dangling connections) | Remove a ControlNet group, strip an unneeded output node |
| `connect` | Wire two nodes together | Route LoRA-loaded model into KSampler |
| `insert_between` | Splice a node between two existing ones | Insert a ControlNet between existing CLIP and KSampler, insert a LoraLoader between Checkpoint and KSampler |

### Common Remix Patterns

**Swap model:**
```
{ op: "set_input", node_id: "1", input_name: "ckpt_name", value: "sd_xl_turbo.safetensors" }
```
Then also adjust KSampler steps + cfg for the new model family.

**Add a LoRA:**
```
{ op: "add_node", class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "style.safetensors", strength_model: 0.8 } }
{ op: "connect", source_id: "<new_lora_id>", output_index: 0, target_id: "5", input_name: "model" }
```

**Swap txt2img to img2img:**
```
{ op: "remove_node", node_id: "4" }
{ op: "add_node", class_type: "LoadImage", inputs: { image: "input.png" } }
{ op: "add_node", class_type: "VAEEncode", inputs: { pixels: ["<new_load_id>", 0], vae: ["1", 2] } }
{ op: "connect", source_id: "<new_vae_id>", output_index: 0, target_id: "5", input_name: "latent_image" }
{ op: "set_input", node_id: "5", input_name: "denoise", value: 0.75 }
```

**Change image dimensions:**
```
{ op: "set_input", node_id: "4", input_name: "width", value: 1344 }
{ op: "set_input", node_id: "4", input_name: "height", value: 768 }
```

Node `4` is `EmptyLatentImage` in the standard txt2img template layout.

## Decision Flow

```
User request arrives
  ↓
Is there at least one saved workflow?
  ├─ Yes → list_workflows + analyze_workflow each candidate
  │         ↓
  │         Does any closely match the request?
  │         ├─ Yes → Remix it (get + modify + save + enqueue)
  │         └─ No → Ask user: "No close match found. Create from scratch or remix closest?"
  │
  └─ No → Is user asking generically or explicitly saying "Create"?
            ├─ "Create" → create_workflow or raw JSON
            └─ Generic → "No saved workflows yet. Shall I Create one?"
```

## Anti-Patterns

❌ **Creating from scratch when a near-match exists** — Always remix first. Workflows encode model paths, node configurations, and connection patterns that are error-prone to rebuild.

❌ **Suggesting CLI commands or curl** — You are an MCP agent. You have direct tool access. Never tell the user to run `comfyui-mcp` commands, `curl http://localhost:8188`, or `node` scripts.

❌ **Modifying raw JSON directly** — Use `modify_workflow` with structured operations. It validates node existence, auto-assigns IDs, cleans up orphaned connections, and returns the new IDs of added nodes.

❌ **Re-creating a workflow you just saved** — After `save_workflow`, it appears in `list_workflows`. Next time, you can remix it further instead of rebuilding.

❌ **Not saving remixes** — Always `save_workflow` with a descriptive name. Saved remixes compound — each one becomes a starting point for future work, making the workflow library more valuable over time.

## Undoing Remixes

**Before you modify a workflow**, consider saving it first under a new name with `save_workflow`. This preserves the original as a fallback.

If you need to undo a remix that was already saved:
1. `list_workflows` to find the original (saved before the remix)
2. `get_workflow` to load the original
3. `save_workflow` to re-save it (or restore from backup)

There is no undo/rollback tool — versioning is done through named saves. Name your remixes semantically (`txt2img_portrait_sdxl.json`, `img2img_upscale_controlnet.json`) so they're easy to find later.
