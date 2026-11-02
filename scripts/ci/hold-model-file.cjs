// CI-only preload (scripts/ci/model-load-race.ps1 starts the server with
// NODE_OPTIONS=--require <this file>). Never part of the app.
//
// Makes the Windows first-model-load race happen every time instead of
// 1 load in 11. In v0.1.5, transformers.js 3.8.1 wrote a downloaded model
// with an fs.WriteStream, called close() without waiting and gave the PATH to
// onnxruntime, which opens it "deny others write" and failed with
// "system error number 13" while any other handle could still write the file.
//
// Here a second read+write handle (shared like Node's own handles: the open
// write stream of v0.1.5, or any slow writer) is opened on model.onnx as soon
// as the file exists and is kept open SIMPLICITY_CI_HOLD_MODEL_MS.
// (An exclusive lock is taken by model-load-race.ps1 itself with .NET
// FileShare.None: Node cannot open a file without sharing.)
'use strict';
const fs = require('fs');
const path = require('path');

const holdMs = Number(process.env.SIMPLICITY_CI_HOLD_MODEL_MS || 0);
const mode = 'write';
const dataDir = process.env.DATA_DIR || '';

if (holdMs > 0 && dataDir) {
  const log = (text) => process.stderr.write(`[ci-hold] ${text}\n`);
  const file = path.join(dataDir, 'models', 'Xenova', 'all-MiniLM-L6-v2', 'onnx', 'model.onnx');
  const flags = fs.constants.O_RDWR;
  const timer = setInterval(() => {
    let fd;
    try {
      fd = fs.openSync(file, flags);
    } catch {
      return;
    }
    clearInterval(timer);
    log(`holding a ${mode} handle of ${file} for ${holdMs} ms`);
    setTimeout(() => {
      fs.closeSync(fd);
      log(`released ${file}`);
    }, holdMs);
  }, 2);
  log(`armed: ${mode} handle for ${holdMs} ms on ${file}`);
}
