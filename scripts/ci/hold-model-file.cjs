// CI-only preload (scripts/ci/model-load-race.ps1 starts the server with
// NODE_OPTIONS=--require <this file>). Never part of the app.
//
// Makes the Windows first-model-load race happen every time instead of
// 1 load in 11. transformers.js 3.8.1 FileCache.put() writes a downloaded
// model with an fs.WriteStream and calls close() without waiting; the path
// then goes to onnxruntime, which opens it "deny others write" and fails with
// "system error number 13" while the write handle is still open. Here close()
// on a *.onnx stream under DATA_DIR waits SIMPLICITY_CI_HOLD_MODEL_MS first,
// so the write handle is surely still open when onnxruntime opens the file.
'use strict';
const fs = require('fs');

const holdMs = Number(process.env.SIMPLICITY_CI_HOLD_MODEL_MS || 0);
const dataDir = process.env.DATA_DIR || '';

if (holdMs > 0 && dataDir) {
  const close = fs.WriteStream.prototype.close;
  fs.WriteStream.prototype.close = function (cb) {
    const file = String(this.path || '');
    if (!file.toLowerCase().endsWith('.onnx') || !file.startsWith(dataDir)) {
      return close.call(this, cb);
    }
    process.stderr.write(`[ci-hold] holding the write handle of ${file} for ${holdMs} ms\n`);
    setTimeout(() => {
      process.stderr.write(`[ci-hold] released ${file}\n`);
      close.call(this, cb);
    }, holdMs);
  };
  process.stderr.write(`[ci-hold] armed: ${holdMs} ms for *.onnx under ${dataDir}\n`);
}
