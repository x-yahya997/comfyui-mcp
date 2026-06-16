import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateImage } from "../services/generate-image.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { listLocalModels } from "../services/model-resolver.js";
import { DefaultsManager } from "../services/defaults-manager.js";
import { getOutputImage } from "../services/image-management.js";
import { getHistory } from "../comfyui/client.js";
import { errorToToolResult } from "../utils/errors.js";

/** Max ms to poll for completion before falling back to fire-and-forget. */
function generatePollTimeoutMs(): number {
  const raw = Number(process.env.COMFYUI_GENERATE_WAIT_S ?? "120");
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : 120_000;
}

const GENERATE_POLL_MS = 2_000;

export function registerGenerateImageTool(server: McpServer): void {
  server.tool(
    "generate_image",
    "Generate an image from a text prompt — the high-level entry point. " +
      "Builds a txt2img workflow, filling any unspecified parameter from your configured defaults. " +
      "REQUIRED: You MUST specify a `checkpoint` filename. If omitted, this tool will NOT auto-select one — " +
      "it returns the list of available models and asks you to choose. " +
      "After enqueuing, waits up to 120s (configurable via COMFYUI_GENERATE_WAIT_S) for the job to complete " +
      "and automatically downloads the result to `save_dir` (default: ./outputs/). " +
      "Set `wait: false` to return immediately without downloading. " +
      "For full control over the node graph, use create_workflow + enqueue_workflow instead.",
    {
      prompt: z.string().describe("Positive text prompt"),
      negative_prompt: z.string().optional().describe("Negative prompt (default: empty / from defaults)"),
      width: z.number().int().positive().optional().describe("Image width"),
      height: z.number().int().positive().optional().describe("Image height"),
      steps: z.number().int().positive().optional().describe("Sampling steps"),
      cfg: z.number().positive().optional().describe("CFG scale"),
      sampler: z.string().optional().describe("Sampler name (e.g. euler, dpmpp_2m)"),
      scheduler: z.string().optional().describe("Scheduler (e.g. normal, karras)"),
      seed: z.number().int().optional().describe("Seed (omit to randomize)"),
      checkpoint: z
        .string()
        .optional()
        .describe("Checkpoint filename (required — use list_local_models to see available options, then pass the chosen filename here)"),
      batch_size: z.number().int().positive().optional().describe("Number of images to generate"),
      save_dir: z
        .string()
        .optional()
        .describe("Local directory to save generated images (default: ./outputs/)"),
      wait: z
        .boolean()
        .optional()
        .default(true)
        .describe("If true (default), wait up to 120s for completion and auto-download results"),
    },
    async (args) => {
      // If no checkpoint is given and no default is configured, list available
      // models and ask the user to pick one — never auto-select blindly.
      if (!args.checkpoint && !DefaultsManager.get("checkpoint")) {
        const [checkpoints, diffModels] = await Promise.all([
          listLocalModels("checkpoints").catch(() => []),
          listLocalModels("diffusion_models").catch(() => []),
        ]);

        if (checkpoints.length === 0 && diffModels.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No models found. Use `download_model` or `search_models` to install one first, "
                + "or set a default checkpoint via `set_defaults({ checkpoint: \"...\" })`.",
            }],
          };
        }

        const parts: string[] = [];
        if (checkpoints.length > 0) {
          parts.push("**Checkpoints:**\n" + checkpoints.map(m => `- \`${m.name}\``).join("\n"));
        }
        if (diffModels.length > 0) {
          parts.push("**Diffusion models:**\n" + diffModels.map(m => `- \`${m.name}\``).join("\n"));
        }

        return {
          content: [{
            type: "text",
            text: "No checkpoint was specified. I found these models available — which one should I use?\n\n"
              + parts.join("\n\n")
              + "\n\nCall `generate_image` again with the `checkpoint` parameter set to your choice, "
              + "or set a default via `set_defaults({ checkpoint: \"...\" })`.",
          }],
        };
      }

      try {
        const result = await generateImage(args, {
          resolveCheckpoint: async () => undefined,
          enqueue: (workflow) => enqueueWorkflow(workflow),
        });

        // Fire-and-forget mode: return immediately without waiting
        if (!args.wait) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    status: "enqueued",
                    prompt_id: result.prompt_id,
                    queue_remaining: result.queue_remaining,
                    checkpoint: result.checkpoint,
                    note: "Waiting disabled. Use get_job_status to check progress, then get_history + get_image to retrieve files.",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // ── Poll for completion ──────────────────────────────────────────
        const maxWaitMs = generatePollTimeoutMs();
        const started = Date.now();
        let lastEntry: unknown = null;

        while (Date.now() - started < maxWaitMs) {
          await new Promise((r) => setTimeout(r, GENERATE_POLL_MS));
          try {
            const history = await getHistory(result.prompt_id);
            const entry = history[result.prompt_id];
            if (entry?.status?.completed) {
              lastEntry = entry;
              break;
            }
          } catch {
            // Transient fetch error — retry next cycle
          }
        }

        // ── Completion: download and save images ─────────────────────────
        if (lastEntry) {
          const entry = lastEntry as {
            outputs?: Record<string, unknown>;
            status?: { status_str?: string; completed?: boolean };
          };

          // Extract output images from history
          const images: Array<{ filename: string; subfolder: string; type: string }> = [];
          if (entry.outputs) {
            for (const nodeOutput of Object.values(entry.outputs)) {
              if (nodeOutput && typeof nodeOutput === "object") {
                const raw = nodeOutput as Record<string, unknown>;
                const rawImages = raw.images;
                if (Array.isArray(rawImages)) {
                  for (const img of rawImages) {
                    if (img && typeof img === "object") {
                      const rec = img as Record<string, unknown>;
                      images.push({
                        filename: String(rec.filename ?? ""),
                        subfolder: String(rec.subfolder ?? ""),
                        type: String(rec.type ?? "output"),
                      });
                    }
                  }
                }
              }
            }
          }

          if (images.length > 0) {
            const saveDir = args.save_dir ?? join(process.cwd(), "outputs");
            await mkdir(saveDir, { recursive: true });
            const savedFiles: string[] = [];
            const inlineImages: Array<{ type: "image"; data: string; mimeType: string }> = [];

            for (const img of images) {
              try {
                const { base64, mimeType } = await getOutputImage(
                  img.filename,
                  img.type as "output" | "input" | "temp",
                  img.subfolder,
                );
                const localPath = join(saveDir, basename(img.filename));
                await writeFile(localPath, Buffer.from(base64, "base64"));
                savedFiles.push(localPath);
                inlineImages.push({ type: "image", data: base64, mimeType });
              } catch {
                // Skip individual image that fails to download
              }
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      status: "completed",
                      prompt_id: result.prompt_id,
                      files: savedFiles,
                      checkpoint: result.checkpoint,
                    },
                    null,
                    2,
                  ),
                },
                ...inlineImages,
              ],
            };
          }

          // Completed but no output images
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    status: "completed",
                    prompt_id: result.prompt_id,
                    files: [],
                    checkpoint: result.checkpoint,
                    note: "Job finished but produced no output images.",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // ── Timeout fallback ─────────────────────────────────────────────
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "enqueued",
                  prompt_id: result.prompt_id,
                  queue_remaining: result.queue_remaining,
                  checkpoint: result.checkpoint,
                  note: "Still running. Call get_job_status to check progress, then get_history + get_image to retrieve files.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
