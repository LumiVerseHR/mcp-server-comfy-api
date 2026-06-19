#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE_URL =
  process.env.COMFY_API_URL || "https://comfy-api.nichetide.com";
const API_KEY = process.env.COMFY_API_KEY || "";
const POLL_INTERVAL = 2000;
const POLL_TIMEOUT = 180000;

let seriesIdCache: number | null = null;

async function apiFetch(
  path: string,
  options?: RequestInit
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
    ...(options?.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res;
}

async function getApiGeneratedSeriesId(): Promise<number> {
  if (seriesIdCache !== null) return seriesIdCache;

  const res = await apiFetch("/series");
  const series: Array<{ id: number; name: string }> = await res.json();
  const existing = series.find((s) => s.name === "API_generated");
  if (existing) {
    seriesIdCache = existing.id;
    return seriesIdCache;
  }

  const createRes = await apiFetch("/series", {
    method: "POST",
    body: JSON.stringify({
      name: "API_generated",
      description: "Auto-created series for images generated via API/MCP",
      is_private: true,
    }),
  });
  const created: { id: number } = await createRes.json();
  seriesIdCache = created.id;
  return seriesIdCache;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const server = new McpServer({
  name: "comfy-api-zimage",
  version: "1.0.0",
});

server.registerTool(
  "generate_image",
  {
    title: "Generate Image",
    description:
      'Generate an image using z-image-turbo model. Submits a job and waits for completion (up to 3 min). Images go to the private "API_generated" series. Use get_prompt_guide for tips on writing effective prompts.',
    inputSchema: {
      prompt: z
        .string()
        .describe("Text description of the image to generate"),
      width: z
        .number()
        .int()
        .min(256)
        .max(2048)
        .default(1024)
        .describe("Image width in pixels (rounded to multiple of 16)"),
      height: z
        .number()
        .int()
        .min(256)
        .max(2048)
        .default(1024)
        .describe("Image height in pixels (rounded to multiple of 16)"),
      steps: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(9)
        .describe("Diffusion steps (9 recommended for turbo)"),
      cfg: z
        .number()
        .min(0)
        .max(20)
        .default(1.0)
        .describe("CFG scale (1.0 for turbo, it doesn't use CFG)"),
      seed: z
        .number()
        .int()
        .optional()
        .describe("Random seed for reproducibility. Omit for random."),
    },
  },
  async ({ prompt, width, height, steps, cfg, seed }) => {
    const seriesId = await getApiGeneratedSeriesId();

    const createRes = await apiFetch("/jobs", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        width,
        height,
        steps,
        cfg,
        seed: seed ?? null,
        priority: 5,
        series_id: seriesId,
      }),
    });
    const job: { job_id: string } = await createRes.json();
    const jobId = job.job_id;

    const start = Date.now();
    while (Date.now() - start < POLL_TIMEOUT) {
      const statusRes = await apiFetch(`/jobs/${jobId}`);
      const status: {
        status: string;
        images?: string[];
        seed?: number;
        error?: string;
        position?: number;
      } = await statusRes.json();

      if (status.status === "completed") {
        const images = status.images || [];
        const urls = images.map((img) => `${API_BASE_URL}/outputs/${img}`);
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "Image generated successfully!",
                `Job ID: ${jobId}`,
                `Status: completed`,
                `Images: ${images.join(", ")}`,
                `URLs: ${urls.join(", ")}`,
                `Seed: ${status.seed ?? "unknown"}`,
                `Series: API_generated (private)`,
                "",
                "Use download_image to save the image locally.",
              ].join("\n"),
            },
          ],
        };
      }

      if (status.status === "failed") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Generation failed!\nJob ID: ${jobId}\nError: ${status.error || "unknown"}`,
            },
          ],
        };
      }

      if (status.status === "cancelled") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Job was cancelled.\nJob ID: ${jobId}`,
            },
          ],
        };
      }

      await sleep(POLL_INTERVAL);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Job still in progress after ${POLL_TIMEOUT / 1000}s timeout.\nJob ID: ${jobId}\nUse get_job_status to check later.`,
        },
      ],
    };
  }
);

server.registerTool(
  "get_job_status",
  {
    title: "Get Job Status",
    description: "Check the status of an image generation job.",
    inputSchema: {
      job_id: z.string().describe("The job ID returned by generate_image"),
    },
  },
  async ({ job_id }) => {
    const res = await apiFetch(`/jobs/${job_id}`);
    const job: {
      status: string;
      images?: string[];
      seed?: number;
      error?: string;
      position?: number;
    } = await res.json();

    const lines = [`Job ID: ${job_id}`, `Status: ${job.status}`];

    if (job.status === "completed") {
      const images = job.images || [];
      const urls = images.map((img) => `${API_BASE_URL}/outputs/${img}`);
      lines.push(`Images: ${images.join(", ")}`);
      lines.push(`URLs: ${urls.join(", ")}`);
      lines.push(`Seed: ${job.seed ?? "unknown"}`);
    } else if (job.status === "failed") {
      lines.push(`Error: ${job.error || "unknown"}`);
    } else if (job.status === "pending" && job.position) {
      lines.push(`Queue position: ${job.position}`);
    } else if (job.status === "processing") {
      lines.push("Currently generating...");
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

server.registerTool(
  "download_image",
  {
    title: "Download Image",
    description:
      "Download a generated image and save it locally.",
    inputSchema: {
      filename: z
        .string()
        .describe(
          'Image filename from generate_image results (e.g. "job-abc12345_def67890.jpg")'
        ),
      save_path: z
        .string()
        .optional()
        .describe(
          "Local path to save the file. Defaults to current directory with original filename."
        ),
    },
  },
  async ({ filename, save_path }) => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname, resolve, join } = await import("node:path");

    const target = save_path || join(process.cwd(), filename);
    const absPath = resolve(target);
    await mkdir(dirname(absPath), { recursive: true });

    const res = await fetch(`${API_BASE_URL}/outputs/${filename}`, {
      headers: API_KEY ? { "X-API-Key": API_KEY } : {},
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(absPath, buffer);

    const sizeKb = (buffer.length / 1024).toFixed(1);
    return {
      content: [
        {
          type: "text" as const,
          text: `Image saved to: ${absPath} (${sizeKb} KB)`,
        },
      ],
    };
  }
);

server.registerTool(
  "remove_background",
  {
    title: "Remove Background",
    description:
      "Remove the background from a local image and save a transparent RGBA PNG. Sends the image to the ComfyUI API for background removal.",
    inputSchema: {
      image_path: z
        .string()
        .describe("Path to the local input image (PNG/JPG/WebP)"),
      output_path: z
        .string()
        .optional()
        .describe(
          'Where to save the result. Defaults to "<input>_nobg.png" next to the input.'
        ),
      model: z
        .enum([
          "u2net",
          "u2netp",
          "u2net_human_seg",
          "isnet-general-use",
          "isnet-anime",
          "silueta",
        ])
        .default("u2net")
        .describe(
          "Background-removal model: u2net (general), u2netp (lighter/faster), u2net_human_seg (people), isnet-general-use (higher quality), isnet-anime, silueta (portraits)"
        ),
      alpha_matting: z
        .boolean()
        .default(false)
        .describe("Enable alpha matting for cleaner edges (slower)"),
    },
  },
  async ({ image_path, output_path, model, alpha_matting }) => {
    const { readFile, writeFile, mkdir } = await import("node:fs/promises");
    const { dirname, resolve } = await import("node:path");

    const inputAbs = resolve(image_path);
    const imageB64 = (await readFile(inputAbs)).toString("base64");

    const outTarget =
      output_path || inputAbs.replace(/\.[^./\\]+$/, "") + "_nobg.png";
    const outAbs = resolve(outTarget);
    await mkdir(dirname(outAbs), { recursive: true });

    const res = await apiFetch("/api/rmbg/remove", {
      method: "POST",
      body: JSON.stringify({ image: imageB64, model, alpha_matting }),
    });
    const data: { image: string; inference_time_ms?: number } =
      await res.json();

    const b64 = data.image.replace(/^data:[^,]+,/, "");
    const buffer = Buffer.from(b64, "base64");
    await writeFile(outAbs, buffer);

    const sizeKb = (buffer.length / 1024).toFixed(1);
    return {
      content: [
        {
          type: "text" as const,
          text: [
            "Background removed!",
            `Input: ${inputAbs}`,
            `Output: ${outAbs} (${sizeKb} KB, model=${model})`,
            `Inference: ${(data.inference_time_ms ?? 0).toFixed(0)}ms`,
          ].join("\n"),
        },
      ],
    };
  }
);

server.registerTool(
  "get_prompt_guide",
  {
    title: "Get Prompt Guide",
    description:
      "Get the Z-Image Turbo prompt guide with tips for writing effective prompts. Includes structure, sections, quality constraints, and examples.",
    inputSchema: {},
  },
  async () => {
    const res = await apiFetch("/api/prompt-guide");
    const data: { guide: string } = await res.json();
    return { content: [{ type: "text" as const, text: data.guide }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("comfy-api-zimage MCP server started");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
