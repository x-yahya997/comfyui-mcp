import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateImage } from "../services/generate-image.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { listLocalModels } from "../services/model-resolver.js";
import { DefaultsManager } from "../services/defaults-manager.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerGenerateImageTool(server: McpServer): void {
  server.tool(
    "generate_image",
    "Generate an image from a text prompt — the high-level entry point. Builds a txt2img workflow, " +
      "filling any unspecified parameter from your configured defaults (set_defaults / COMFYUI_DEFAULT_* / config file). " +
      "REQUIRED: You MUST specify a `checkpoint` filename. If omitted, this tool will NOT auto-select one — " +
      "it returns the list of available models and asks you to choose. " +
      "Use list_local_models first to see what is installed, then pass the chosen filename as checkpoint. " +
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
                  note: "asset_id will be available in the completion notification; use view_image or regenerate with it.",
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
