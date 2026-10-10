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
      'Generate an image and wait for it (up to 3 min). Goes to the private "API_generated" series. Three models, all guidance-distilled, so describe what you want rather than what you do not — a negative phrase conditions these toward the thing it names. z-image-turbo: fast, ~3s, the default. qwen-image-2.1: exact text rendering, transparent PNGs, ~16s. krea2-turbo: 12B, strong text and skin detail, ~9s. A cold model costs 10-30s to load; model_status shows what is already resident. Use get_prompt_guide for prompt tips.',
    inputSchema: {
      prompt: z
        .string()
        .describe("Text description of the image to generate"),
      model: z
        .enum(["z-image-turbo", "qwen-image-2.1", "krea2-turbo"])
        .default("z-image-turbo")
        .describe("Which model renders it"),
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
        .optional()
        .describe(
          "Diffusion steps. Omit to use the model's own default (9 / 25 / 8), which is almost always right."
        ),
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
  async ({ prompt, model, width, height, steps, cfg, seed }) => {
    const seriesId = await getApiGeneratedSeriesId();

    const createRes = await apiFetch("/jobs", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        model,
        width,
        height,
        // Sent only when chosen: omitted, the backend applies this model's default.
        ...(steps === undefined ? {} : { steps }),
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

const VIDEO_POLL_TIMEOUT = 900000; // video is minutes, not seconds

server.registerTool(
  "generate_video",
  {
    title: "Generate Video",
    description:
      'Animate an image that was already generated, and wait for it. Both models are image-to-video, so generate_image first and pass the job id it returns. minimax-h3: 12B, 24fps, generates its own soundtrack in the same pass, ~41 GB of VRAM, the default and the one that works. ltx-2: wants ~52 GB, which this machine often cannot free, so it may fail on arrival. Video takes minutes; check model_status first, since loading one of these evicts whatever is resident.',
    inputSchema: {
      prompt: z
        .string()
        .describe(
          "The motion to add. Describe what moves; the source image already settles how the scene looks."
        ),
      source_job_id: z
        .string()
        .describe("Job id of the image to animate, from generate_image"),
      model: z
        .enum(["minimax-h3", "ltx-2"])
        .default("minimax-h3")
        .describe("Which model renders it"),
      width: z
        .number()
        .int()
        .min(256)
        .max(1920)
        .default(960)
        .describe("Video width (a multiple of 32 for H3)"),
      height: z
        .number()
        .int()
        .min(256)
        .max(1080)
        .default(544)
        .describe("Video height (a multiple of 32 for H3)"),
      frames: z
        .number()
        .int()
        .min(9)
        .max(257)
        .default(124)
        .describe(
          "Frames at 24fps. H3 decodes 17n+5 and rounds up to the next valid count, between 5 and 15 seconds. 124 is ~5.2s."
        ),
      audio: z
        .boolean()
        .default(true)
        .describe(
          "Generate a soundtrack. H3 denoises audio alongside the picture, so turning this off does not save time; it produces a silent file."
        ),
    },
  },
  async ({ prompt, source_job_id, model, width, height, frames, audio }) => {
    const createRes = await apiFetch("/video/jobs", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        source_job_id,
        model,
        width,
        height,
        frames,
        audio,
        priority: 5,
      }),
    });
    const job: { job_id: string } = await createRes.json();
    const jobId = job.job_id;

    const start = Date.now();
    while (Date.now() - start < VIDEO_POLL_TIMEOUT) {
      const statusRes = await apiFetch(`/video/jobs/${jobId}`);
      const status: {
        status: string;
        video_filename?: string;
        error?: string;
      } = await statusRes.json();

      if (status.status === "completed") {
        const name = status.video_filename || "(see job)";
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "Video generated.",
                `Job ID: ${jobId}`,
                `Model: ${model}`,
                `File: ${name}`,
                `URL: ${API_BASE_URL}/video/download/${name}`,
                `Frames: ${frames} (~${(frames / 24).toFixed(1)}s at 24fps)`,
                audio ? "" : "Silent (audio disabled)",
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
        };
      }
      if (status.status === "failed") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Video generation failed.\nJob ID: ${jobId}\nError: ${status.error || "unknown"}`,
            },
          ],
        };
      }
      if (status.status === "cancelled") {
        return {
          content: [
            { type: "text" as const, text: `Job was cancelled.\nJob ID: ${jobId}` },
          ],
        };
      }
      await sleep(POLL_INTERVAL);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Still rendering after ${VIDEO_POLL_TIMEOUT / 1000}s.\nJob ID: ${jobId}\nCheck later with get_job_status.`,
        },
      ],
    };
  }
);

server.registerTool(
  "model_status",
  {
    title: "Model Status",
    description:
      "What is loaded on the GPU right now and how much room is left. Worth checking before a batch: a resident model starts immediately, a cold one pays a load first. Models unload themselves after 30 minutes idle, so this changes on its own.",
    inputSchema: {},
  },
  async () => {
    const res = await apiFetch("/models/status");
    const d: {
      gpu: { free_gb: number; total_gb: number };
      models: Array<{
        name: string;
        service: string;
        vram_gb: number | null;
        idle_seconds: number | null;
        in_use: boolean;
      }>;
      switchable: Array<{ id: string; loaded: boolean; estimated_gb: number | null }>;
      idle_unload_minutes: number;
    } = await res.json();

    const lines = [
      `GPU: ${d.gpu.free_gb} GB free of ${d.gpu.total_gb} GB`,
      "",
      "Image models:",
      ...d.switchable.map(
        (s) =>
          `  ${s.id.padEnd(16)} ${s.loaded ? "loaded" : `not loaded (~${s.estimated_gb} GB to load)`}`
      ),
    ];
    if (d.models.length) {
      lines.push("", `Resident (${d.models.length}):`);
      for (const m of d.models) {
        const idle = m.in_use ? "in use" : `idle ${m.idle_seconds}s`;
        lines.push(
          `  ${(m.name || "").padEnd(24)} ${m.vram_gb} GB  ${idle}  [${m.service}]`
        );
      }
    }
    lines.push("", `Unloaded automatically after ${d.idle_unload_minutes} min idle.`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
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

// --- Pipelines (callable node-graph workflows) ---

interface PipelineSummary {
  id: number;
  name: string;
}

async function resolvePipeline(pipeline: string): Promise<PipelineSummary> {
  const res = await apiFetch("/pipelines");
  const list: PipelineSummary[] = await res.json();
  const s = String(pipeline).trim();
  const found =
    (/^\d+$/.test(s) ? list.find((p) => p.id === Number(s)) : undefined) ??
    list.find((p) => p.name === s) ??
    list.find((p) => p.name.toLowerCase() === s.toLowerCase());
  if (!found) throw new Error(`pipeline not found: ${pipeline}`);
  return found;
}

server.registerTool(
  "list_pipelines",
  {
    title: "List Pipelines",
    description: "List saved pipelines (node-graph workflows) that can be run via run_pipeline.",
    inputSchema: {},
  },
  async () => {
    const res = await apiFetch("/pipelines");
    const list: PipelineSummary[] = await res.json();
    const text = list.length
      ? list.map((p) => `#${p.id}  ${p.name}`).join("\n")
      : "No saved pipelines.";
    return { content: [{ type: "text" as const, text }] };
  }
);

server.registerTool(
  "get_pipeline_params",
  {
    title: "Get Pipeline Parameters",
    description:
      "List a pipeline's parameters (name, type, default) so you know what inputs run_pipeline accepts.",
    inputSchema: { pipeline: z.string().describe("Pipeline name or numeric id") },
  },
  async ({ pipeline }) => {
    const { id, name } = await resolvePipeline(pipeline);
    const res = await apiFetch(`/pipelines/${id}/params`);
    const data: { params: Array<{ name: string; type: string; default?: unknown }> } =
      await res.json();
    const params = data.params ?? [];
    const text = params.length
      ? params
          .map(
            (p) =>
              `- ${p.name} (${p.type})${
                p.default != null && p.default !== "" ? ` default=${JSON.stringify(p.default)}` : ""
              }`
          )
          .join("\n")
      : "(no parameters)";
    return {
      content: [{ type: "text" as const, text: `Pipeline "${name}" (#${id}) parameters:\n${text}` }],
    };
  }
);

server.registerTool(
  "run_pipeline",
  {
    title: "Run Pipeline",
    description:
      "Run a saved pipeline with named inputs (text/number/image base64). Runs synchronously and returns the output image filename(s)/text. Use download_image(filename) to save an output image.",
    inputSchema: {
      pipeline: z.string().describe("Pipeline name or numeric id"),
      inputs: z
        .record(z.any())
        .optional()
        .describe('Parameter values, e.g. {"tile": "bathroom"} (see get_pipeline_params)'),
    },
  },
  async ({ pipeline, inputs }) => {
    const { id, name } = await resolvePipeline(pipeline);
    const res = await apiFetch(`/pipelines/${id}/run`, {
      method: "POST",
      body: JSON.stringify({ inputs: inputs ?? {}, wait: true }),
    });
    const data: {
      status: string;
      error?: string;
      outputs?: Array<{
        type?: string;
        status?: string;
        image?: string;
        video?: string;
        text?: string;
        error?: string;
      }>;
    } = await res.json();

    if (data.status !== "completed") {
      return {
        content: [
          { type: "text" as const, text: `Pipeline "${name}" run ${data.status}: ${data.error ?? "unknown error"}` },
        ],
      };
    }

    const lines = (data.outputs ?? []).map((o) => {
      if (o.image) return `image: ${o.image}  →  download_image("${o.image}")`;
      if (o.video) return `video: ${o.video}`;
      if (o.text != null) return `text: ${o.text}`;
      return `${o.type ?? "node"}: ${o.status ?? ""}`;
    });
    return {
      content: [
        {
          type: "text" as const,
          text: `Ran "${name}" (#${id}) — completed.\nOutputs:\n${lines.join("\n") || "(none)"}`,
        },
      ],
    };
  }
);

// ============== Blender ==============
// Scripts run headless on the workstation's Blender 4.2 (the blender service behind
// comfy-api), so a laptop with no Blender gets renders and 3D exports.

interface BlenderArtifact {
  name: string;
  size: number;
  url: string;
}

interface BlenderJob {
  job_id: string;
  status: string;
  title: string;
  run_status: string | null;
  duration: number | null;
  output: string | null;
  error: string | null;
  traceback: string | null;
  log_tail: string | null;
  artifacts: BlenderArtifact[];
  position: number | null;
}

const BLENDER_INLINE_IMAGE_MAX = 3 * 1024 * 1024;
const BLENDER_OUTPUT_TAIL = 6000;

async function fetchBlenderFile(a: BlenderArtifact): Promise<Buffer> {
  const res = await fetch(`${API_BASE_URL}${a.url}`, {
    headers: API_KEY ? { "X-API-Key": API_KEY } : {},
  });
  if (!res.ok) throw new Error(`Download of ${a.name} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function blenderResult(job: BlenderJob, saveDir?: string, returnImage = true) {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  > = [];
  const lines: string[] = [];

  if (job.status === "pending" || job.status === "processing") {
    lines.push(
      `Blender job ${job.job_id} is ${job.status}${job.position ? ` (queue #${job.position})` : ""}.`,
      "Check again with blender_job_status."
    );
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }

  const ok = job.status === "completed";
  lines.push(
    `${ok ? "OK" : job.run_status === "timeout" ? "TIMEOUT" : "ERROR"} — Blender job ${job.job_id}` +
      (job.duration != null ? ` (${job.duration.toFixed(1)}s)` : "")
  );
  if (job.error) lines.push(`Error: ${job.error}`);
  if (job.traceback) lines.push("", "Traceback:", job.traceback.trimEnd());
  if (!job.traceback && job.log_tail) lines.push("", "Blender log (tail):", job.log_tail.trimEnd());
  if (job.output) {
    const out = job.output.length > BLENDER_OUTPUT_TAIL
      ? "…" + job.output.slice(-BLENDER_OUTPUT_TAIL)
      : job.output;
    lines.push("", "Output:", out.trimEnd());
  }

  if (job.artifacts.length) {
    lines.push("", "Files:");
    let saved: string | null = null;
    if (saveDir) {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { resolve, join, dirname } = await import("node:path");
      saved = resolve(saveDir);
      for (const a of job.artifacts) {
        const target = join(saved, a.name);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await fetchBlenderFile(a));
      }
    }
    for (const a of job.artifacts) {
      lines.push(`  ${a.name} (${(a.size / 1024).toFixed(0)} KB)  ${API_BASE_URL}${a.url}`);
    }
    if (saved) lines.push(`Saved to ${saved}`);
  }

  content.push({ type: "text", text: lines.join("\n") });

  // Showing the render back is what lets the model judge and improve it.
  const image = returnImage
    ? job.artifacts.find((a) => /\.(png|jpe?g|webp)$/i.test(a.name) && a.size <= BLENDER_INLINE_IMAGE_MAX)
    : undefined;
  if (image) {
    const ext = image.name.split(".").pop()!.toLowerCase();
    const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    content.push({ type: "image", data: (await fetchBlenderFile(image)).toString("base64"), mimeType });
  }
  return { content };
}

server.registerTool(
  "blender_guide",
  {
    title: "Blender Guide",
    description:
      "The rules and the `bh` helper reference for blender_run scripts (Blender 4.2, headless, CPU). Read it once before writing your first Blender script in a session.",
    inputSchema: {},
  },
  async () => {
    const res = await apiFetch("/blender/guide");
    return { content: [{ type: "text" as const, text: await res.text() }] };
  }
);

server.registerTool(
  "blender_run",
  {
    title: "Run Blender Script",
    description: [
      "Run a Python (bpy) script in headless Blender 4.2 LTS on the workstation and wait for it. Returns prints, a traceback with your script's line numbers on failure, the files written, and the first render as an image so you can judge and refine it. Read blender_guide first.",
      "Each run is a fresh Blender with the factory scene; `bpy`, `bh`, `mathutils`, `math` are preloaded; relative paths become downloadable files; continue earlier work with bh.save() then bh.load('blender/<job_id>/scene.blend').",
      "Rules: (1) 4.x Principled names only (`Specular IOR Level`, `Transmission Weight`, `Emission Color`, `Coat Weight`…) — or use bh.material(color, roughness=, metallic=, transmission=, emission=…). (2) No viewport: view3d operators fail poll(); aim with bh.frame()/bh.look_at(). (3) CPU only: render with Cycles via bh.render(); EEVEE is ~20x slower here. (4) Always set samples (default would be 4096): 16–32 to iterate, 64–128 for finals.",
      "Quick product shot: build meshes → bh.studio() → bh.frame() → bh.render('render.png'). Cost ≈ 1s + render time.",
    ].join("\n"),
    inputSchema: {
      script: z.string().describe("Python source using bpy and bh"),
      timeout: z
        .number()
        .int()
        .min(5)
        .max(3600)
        .default(300)
        .describe("Seconds before the run is killed; partial prints are still returned"),
      title: z
        .string()
        .optional()
        .describe("Label shown on the comfy-api /blender page (default: the script's first # comment)"),
      save_dir: z
        .string()
        .optional()
        .describe("Local directory to download every produced file into"),
      return_image: z
        .boolean()
        .default(true)
        .describe("Attach the first rendered image (≤3 MB) to the result"),
    },
  },
  async ({ script, timeout, title, save_dir, return_image }) => {
    const createRes = await apiFetch("/blender/jobs", {
      method: "POST",
      body: JSON.stringify({ script, timeout, title, source: "mcp" }),
    });
    let job: BlenderJob = await createRes.json();
    // Wait out the script's own timeout plus queueing slack, then hand back the job id.
    const deadline = Date.now() + Math.min(timeout * 1000 + 120000, VIDEO_POLL_TIMEOUT);
    while ((job.status === "pending" || job.status === "processing") && Date.now() < deadline) {
      await sleep(job.status === "pending" ? POLL_INTERVAL : 1000);
      job = await (await apiFetch(`/blender/jobs/${job.job_id}`)).json();
    }
    return blenderResult(job, save_dir, return_image);
  }
);

server.registerTool(
  "blender_job_status",
  {
    title: "Blender Job Status",
    description:
      "Result of a Blender job by id — for a long render blender_run stopped waiting on, or to re-download files.",
    inputSchema: {
      job_id: z.string().describe('Blender job id, e.g. "bl-12decade0073"'),
      save_dir: z.string().optional().describe("Local directory to download the job's files into"),
      return_image: z.boolean().default(true).describe("Attach the first rendered image (≤3 MB)"),
    },
  },
  async ({ job_id, save_dir, return_image }) => {
    const job: BlenderJob = await (await apiFetch(`/blender/jobs/${job_id}`)).json();
    return blenderResult(job, save_dir, return_image);
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
