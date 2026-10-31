# Episode worker

Renders one HyperFrames project inside a RunPod CPU serverless worker and reports
what it cost. RunPod builds this image from the repository — nothing is built locally.

## What is here

| File | Does |
|---|---|
| `Dockerfile` | Node 22 + Chrome + FFmpeg + fonts + the RunPod Python SDK |
| `handler.py` | Speaks RunPod's job protocol, shells out to Node, returns the numbers |
| `render.mjs` | Lints the project, renders it with the HyperFrames SDK, times every stage |
| `projects/golden/` | The scene proved locally on 2026-10-31: variables, a code-drawn chart, word-timed captions |

The render uses the HyperFrames **SDK**, not its CLI.

## Calling it

```jsonc
// POST /run  on the endpoint
{
  "input": {
    "project": "golden",       // a directory under projects/
    "fps": 30,
    "quality": "standard",     // draft | standard | high
    "format": "mp4",
    "durationSeconds": 10,     // only used to report ms/frame
    "returnVideo": true        // base64, for outputs under ~1.2 MB
  }
}
```

Send `html` to render your own composition against the same bundled assets.

It replies with `renderMs`, `msPerFrame`, `lintMs`, `bytes` and a per-stage breakdown,
which is what the cost model in `../SIMPLE-PLAN.md` §3 is built from.

## Why Python wraps Node

RunPod's job protocol has a stable, supported Python SDK (1.12.0). Its successor,
`runpod` 2.0, was published on 2026-10-30 and withdrawn the same day — "Published by
mistake; 2.0 is not ready. Use 1.12.0" — and `runpod-flash` was deprecated on
2026-10-29. So the worker stays on 1.12.0 and keeps the rendering in Node, where
HyperFrames lives.

## Endpoint settings that matter

- **`executionTimeout` must be raised** from the 300–600 s default. A 10-minute
  episode renders for 15–30 minutes and would otherwise be killed mid-job.
- `cpu3c`, 16 vCPU. Cost is roughly flat in core count, so size for latency.
- Idle timeout 5–10 s so it scales to zero.
