// Uploads a finished render to Cloudflare R2 and returns a link that opens in a browser.
// Called by handler.py with JSON on argv[2]: { filePath, key, contentType, expiresIn }
// Credentials come from the worker's environment:
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
import { readFileSync, statSync } from "node:fs";
import { AwsClient } from "aws4fetch";

const { filePath, key, contentType = "video/mp4", expiresIn = 604800 } = JSON.parse(process.argv[2]);

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET || "hyper-episodes";

const missing = [
  ["R2_ACCOUNT_ID", accountId],
  ["R2_ACCESS_KEY_ID", accessKeyId],
  ["R2_SECRET_ACCESS_KEY", secretAccessKey],
].filter(([, v]) => !v).map(([n]) => n);

if (missing.length) {
  console.log("RESULT:" + JSON.stringify({ ok: false, error: `missing on the worker: ${missing.join(", ")}` }));
  process.exit(1);
}

const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
const base = `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${encodeURI(key)}`;
const body = readFileSync(filePath);
const bytes = statSync(filePath).size;

const started = Date.now();
const put = await client.fetch(base, {
  method: "PUT",
  body,
  headers: { "Content-Type": contentType, "Content-Length": String(bytes) },
});

if (!put.ok) {
  const text = (await put.text()).slice(0, 400);
  console.log("RESULT:" + JSON.stringify({ ok: false, error: `R2 PUT ${put.status}`, body: text }));
  process.exit(1);
}

// A signed link so the file can be opened without making the bucket public.
const signed = await client.sign(
  new Request(`${base}?X-Amz-Expires=${expiresIn}`, { method: "GET" }),
  { aws: { signQuery: true } },
);

console.log(
  "RESULT:" +
    JSON.stringify({
      ok: true,
      bucket,
      key,
      bytes,
      uploadMs: Date.now() - started,
      mbPerSecond: Number((bytes / 1048576 / ((Date.now() - started) / 1000)).toFixed(1)),
      url: signed.url,
      expiresInHours: Math.round(expiresIn / 3600),
    }),
);
