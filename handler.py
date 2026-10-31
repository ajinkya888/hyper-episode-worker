"""RunPod serverless handler: render one HyperFrames project and report what it cost.

Uses the runpod SDK 1.12.0 (the version RunPod currently recommends; 2.0 was
withdrawn on 2026-10-30 as not ready). The render itself is Node, so this is a
thin harness that shells out and parses the RESULT: line.

Job input:
  project       bundled project directory under /app/projects  (default "golden")
  html          optional composition HTML; written as index.html into a copy of
                the project, so a caller can render its own scene
  fps           default 30
  quality       "draft" | "standard" | "high"   (default "standard")
  format        "mp4" | "webm" | "mov" | "gif"  (default "mp4")
  durationSeconds  used only to report ms/frame
  returnVideo   true to receive the file as base64 (small outputs only)
"""

import base64
import json
import os
import shutil
import subprocess
import tempfile
import time

import runpod

APP_DIR = "/app"
PROJECTS_DIR = os.path.join(APP_DIR, "projects")
MAX_INLINE_BYTES = 1_200_000  # base64 inflates ~4/3; keep the reply well under the cap


def _resolve_project(job_input):
    """Return a directory to render, copying it to /tmp when the caller sent HTML."""
    name = job_input.get("project", "golden")
    if "/" in name or "\\" in name or name.startswith("."):
        raise ValueError("project must be a bundled project name")

    source = os.path.join(PROJECTS_DIR, name)
    if not os.path.isdir(source):
        available = sorted(os.listdir(PROJECTS_DIR)) if os.path.isdir(PROJECTS_DIR) else []
        raise ValueError(f"unknown project {name!r}; available: {available}")

    html = job_input.get("html")
    if not html:
        return source, None

    work_dir = tempfile.mkdtemp(prefix="episode-")
    project_dir = os.path.join(work_dir, "project")
    shutil.copytree(source, project_dir)
    with open(os.path.join(project_dir, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(html)
    return project_dir, work_dir


def _diagnose():
    """Report what is actually inside the image. Build logs are hard to reach; a job
    result is not, so this is how the image gets inspected."""
    import glob

    cache = os.environ.get("PUPPETEER_CACHE_DIR", "/app/.cache/puppeteer")
    binaries = [
        p
        for p in glob.glob(os.path.join(cache, "**", "*"), recursive=True)
        if os.path.isfile(p) and os.path.basename(p) in ("chrome", "chrome-headless-shell")
    ]

    def run(cmd):
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            return ((p.stdout or "") + (p.stderr or "")).strip()[:900]
        except Exception as exc:
            return f"{type(exc).__name__}: {exc}"

    info = {
        "ok": True,
        "cacheDir": cache,
        "cacheExists": os.path.isdir(cache),
        "cacheEntries": sorted(os.listdir(cache))[:20] if os.path.isdir(cache) else [],
        "chromeBinaries": binaries[:5],
        "cpuCount": os.cpu_count(),
        "node": run(["node", "--version"]),
        "ffmpeg": run(["ffmpeg", "-version"]).split("\n")[0],
        "projects": sorted(os.listdir(PROJECTS_DIR)) if os.path.isdir(PROJECTS_DIR) else [],
    }

    # What the browser install actually printed while the image was built.
    try:
        with open("/app/install-log.txt", encoding="utf-8", errors="replace") as fh:
            info["installLog"] = fh.read()[-3000:]
    except Exception as exc:
        info["installLog"] = f"unavailable: {exc}"

    if binaries:
        chrome = binaries[0]
        info["lddMissing"] = [l for l in run(["ldd", chrome]).splitlines() if "not found" in l]
        info["chromeVersion"] = run([chrome, "--version"])
        info["chromeLaunch"] = run(
            [chrome, "--headless", "--no-sandbox", "--disable-gpu",
             "--disable-dev-shm-usage", "--dump-dom", "about:blank"]
        )[:300]
    return info


def handler(job):
    started = time.time()
    job_input = job.get("input") or {}
    work_dir = None

    if job_input.get("diagnose"):
        try:
            return _diagnose()
        except Exception as exc:
            return {"ok": False, "error": f"diagnose failed: {type(exc).__name__}: {exc}"}

    try:
        project_dir, work_dir = _resolve_project(job_input)
        copied_project = work_dir is not None
        out_dir = work_dir or tempfile.mkdtemp(prefix="render-")
        if work_dir is None:
            work_dir = out_dir

        fmt = job_input.get("format", "mp4")
        output_path = os.path.join(out_dir, f"out.{fmt}")

        # Voice first: the real word timings decide how long the scene is and when
        # every caption lands, so it has to run before the render.
        voice_result = None
        voice = job_input.get("voice")
        if voice:
            if not copied_project:
                # _resolve_project returned the bundled directory; never write into it.
                work_dir = tempfile.mkdtemp(prefix="episode-")
                copied = os.path.join(work_dir, "project")
                shutil.copytree(project_dir, copied)
                project_dir = copied
                out_dir = work_dir
                output_path = os.path.join(out_dir, f"out.{fmt}")

            vproc = subprocess.run(
                ["node", os.path.join(APP_DIR, "voice.mjs"), json.dumps({
                    "projectDir": project_dir,
                    "text": voice.get("text", ""),
                    "voiceId": voice.get("voiceId", "JBFqnCBsd6RMkjVDRZzb"),
                    "modelId": voice.get("modelId", "eleven_turbo_v2_5"),
                    "tailSeconds": voice.get("tailSeconds", 1.5),
                })],
                capture_output=True, text=True, timeout=300,
            )
            for line in (vproc.stdout or "").splitlines():
                if line.startswith("RESULT:"):
                    voice_result = json.loads(line[len("RESULT:"):])
            if voice_result is None or not voice_result.get("ok"):
                return {
                    "ok": False,
                    "stage": "voice",
                    "voice": voice_result,
                    "log": ((vproc.stderr or "") + (vproc.stdout or ""))[-1200:],
                }
            job_input.setdefault("durationSeconds", voice_result["durationSeconds"])

        options = {
            "projectDir": project_dir,
            "outputPath": output_path,
            "fps": job_input.get("fps", 30),
            "quality": job_input.get("quality", "standard"),
            "format": fmt,
            "durationSeconds": job_input.get("durationSeconds"),
        }

        proc = subprocess.run(
            ["node", os.path.join(APP_DIR, "render.mjs"), json.dumps(options)],
            capture_output=True,
            text=True,
            timeout=job_input.get("timeoutSeconds", 3000),
        )

        result = None
        for line in (proc.stdout or "").splitlines():
            if line.startswith("RESULT:"):
                result = json.loads(line[len("RESULT:") :])

        if result is None:
            # The cause is usually in the FIRST lines (Chrome failing to launch), while
            # the tail is only stack frames, so return both ends.
            log = (proc.stderr or "") + (proc.stdout or "")
            return {
                "ok": False,
                "error": "render produced no result",
                "exitCode": proc.returncode,
                "logHead": log[:2500],
                "logTail": log[-800:],
            }

        if not result.get("ok"):
            return result

        result["totalSeconds"] = round(time.time() - started, 2)
        if voice_result:
            result["voice"] = voice_result
        result["worker"] = {
            "cpuCount": os.cpu_count(),
            "endpointId": os.environ.get("RUNPOD_ENDPOINT_ID"),
            "podId": os.environ.get("RUNPOD_POD_ID"),
        }

        if job_input.get("returnVideo"):
            size = result.get("bytes", 0)
            if size <= MAX_INLINE_BYTES:
                with open(output_path, "rb") as fh:
                    result["videoBase64"] = base64.b64encode(fh.read()).decode("ascii")
            else:
                result["videoOmitted"] = f"{size} bytes exceeds the {MAX_INLINE_BYTES} inline limit"

        return result

    except Exception as exc:  # surfaced to the caller rather than failing silently
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    finally:
        if work_dir and os.path.isdir(work_dir):
            shutil.rmtree(work_dir, ignore_errors=True)


runpod.serverless.start({"handler": handler})
