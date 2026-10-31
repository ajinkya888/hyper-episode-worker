// Synthesizes narration with ElevenLabs and writes it into a project directory.
// Called by handler.py with JSON on argv[2]:
//   { projectDir, text, voiceId, modelId, tailSeconds }
// Writes voice.mp3 and voice-words.js, patches __DURATION__ in index.html,
// and prints RESULT:{...}. The API key comes from ELEVENLABS_API_KEY.
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const opts = JSON.parse(process.argv[2]);
const {
  projectDir,
  text,
  voiceId = "JBFqnCBsd6RMkjVDRZzb",
  modelId = "eleven_turbo_v2_5",
  tailSeconds = 1.5,
} = opts;

const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.log("RESULT:" + JSON.stringify({ ok: false, error: "ELEVENLABS_API_KEY is not set on the worker" }));
  process.exit(1);
}

const url =
  `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
  `/with-timestamps?output_format=mp3_44100_128`;

const started = Date.now();
const res = await fetch(url, {
  method: "POST",
  headers: { "xi-api-key": key, "Content-Type": "application/json" },
  body: JSON.stringify({ text, model_id: modelId }),
});

if (!res.ok) {
  const body = (await res.text()).slice(0, 500);
  console.log("RESULT:" + JSON.stringify({ ok: false, error: `ElevenLabs HTTP ${res.status}`, body }));
  process.exit(1);
}

const data = await res.json();
const ttsMs = Date.now() - started;

// The response carries a time for every CHARACTER. Group them into words so the
// captions can be revealed one word at a time, which is what the director times to.
const a = data.alignment ?? {};
const chars = a.characters ?? [];
const starts = a.character_start_times_seconds ?? [];
const ends = a.character_end_times_seconds ?? [];

const words = [];
let current = null;
for (let i = 0; i < chars.length; i++) {
  const ch = chars[i];
  if (/\s/.test(ch)) {
    if (current) {
      words.push(current);
      current = null;
    }
    continue;
  }
  if (!current) current = { word: ch, start: starts[i], end: ends[i] };
  else {
    current.word += ch;
    current.end = ends[i];
  }
}
if (current) words.push(current);

const audioEnd = ends.length ? ends[ends.length - 1] : 0;
const duration = Math.ceil((audioEnd + tailSeconds) * 10) / 10;

writeFileSync(join(projectDir, "voice.mp3"), Buffer.from(data.audio_base64, "base64"));
writeFileSync(
  join(projectDir, "voice-words.js"),
  `window.__VOICE_WORDS = ${JSON.stringify(words)};\nwindow.__VOICE_DURATION = ${duration};\n`,
);

// The composition ships with a placeholder so its root duration matches the audio.
const indexPath = join(projectDir, "index.html");
const html = readFileSync(indexPath, "utf8");
writeFileSync(indexPath, html.replaceAll("__DURATION__", String(duration)), "utf8");

console.log(
  "RESULT:" +
    JSON.stringify({
      ok: true,
      characters: chars.length,
      words: words.length,
      audioSeconds: Number(audioEnd.toFixed(2)),
      durationSeconds: duration,
      ttsMs,
      model: modelId,
      voiceId,
      costUsd: Number(((text.length / 1000) * 0.04).toFixed(4)),
      firstWords: words.slice(0, 6),
    }),
);
