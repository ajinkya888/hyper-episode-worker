// Renders a HyperFrames project and reports timings. Called by handler.py with
// JSON on argv[2]: { projectDir, outputPath, fps, quality, format, durationSeconds }
// Prints one line of JSON on stdout prefixed with RESULT: so the caller can parse it.
import { performance } from "node:perf_hooks";
import { statSync, mkdirSync, readFileSync } from "node:fs";
import { cpus } from "node:os";
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
  // Left unset we size the capture pool ourselves, from the vCPU the container
  // actually holds. Never leave it to HyperFrames: it reads the HOST's CPU count
  // (128-256 on a RunPod node) and oversubscribes by 4-16x. Measured 2026-10-31:
  // on one 192-core host, 16 vCPU ran 41 ms/frame on auto and 28 capped at 8.
  workers = null,
} = opts;

// How many vCPU this container really holds. The kernel shows every core on the
// box, so os.cpus() reports the host; the cgroup quota is what we were sold.
// cgroup v2 keeps it in cpu.max as "<quota> <period>" ("max" means unlimited),
// v1 splits it over two files. cpuset is the fallback when no quota is set, and
// the host count the last resort.
function detectVcpu() {
  const read = (f) => {
    try {
      return readFileSync(f, "utf8").trim();
    } catch {
      return null;
    }
  };

  const v2 = read("/sys/fs/cgroup/cpu.max");
  if (v2) {
    const [quota, period] = v2.split(" ");
    if (quota !== "max" && Number(period) > 0) {
      return { vcpu: Math.max(1, Math.round(Number(quota) / Number(period))), via: "cgroup v2 cpu.max" };
    }
  }

  const q1 = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"));
  const p1 = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_period_us"));
  if (q1 > 0 && p1 > 0) {
    return { vcpu: Math.max(1, Math.round(q1 / p1)), via: "cgroup v1 cfs_quota" };
  }

  // "0-15", or "0-7,16-23" when the cores are not contiguous.
  const set = read("/sys/fs/cgroup/cpuset.cpus.effective") ?? read("/sys/fs/cgroup/cpuset/cpuset.cpus");
  if (set) {
    const n = set.split(",").reduce((acc, part) => {
      const [a, b] = part.split("-").map(Number);
      return acc + (Number.isFinite(b) ? b - a + 1 : 1);
    }, 0);
    if (n > 0) return { vcpu: n, via: "cpuset" };
  }

  return { vcpu: cpus().length, via: "host cpu count (no cgroup limit found)" };
}

// Half the cores we hold. A capture worker is a Chrome instance that rasterises and
// composites on threads of its own, so one per core thrashes: at 32 vCPU, 16 workers
// measured 17 ms/frame against 19 for 32, and at 16 vCPU, 8 beat 16 by the same margin.
const cpu = detectVcpu();
const workerCount = workers ?? Math.max(2, Math.floor(cpu.vcpu / 2));

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
  workers: workerCount,
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
      workers: workerCount,
      workersChosenBy: workers ? "caller" : `vcpu/2 via ${cpu.via}`,
      vcpu: cpu.vcpu,
      hostCpuCount: cpus().length,
      lintMs: Math.round(lintMs),
      lintFindings: findings.length,
      renderMs: Math.round(renderMs),
      frames,
      msPerFrame: frames ? Math.round(renderMs / frames) : null,
      stages: stages.filter((s) => s.ms >= 100).slice(0, 12),
    }),
);
