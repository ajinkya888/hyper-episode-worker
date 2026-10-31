// Renders a HyperFrames project and reports timings. Called by handler.py with
// JSON on argv[2]: { projectDir, outputPath, fps, quality, format, durationSeconds }
// Prints one line of JSON on stdout prefixed with RESULT: so the caller can parse it.
import { performance } from "node:perf_hooks";
import { statSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { lintProject, shouldBlockRender } from "@hyperframes/lint";
import { createRenderJob, executeRenderJob, createConsoleLogger } from "@hyperframes/producer";

const opts = JSON.parse(process.argv[2]);
const {
  projectDir,
  outputPath,
  fps = 30,
  quality = "standard",
  format = "mp4",
  durationSeconds = null,
  // Left unset, HyperFrames sizes its capture workers from the HOST's CPU count —
  // 64-256 on a RunPod node — while the container only has 16 vCPU. Pass a number
  // to cap it to what we actually bought.
  workers = null,
} = opts;

mkdirSync(dirname(outputPath), { recursive: true });

const lintStart = performance.now();
const lint = await lintProject(projectDir);
const lintMs = performance.now() - lintStart;
const findings = lint.findings ?? lint.results?.flatMap((r) => r.findings ?? []) ?? [];

if (typeof shouldBlockRender === "function" && shouldBlockRender(lint)) {
  console.log(
    "RESULT:" +
      JSON.stringify({
        ok: false,
        stage: "lint",
        error: "lint blocked the render",
        findings: findings.slice(0, 20),
      }),
  );
  process.exit(1);
}

const job = createRenderJob({
  fps,
  quality,
  format,
  logger: createConsoleLogger("warn"),
  ...(workers ? { workers } : {}),
});

// "Capturing frame 7/300 (5 workers)" is a new stage string every frame, so group
// by the stage with its numbers stripped — otherwise this reply is 60+ entries.
const group = (s) => s.replace(/\d+/g, "").replace(/\s+/g, " ").trim();

let lastStage = "";
let lastAt = 0;
const totals = new Map();
const renderStart = performance.now();

const record = (stage, ms) => {
  const key = group(stage);
  if (key) totals.set(key, (totals.get(key) ?? 0) + ms);
};

await executeRenderJob(job, projectDir, outputPath, (currentJob) => {
  const stage = currentJob.currentStage ?? "";
  if (stage !== lastStage) {
    const now = performance.now() - renderStart;
    if (lastStage) record(lastStage, now - lastAt);
    lastStage = stage;
    lastAt = now;
  }
});
record(lastStage, performance.now() - renderStart - lastAt);

const stages = [...totals.entries()]
  .map(([stage, ms]) => ({ stage, ms: Math.round(ms) }))
  .sort((a, b) => b.ms - a.ms);

const renderMs = performance.now() - renderStart;
const bytes = statSync(outputPath).size;
const frames = durationSeconds ? Math.round(fps * durationSeconds) : null;

console.log(
  "RESULT:" +
    JSON.stringify({
      ok: true,
      outputPath,
      bytes,
      fps,
      quality,
      format,
      workers: workers ?? "auto",
      hostCpuCount: (await import("node:os")).cpus().length,
      lintMs: Math.round(lintMs),
      lintFindings: findings.length,
      renderMs: Math.round(renderMs),
      frames,
      msPerFrame: frames ? Math.round(renderMs / frames) : null,
      stages: stages.filter((s) => s.ms >= 100).slice(0, 12),
    }),
);
