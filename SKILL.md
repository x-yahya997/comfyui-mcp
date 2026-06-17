---
name: comfyui-image-generation
description: Guide for AI agents to generate images via comfyui-mcp — txt2img, img2img, ControlNet, IP-Adapter, upscale, and inpaint workflows
---

## MCP Tools First — Never Use CLI

comfyui-mcp is already installed and configured as an MCP server with 88+ tools covering image generation, workflow authoring, model management, queue control, and more.

**Every ComfyUI operation MUST be done through MCP tool calls.** Never suggest or run CLI commands (`comfyui-mcp --help`, `node dist/index.js`, etc.), curl requests, or manual scripts. Before acting, verify you have these MCP tools available in your toolset — if you see `list_local_models`, `enqueue_workflow`, `create_workflow`, etc., use them directly.

## Generation Protocol — Plan, Confirm, Verify

### 1. Always Create a Plan First — Get User Confirmation

Before calling ANY generation tool, create two separate planning files:

**File A — Workflow JSON (ComfyUI library):** Save the full API-format workflow to ComfyUI's user library via `save_workflow`. Use minimal placeholder prompts (e.g. `"<prompt>"`). This captures the node structure, model references, dimensions, sampler settings, and connections. The workflow JSON is the plan — no markdown wrapping needed.

**File B — Prompt Plan (`.plan/`):** Save a markdown file at `.plan/prompt-{topic}.md` containing ONLY prompt content. No workflow structure, no node IDs, no connection details. Focus entirely on prompt engineering:

```markdown
# Prompt Plan: {topic}

## Model
- Checkpoint: `model_name.safetensors`
- LoRAs: `lora_name.safetensors @ 0.8`

## Positive Prompt
Detailed subject description, environment, lighting, mood, camera angle, artistic style, colors, composition.

## Negative Prompt
Unwanted elements, quality tags, artifacts to avoid.

## Style Notes
Quality tags, LoRA trigger words, emphasis weighting strategy.
```

This separation forces deliberate effort on prompt quality — the part where agents most often fail by generating overly simplistic prompts.

**In Create mode**, still call `list_workflows` + `analyze_workflow` to study existing workflows for structural reference. Reading helps you learn node conventions, model naming patterns, and connection formats. The difference from Remix: don't copy+modify; build fresh but informed by examples.

Present both files (the saved workflow name + prompt plan) to the user and **wait for explicit confirmation** before executing any generation tool. Do not skip this step even for trivial requests.

### 2. Maintain a Live Todo Checklist

Create and update a todo list tracking every step of the generation pipeline:

- [ ] Check available models (`list_local_models`)
- [ ] Verify ComfyUI is reachable (`get_system_stats`)
- [ ] Confirm/upload any input media (`upload_image`)
- [ ] Write prompt plan to `.plan/prompt-{topic}.md`
- [ ] Save workflow JSON to ComfyUI library (`save_workflow`)
- [ ] Enqueue workflow (`enqueue_workflow` or `generate_image`)
- [ ] Monitor job completion (`get_job_status` / `get_history`)
- [ ] Download output files (`get_image` / `list_output_images`)
- [ ] Verify files exist on disk with non-zero size
- [ ] Present results to user

Mark each item `[x]` as it completes. This prevents skipped steps and gives you a clear recovery point if something fails.

### 3. Verify Files Exist — Not Just Directories

After every generation call:

- **Call `get_image` or `list_output_images` to confirm the file landed** — do not trust directory creation alone
- Check that the file has non-zero size (zero-byte files indicate a silent failure)
- If the file is missing or zero bytes, immediately call `get_history(prompt_id)` to check for execution errors or Python tracebacks
- Only report success when you have confirmed the actual image bytes are available

Empty output directories are a known failure mode — ComfyUI can report success before writing finishes, or the workflow may fail silently at execution time. Always verify the byte-level result.

# Image Generation with comfyui-mcp

## Overview

comfyui-mcp exposes ComfyUI's image generation capabilities as MCP tools. The typical flow:

1. **Know your models** — check what's installed (`list_local_models`) or download what's needed (`search_models` + `download_model`)
2. **Build or select a workflow** — use `create_workflow` (templates) or craft raw API-format JSON
3. **Enqueue** — submit via `enqueue_workflow` (returns `prompt_id` immediately)
4. **Monitor** — use `get_job_status` to poll, or `get_history` after completion
5. **Retrieve** — download results with `get_image` / `list_output_images`

Two approaches exist: the high-level `generate_image` (auto-builds + polls) or the manual `create_workflow` + `enqueue_workflow` path (full control).

## MCP Tool Reference

### High-Level Generation

| Tool | Purpose |
|------|---------|
| `generate_image` | End-to-end txt2img: builds workflow, enqueues, polls up to 120s, auto-downloads result. Specify `checkpoint` (required if no default set). |
| `generate_with_controlnet` | ControlNet-conditioned generation (pose, depth, canny, etc.). Requires pre-uploaded control image + ControlNet model. |
| `generate_with_ip_adapter` | Style/subject transfer from a reference image via IP-Adapter. Requires `ComfyUI_IPAdapter_plus` custom nodes. |

### Workflow Authoring

| Tool | Purpose |
|------|---------|
| `create_workflow` | Build a workflow from a template: `txt2img`, `img2img`, `upscale`, `inpaint`, `controlnet`, `ip_adapter`. Pass `params` to set checkpoint, prompt, dimensions, sampler settings. |
| `modify_workflow` | Apply operations on an existing workflow: `set_input`, `add_node`, `remove_node`, `connect`, `insert_between`. Chain multiple ops in one call. |
| `enqueue_workflow` | Submit any API-format workflow JSON for execution. Returns `prompt_id` immediately. Randomizes seeds by default; set `disable_random_seed: true` to keep them. |
| `get_node_info` | Query `/object_info` for installed node type definitions, inputs, outputs, and categories. |

### Image I/O

| Tool | Purpose |
|------|---------|
| `upload_image` | Upload a local image file to ComfyUI's `input/` directory. Required before using images in `LoadImage` nodes. |
| `upload_video` | Upload video files (.mp4, .mov, .webm) for video-loading nodes. |
| `upload_audio` | Upload audio files (.wav, .mp3, .flac) for audio-conditioned workflows. |
| `get_image` | Fetch a generated image from ComfyUI by filename. Returns inline image data. Use `get_history` first to find filenames. |
| `list_output_images` | List recently generated images from the local `output/` directory (requires `COMFYUI_PATH`). |
| `convert_image` | Re-encode a generated image to PNG, JPEG, or WebP with quality/effort controls. |
| `workflow_from_image` | Extract embedded workflow metadata from any ComfyUI-generated PNG (both API and UI formats). |

### Model Discovery & Download

| Tool | Purpose |
|------|---------|
| `list_local_models` | List installed models by type (`checkpoints`, `diffusion_models`, `controlnet`, `loras`, `vae`, `upscale_models`). |
| `search_models` | Search HuggingFace for models by query. Returns download URLs and metadata. |
| `download_model` | Download a model from a URL to ComfyUI's models directory. Supports HTTP, S3, Azure. |
| `download_civitai_model` | Download a model from CivitAI by model ID or version ID. |
| `remove_model` | Delete a model file from the models directory. |

### Queue & Monitoring

| Tool | Purpose |
|------|---------|
| `get_queue` | View the current queue — running job + pending jobs. |
| `get_job_status` | Check a specific job's status by `prompt_id`. Returns `running`, `pending`, `done` booleans plus `execution_stats` on completion. |
| `cancel_job` | Interrupt the currently running job. |
| `cancel_queued_job` | Remove a specific pending job from the queue by `prompt_id`. |
| `clear_queue` | Remove all pending jobs (does not affect the running job). |
| `get_system_stats` | GPU device(s), VRAM, ComfyUI/Python/PyTorch versions, OS details. |
| `get_history` | Execution history with output filenames and error details. |

### Defaults & Environment

| Tool | Purpose |
|------|---------|
| `get_defaults` | View current merged defaults (config file + env + runtime overrides). |
| `set_defaults` | Persist a default value (e.g. `checkpoint`, `sampler`, `steps`, `cfg`). These backfill any omitted parameter in `generate_image` and the conditioned generation tools. |

## Pipeline Architecture

### Data Types

ComfyUI nodes pass typed data through connections:

| Type | Description |
|------|-------------|
| `MODEL` | Diffusion model weights (CheckpointLoaderSimple output 0) |
| `CLIP` | Text encoder (output 1) |
| `VAE` | Variational autoencoder (output 2) |
| `CONDITIONING` | Encoded text prompt (CLIPTextEncode output 0) |
| `LATENT` | Latent space tensor (EmptyLatentImage, KSampler, VAEEncode) |
| `IMAGE` | Pixel image tensor BHWC (VAEDecode, LoadImage) |
| `MASK` | Single-channel mask (LoadImage output 1) |

### Standard txt2img Pipeline

```
CheckpointLoaderSimple ──┬── MODEL ──→ KSampler.model
                         ├── CLIP ───→ CLIPTextEncode.clip (×2: positive + negative)
                         └── VAE ────→ VAEDecode.vae

EmptyLatentImage ──→ LATENT ──→ KSampler.latent_image
KSampler ──→ LATENT ──→ VAEDecode.samples
VAEDecode ──→ IMAGE ──→ SaveImage.images
```

The standard 7-node ID layout: `1`=Checkpoint, `2`=Positive CLIP, `3`=Negative CLIP, `4`=EmptyLatent, `5`=KSampler, `6`=VAEDecode, `7`=SaveImage.

### Connection Format

Connections are arrays: `["sourceNodeId", outputIndex]`. Node IDs are **strings**. Output indices are 0-based integers.

```json
"model": ["1", 0],
"clip": ["1", 1],
"vae": ["1", 2"],
"positive": ["2", 0],
"images": ["6", 0]
```

## Tool Usage Patterns

### Quick Generation (generate_image)

The simplest path — specify a prompt and checkpoint, get an image back:

```
generate_image({
  prompt: "a serene mountain lake at sunset",
  checkpoint: "sd_xl_base_1.0.safetensors",
  width: 1024,
  height: 1024,
  steps: 20,
  cfg: 7.5,
  sampler: "euler",
  scheduler: "normal"
})
```

The tool auto-builds a txt2img workflow, enqueues it, polls for completion (up to 120s), downloads the image, and returns it inline. Set `wait: false` to fire-and-forget and retrieve results later.

**If checkpoint is omitted** and no default is configured, the tool returns the list of available models and asks you to choose. Always check first with `list_local_models("checkpoints")` and `list_local_models("diffusion_models")`.

Conditioned generation tools `generate_with_controlnet` and `generate_with_ip_adapter` follow the same pattern but require pre-uploaded reference images. Upload first with `upload_image`, then pass the returned filename.

### Custom Workflow Authoring

For full control over the node graph, use the manual path:

1. **Create from template**:
   ```
   create_workflow({
     template: "txt2img",
     params: {
       checkpoint: "sd_xl_base_1.0.safetensors",
       positive_prompt: "a cat",
       width: 1024,
       height: 1024
     }
   })
   ```
   Returns the full API-format workflow JSON.

2. **Modify** — add a LoRA loader, swap the sampler, insert a ControlNet:
   ```
   modify_workflow({
     workflow: "<workflow from step 1>",
     operations: [
       { op: "set_input", node_id: "5", input_name: "steps", value: 30 },
       {
         op: "add_node",
         class_type: "LoraLoaderModelOnly",
         inputs: { model: ["1", 0], lora_name: "my_lora.safetensors", strength_model: 0.8 }
       }
     ]
   })
   ```
   Supported operations: `set_input`, `add_node`, `remove_node`, `connect`, `insert_between`.

3. **Enqueue**:
   ```
   enqueue_workflow({ workflow: <modified workflow JSON> })
   ```
   Returns `prompt_id` and `queue_remaining`.

4. **Retrieve** — poll with `get_job_status(prompt_id)` until done, then `get_history(prompt_id)` for output filenames, then `get_image(filename)` for the actual image.

### Uploading Input Media

Before using images in `LoadImage` nodes, upload them:

```
upload_image({ source_path: "/absolute/path/to/my_image.png" })
```

Returns the stored filename. Use this filename as the `image` input in `LoadImage` nodes within your workflow.

### Reverse Engineering Existing Images

Any ComfyUI-generated PNG has its workflow embedded in metadata:

```
workflow_from_image({ image_path: "/path/to/output.png" })
```

Returns both API format (executable workflow) and UI format (with layout data). Use this to understand how any image was made, or to re-enqueue with modifications.

### Model Discovery Flow

Never assume a model exists. Follow this pattern:

1. `list_local_models("checkpoints")` — see what's installed
2. If the desired model is missing:
   - `search_models({ query: "SDXL base", type: "checkpoint" })` — find on HuggingFace
   - `download_model({ url: "...", type: "checkpoints" })` — install it
3. Alternatively for community models: `download_civitai_model({ model_id: 12345 })`

## Sampler Settings Reference

| Sampler | Scheduler | Use Case |
|---------|-----------|----------|
| `euler` | `normal` | General purpose, good quality-speed balance |
| `euler` | `karras` | Slightly sharper, more contrast |
| `euler_ancestral` | `normal` | More creative/varied outputs (adds noise each step) |
| `dpmpp_2m` | `normal` | High quality, popular for SDXL |
| `dpmpp_2m` | `karras` | Sharper details, recommended for many models |
| `dpmpp_2m_sde` | `karras` | Very high quality, slower |
| `dpmpp_sde` | `karras` | Good for detailed textures |
| `ddim` | `normal` | Deterministic, fewer steps needed |
| `lcm` | `sgm_uniform` | Fast (1-4 steps) with LCM/LoRA |
| `ipndm` | `beta` | Flux SRPO author-recommended |

### Steps by Model Family

| Model Type | Steps | Notes |
|------------|-------|-------|
| SD 1.5 / SDXL | 20–30 | Standard quality |
| Turbo / Lightning | 4–8 | Distilled models, fast |
| LCM | 1–4 | Requires LCM LoRA or LCM sampler |
| Flux (distilled) | 4 | Klein 9B, Turbo LoRA |
| Flux (full) | 20–28 | SRPO, standard quality |

### CFG by Model Family

| Model | CFG | Notes |
|-------|-----|-------|
| SD 1.5 | 7.0–9.0 | 7.0 for realism, 9.0 for stylized |
| SDXL | 5.0–8.0 | 5.0 for photorealism, 7.5 default |
| Flux | **1.0** | Always 1.0 — guidance via `FluxGuidance` or `CLIPTextEncodeFlux` |
| Turbo / Lightning | 1.5–3.5 | Lower CFG for distilled models |

## Common Workflow Templates

### txt2img

```json
{
  "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "sd_xl_base_1.0.safetensors" } },
  "2": { "class_type": "CLIPTextEncode", "inputs": { "text": "a serene mountain lake", "clip": ["1", 1] }, "_meta": { "title": "Positive" } },
  "3": { "class_type": "CLIPTextEncode", "inputs": { "text": "blurry, low quality", "clip": ["1", 1] }, "_meta": { "title": "Negative" } },
  "4": { "class_type": "EmptyLatentImage", "inputs": { "width": 1024, "height": 1024, "batch_size": 1 } },
  "5": { "class_type": "KSampler", "inputs": { "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0], "seed": 42, "steps": 20, "cfg": 8, "sampler_name": "euler", "scheduler": "normal", "denoise": 1 } },
  "6": { "class_type": "VAEDecode", "inputs": { "samples": ["5", 0], "vae": ["1", 2] } },
  "7": { "class_type": "SaveImage", "inputs": { "images": ["6", 0], "filename_prefix": "ComfyUI" } }
}
```

### img2img

```json
{
  "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "sd_xl_base_1.0.safetensors" } },
  "2": { "class_type": "LoadImage", "inputs": { "image": "input.png" } },
  "3": { "class_type": "VAEEncode", "inputs": { "pixels": ["2", 0], "vae": ["1", 2] } },
  "4": { "class_type": "CLIPTextEncode", "inputs": { "text": "turn this into a painting", "clip": ["1", 1] }, "_meta": { "title": "Positive" } },
  "5": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["1", 1] }, "_meta": { "title": "Negative" } },
  "6": { "class_type": "KSampler", "inputs": { "model": ["1", 0], "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["3", 0], "seed": 42, "steps": 20, "cfg": 8, "sampler_name": "euler", "scheduler": "normal", "denoise": 0.75 } },
  "7": { "class_type": "VAEDecode", "inputs": { "samples": ["6", 0], "vae": ["1", 2] } },
  "8": { "class_type": "SaveImage", "inputs": { "images": ["7", 0], "filename_prefix": "ComfyUI" } }
}
```

**Key difference**: Replace `EmptyLatentImage` with `LoadImage` + `VAEEncode`. Lower `denoise` (0.5–0.8) stays closer to the original.

### Upscale

```json
{
  "1": { "class_type": "LoadImage", "inputs": { "image": "input.png" } },
  "2": { "class_type": "UpscaleModelLoader", "inputs": { "model_name": "RealESRGAN_x4plus.pth" } },
  "3": { "class_type": "ImageUpscaleWithModel", "inputs": { "upscale_model": ["2", 0], "image": ["1", 0] } },
  "4": { "class_type": "SaveImage", "inputs": { "images": ["3", 0], "filename_prefix": "ComfyUI_upscale" } }
}
```

### Inpaint

```json
{
  "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "sd_xl_base_1.0.safetensors" } },
  "2": { "class_type": "LoadImage", "inputs": { "image": "input.png" }, "_meta": { "title": "Input" } },
  "3": { "class_type": "LoadImage", "inputs": { "image": "mask.png" }, "_meta": { "title": "Mask" } },
  "4": { "class_type": "VAEEncode", "inputs": { "pixels": ["2", 0], "vae": ["1", 2] } },
  "5": { "class_type": "SetLatentNoiseMask", "inputs": { "samples": ["4", 0], "mask": ["3", 1] } },
  "6": { "class_type": "CLIPTextEncode", "inputs": { "text": "a modern sofa", "clip": ["1", 1] }, "_meta": { "title": "Positive" } },
  "7": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["1", 1] }, "_meta": { "title": "Negative" } },
  "8": { "class_type": "KSampler", "inputs": { "model": ["1", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0], "seed": 42, "steps": 20, "cfg": 8, "sampler_name": "euler", "scheduler": "normal", "denoise": 0.85 } },
  "9": { "class_type": "VAEDecode", "inputs": { "samples": ["8", 0], "vae": ["1", 2] } },
  "10": { "class_type": "SaveImage", "inputs": { "images": ["9", 0], "filename_prefix": "ComfyUI_inpaint" } }
}
```

**Key**: Mask uses `LoadImage` output 1 (MASK, not IMAGE). Connect to `SetLatentNoiseMask.mask`. `denoise` of 0.85 balances coherence with prompt adherence.

## Standard Image Sizes

| Aspect | Resolution | Model |
|--------|------------|-------|
| Square | 1024×1024 | SDXL, Flux, SD3 |
| Portrait | 896×1152 | SDXL, Flux |
| Landscape | 1152×896 | SDXL, Flux |
| 16:9 Landscape | 1344×768 | SDXL, Flux |
| 9:16 Portrait | 768×1344 | SDXL, Flux |
| SD 1.5 Square | 512×512 | SD 1.5 base |

Dimensions should be multiples of 8 (ideally 64 for SDXL/Flux).

## Tips & Gotchas

1. **Node IDs are strings** — `"1"`, `"2"`, not `1`, `2`. The connection format is `["sourceId", outputIndex]`.

2. **API format vs UI format** — All MCP tools expect the compact API format (`{"1": {class_type, inputs}}`), NOT the web UI format (`{"nodes": [...], "links": [...]}`). Use `get_workflow` with `format="api"` to auto-convert.

3. **Seed handling** — `enqueue_workflow` randomizes all seed values by default. Set `disable_random_seed: true` to preserve your explicit seeds.

4. **VRAM management** — Switch between model families clears VRAM automatically in some cases, but call `clear_vram` explicitly when going from Flux → SDXL or similar large transitions.

5. **Model auto-detection** — `generate_image` does NOT auto-select a checkpoint. It returns the available list and asks you to choose. Use `set_defaults({ checkpoint: "..." })` to set a permanent default.

6. **Checkpoint vs diffusion_models** — Models may appear under `checkpoints` (older format) or `diffusion_models` (newer). Check both directories with `list_local_models`.

7. **Enqueue is fire-and-forget** — `enqueue_workflow` returns immediately. Poll `get_job_status` or `get_history` to track completion. `generate_image` handles this automatically with a 120s timeout.

8. **Negative prompts are model-specific** — SDXL/SD 1.5 use standard negative prompts. Flux does not support traditional negatives — use `ConditioningZeroOut` instead.

9. **ComfyUI must be running** — All tools that contact ComfyUI will error if the server is unreachable. Use `get_system_stats` as a connectivity check.

10. **Always list models first** — Before building a workflow that references a model, confirm it exists with `list_local_models`. Download missing models proactively rather than asking the user.

11. **Always verify output files on disk** — MCP tools can return success before ComfyUI finishes writing. After any generation, confirm the file exists with `get_image` or `list_output_images` and check it has non-zero size. Empty output directories = silent failure. Call `get_history` to diagnose.
