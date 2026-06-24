# @lumiversehr/mcp-server-comfy-api

MCP server for generating images with [ComfyUI API](https://github.com/lumiversehr/comfy-api) using z-image-turbo, directly from [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

## Quick Setup

Add to your Claude Code config (`~/.claude.json` under `mcpServers`):

```json
"comfy-api": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@lumiversehr/mcp-server-comfy-api"],
  "env": {
    "COMFY_API_URL": "https://your-comfy-api-host.com",
    "COMFY_API_KEY": "your-api-key-here"
  }
}
```

Restart Claude Code. Done.

## Authentication

The backend requires an API key for all requests. Set `COMFY_API_KEY` in the MCP server's `env` config to match the `API_KEY` value configured on the backend's `.env` file.

Requests without a valid `X-API-Key` header will be rejected with 401.

## Tools

| Tool | Description |
|------|-------------|
| `generate_image` | Generate a z-image from a text prompt. Waits for completion (up to 3 min). All images go to a private "API_generated" series. |
| `get_job_status` | Check status of a generation job by ID. |
| `download_image` | Download a generated image to the local filesystem. |
| `remove_background` | Remove the background from a local image, saving a transparent RGBA PNG. |
| `list_pipelines` | List saved node-graph pipelines that can be run. |
| `get_pipeline_params` | List a pipeline's parameters (name, type, default). |
| `run_pipeline` | Run a saved pipeline with named inputs (text/number/image); returns output image filename(s)/text. Use `download_image` to save them. |
| `get_prompt_guide` | Retrieve the Z-Image Turbo prompt guide for writing effective prompts. |

## Usage Examples

From Claude Code:

- *"Generate an image of a sunset over mountains"*
- *"Show me the prompt guide for z-image"*
- *"Download that image to ./sunset.jpg"*
- *"What's the status of job abc-123?"*
- *"Remove the background from ./photo.jpg"*
- *"List the comfy-api pipelines"* → *"Run IsometricTiles with tile = bathroom and download it"*

## remove_background Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_path` | string | required | Path to the local input image (PNG/JPG/WebP) |
| `output_path` | string | `<input>_nobg.png` | Where to save the transparent PNG |
| `model` | enum | `u2net` | `u2net` (general), `u2netp` (lighter/faster), `u2net_human_seg` (people), `isnet-general-use` (higher quality), `isnet-anime`, `silueta` (portraits) |
| `alpha_matting` | boolean | `false` | Cleaner edges (slower) |

## generate_image Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | required | Text description of the image |
| `width` | number | 1024 | Image width (256-2048, rounded to 16x) |
| `height` | number | 1024 | Image height (256-2048, rounded to 16x) |
| `steps` | number | 9 | Diffusion steps (1-50, 9 recommended for turbo) |
| `cfg` | number | 1.0 | CFG scale (turbo doesn't use CFG, keep at 1.0) |
| `seed` | number | random | Seed for reproducibility |

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `COMFY_API_URL` | Backend API base URL | `https://comfy-api.nichetide.com` |
| `COMFY_API_KEY` | API key for authentication | *(required)* |

## How It Works

1. `generate_image` submits a job to the backend API, polls every 2s until complete
2. All generated images are auto-assigned to a private "API_generated" series
3. Jobs run at priority 5 (higher than default web UI jobs)
4. `download_image` fetches the image bytes and saves to your local filesystem
5. `remove_background` uploads a local image, runs background removal, and saves the transparent PNG locally
6. All requests include the `X-API-Key` header for authentication

## Requirements

- Node.js 18+
- Network access to the ComfyUI API backend
- Valid API key

## License

MIT
