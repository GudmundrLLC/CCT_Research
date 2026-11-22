// IBM Granite running inside the app: no API key, no external AI service.
// Uses Transformers.js (ONNX Runtime on CPU). Weights are downloaded once from
// Hugging Face with resumable, size-checked transfers, then loaded from disk.
import fs from "node:fs";
import path from "node:path";

export const GRANITE_MODEL = process.env.GRANITE_MODEL || "onnx-community/granite-4.0-1b-ONNX-web";
const DTYPE = process.env.GRANITE_DTYPE || "q4";
// Keep weights on a Railway volume when one is attached, so redeploys don't re-download ~1.8 GB.
const ROOT = path.resolve(process.env.GRANITE_CACHE ||
  (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "models") : ".cache/models"));
const HF = process.env.HF_ENDPOINT || "https://huggingface.co";
const suffix = DTYPE === "fp32" ? "" : `_${DTYPE}`;

const state = { status: "idle", detail: "", progress: 0, model: GRANITE_MODEL, dtype: DTYPE, error: null };
export const graniteStatus = () => ({ ...state });

let generator = null;
let loading = null;
let queue = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function remoteSize(url) {
  const res = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!res.ok) throw new Error(`HEAD ${res.status} for ${url}`);
  const n = Number(res.headers.get("x-linked-size") || res.headers.get("content-length"));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Resumable download: appends with Range requests until the file reaches its full size.
async function download(file, onBytes) {
  const url = `${HF}/${GRANITE_MODEL}/resolve/main/${file}`;
  const dest = path.join(ROOT, GRANITE_MODEL, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const total = await remoteSize(url);
  for (let attempt = 1; attempt <= 40; attempt++) {
    const have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    if (total && have === total) return total;
    if (total && have > total) fs.rmSync(dest);
    try {
      const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: "follow" });
      if (res.status === 416) return have;
      if (!res.ok) throw new Error(`GET ${res.status}`);
      const append = have > 0 && res.status === 206;
      const out = fs.createWriteStream(dest, { flags: append ? "a" : "w" });
      let written = append ? have : 0;
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
        written += chunk.length;
        onBytes?.(written, total);
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
      if (!total || fs.statSync(dest).size === total) return written;
    } catch (e) {
      state.detail = `retrying ${file} (${e.message})`;
      await sleep(Math.min(30000, 1000 * attempt));
    }
  }
  throw new Error(`Could not download ${file}`);
}

async function ensureFiles() {
  const small = ["config.json", "generation_config.json", "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json", "chat_template.jinja"];
  for (const f of small) {
    try { await download(f); } catch (e) { if (f === "chat_template.jinja" || f === "special_tokens_map.json") continue; throw e; }
  }
  const big = [`onnx/model${suffix}.onnx`, `onnx/model${suffix}.onnx_data`];
  for (const f of big) {
    await download(f, (n, total) => {
      if (total) state.progress = Math.round((n / total) * 100);
      state.detail = `downloading ${f} — ${(n / 1e9).toFixed(2)}${total ? ` / ${(total / 1e9).toFixed(2)}` : ""} GB`;
    });
  }
}

export function loadGranite() {
  if (generator) return Promise.resolve(generator);
  if (loading) return loading;
  loading = (async () => {
    try {
      state.status = "downloading"; state.error = null;
      await ensureFiles();
      state.status = "loading"; state.detail = "loading model into memory"; state.progress = 100;
      const { pipeline, env } = await import("@huggingface/transformers");
      env.localModelPath = ROOT;
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      const t = Date.now();
      generator = await pipeline("text-generation", GRANITE_MODEL, { dtype: DTYPE, device: "cpu" });
      state.status = "ready";
      state.detail = `loaded in ${((Date.now() - t) / 1000).toFixed(1)} s`;
      console.log(`Granite ready: ${GRANITE_MODEL} (${DTYPE}), ${state.detail}`);
      return generator;
    } catch (e) {
      state.status = "error"; state.error = e.message; state.detail = "";
      loading = null;
      console.error("Granite failed to load:", e);
      throw e;
    }
  })();
  return loading;
}

// One generation at a time: CPU inference is the bottleneck, and concurrent runs would
// just compete for the same cores and memory.
export function generate(messages, { maxNewTokens = 400 } = {}) {
  const run = queue.then(async () => {
    const gen = await loadGranite();
    const out = await gen(messages, { max_new_tokens: maxNewTokens, do_sample: false, repetition_penalty: 1.05 });
    return String(out[0].generated_text.at(-1).content || "")
      .replace(/^\s*\[(bullet|point)\s*\d+\]\s*$/gim, "") // small-model artefacts like "[Bullet 1]"
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  });
  queue = run.catch(() => {});
  return run;
}
