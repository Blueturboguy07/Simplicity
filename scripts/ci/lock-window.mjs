// THROWAWAY probe (branch probe/lock-window, never merged).
// How long does Windows refuse onnxruntime's open of a freshly written model file?
// Writes model.onnx the way transformers.js 3.8.1 FileCache.put() does (each chunk awaited,
// close() NOT awaited), then calls ort.InferenceSession.create(path) at once and every 10 ms
// until it works. Mode "await-close" waits for the stream's 'close' event first.
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as ort from 'onnxruntime-node';

const rounds = Number(process.argv[2] || 10);
const url = 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx';
const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'lockwin-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log(`model ${bytes.length} bytes, dir ${dir}, platform ${process.platform}`);

async function round(mode, i) {
  const file = path.join(dir, `${mode}-${i}.onnx`);
  const ws = fs.createWriteStream(file);
  let closedAt = null;
  ws.on('close', () => { closedAt = performance.now(); });
  for (let o = 0; o < bytes.length; o += 1 << 16) {
    await new Promise((res, rej) => ws.write(bytes.subarray(o, o + (1 << 16)), (e) => (e ? rej(e) : res())));
  }
  const tClose = performance.now();
  ws.close();
  if (mode === 'await-close') await new Promise((r) => (closedAt ? r() : ws.once('close', r)));
  const t0 = performance.now();
  let fails = 0, firstErr = '';
  while (performance.now() - t0 < 30000) {
    try {
      const s = await ort.InferenceSession.create(file);
      await s.release?.();
      const okAt = performance.now();
      return { mode, i, fails, firstTry: fails === 0, okAfterCloseCallMs: Math.round(okAt - tClose), closeEventAfterCloseCallMs: closedAt ? Math.round(closedAt - tClose) : null, firstErr };
    } catch (e) {
      fails++; if (!firstErr) firstErr = String(e.message).replace(/^.*failed:/, 'failed:');
      await sleep(10);
    }
  }
  return { mode, i, fails, firstTry: false, okAfterCloseCallMs: null, firstErr };
}

const results = [];
for (let i = 1; i <= rounds; i++) {
  for (const mode of ['no-await', 'await-close']) {
    const r = await round(mode, i);
    results.push(r);
    console.log('LOCKWIN', JSON.stringify(r));
  }
}
for (const mode of ['no-await', 'await-close']) {
  const rs = results.filter((r) => r.mode === mode);
  const failed = rs.filter((r) => !r.firstTry);
  const okMs = rs.map((r) => r.okAfterCloseCallMs).filter((x) => x != null).sort((a, b) => a - b);
  console.log(`LOCKWIN-SUMMARY mode=${mode} rounds=${rs.length} firstOpenFailed=${failed.length} maxFails=${Math.max(...rs.map((r) => r.fails))} okAfterCloseCallMs[min,median,max]=[${okMs[0]},${okMs[Math.floor(okMs.length / 2)]},${okMs[okMs.length - 1]}]`);
}
fs.rmSync(dir, { recursive: true, force: true });
