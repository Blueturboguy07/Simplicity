// CI only (see .github/workflows/publik-build.yml). Not part of the app.
//
// Starts the packaged app with the publik usage-count endpoint pointed at a
// listener on this machine, and checks what the app sends:
//   - normal start: exactly one correct `app_opened` request must arrive, and
//     the app must stay up;
//   - start with DO_NOT_TRACK=1: no request may arrive.
// Nothing here talks to publikhq.com. The app gets its own empty data folder
// (--user-data-dir) for each start.
//
// usage: node publik-telemetry-smoke.cjs <app executable> [result file]
'use strict'

const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const [exe, resultFile] = process.argv.slice(2)
if (!exe) {
  console.error('usage: node publik-telemetry-smoke.cjs <app executable> [result file]')
  process.exit(2)
}

const WANT_APP = 'simplicity'
const WANT_VERSION = require(path.join(__dirname, '..', '..', 'package.json')).version
const WANT_OS = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform]
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ALLOWED_FIELDS = ['v', 'app', 'install_id', 'event', 'app_version', 'os', 'arch']
const OPEN_WAIT_MS = 40000 // how long a normal start may take to send app_opened
const WATCH_MS = 20000 // how long each start is watched

const requests = []
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const headers = { ...req.headers }
    if (headers.authorization) headers.authorization = '<present, not recorded>'
    requests.push({ method: req.method, url: req.url, headers, body: Buffer.concat(chunks).toString('utf8') })
    res.writeHead(204)
    res.end()
  })
})

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stopApp(child) {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL') // the whole process group
  } catch {}
}

// What is wrong with a recorded request, or null when it is a correct app_opened.
function fault(request) {
  if (request.method !== 'POST') return `method is ${request.method}`
  if (request.url !== '/api/v1/telemetry') return `path is ${request.url}`
  if (request.headers.origin) return 'the request has an Origin header (it must come from native code)'
  if (!/^application\/json/.test(request.headers['content-type'] || '')) return 'content-type is not application/json'
  let body
  try {
    body = JSON.parse(request.body)
  } catch {
    return 'the body is not JSON'
  }
  const extra = Object.keys(body).filter((key) => !ALLOWED_FIELDS.includes(key))
  if (extra.length) return `fields outside the contract: ${extra.join(', ')}`
  if (body.v !== 1) return `v is ${body.v}`
  if (body.app !== WANT_APP) return `app is ${body.app}`
  if (body.event !== 'app_opened') return `event is ${body.event}`
  if (body.app_version !== WANT_VERSION) return `app_version is ${body.app_version}, expected ${WANT_VERSION}`
  if (body.os !== WANT_OS) return `os is ${body.os}, expected ${WANT_OS}`
  if (!UUID_V4.test(body.install_id || '')) return 'install_id is not a lowercase UUID v4'
  if (body.arch !== undefined && !['arm64', 'x64'].includes(body.arch)) return `arch is ${body.arch}`
  return null
}

// One start of the app. Resolves to the requests that arrived during it.
async function run(port, extraEnv, expectRequest) {
  const first = requests.length
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simplicity-smoke-'))
  const env = {
    ...process.env,
    PUBLIK_TELEMETRY_URL: `http://127.0.0.1:${port}/api/v1/telemetry`,
    PUBLIK_TELEMETRY_DEBUG: '1',
    ...extraEnv,
  }
  delete env.PUBLIK_API_KEY
  delete env.PUBLIK_TELEMETRY
  if (!('DO_NOT_TRACK' in extraEnv)) delete env.DO_NOT_TRACK
  const child = spawn(exe, [`--user-data-dir=${dataDir}`], { env, stdio: 'inherit', detached: process.platform !== 'win32' })
  let exited = null
  child.on('error', (err) => {
    exited = `could not start: ${err.message}`
  })
  child.on('exit', (code, signal) => {
    exited = `exit code ${code}, signal ${signal}`
  })
  const started = Date.now()
  let firstAfterMs = null
  while (exited === null) {
    const elapsed = Date.now() - started
    if (firstAfterMs === null && requests.length > first) firstAfterMs = elapsed
    const limit = expectRequest && firstAfterMs === null ? OPEN_WAIT_MS : WATCH_MS
    if (elapsed >= limit) break
    await sleep(250)
  }
  const stillUp = exited === null
  stopApp(child)
  await sleep(3000)
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  } catch {}
  return { seen: requests.slice(first), stillUp, exited, firstAfterMs }
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  console.log(`listener on 127.0.0.1:${port}; app: ${exe}; expected version ${WANT_VERSION}, os ${WANT_OS}`)
  let failed = false

  const open = await run(port, {}, true)
  const good = open.seen.filter((request) => fault(request) === null)
  for (const request of open.seen) console.log(`received: ${request.method} ${request.url} ${request.body}${fault(request) ? '  <-- ' + fault(request) : ''}`)
  const openPass = good.length === 1 && open.seen.length === 1 && open.stillUp
  if (openPass) {
    console.log(`PASS  normal start: one correct app_opened arrived after ${open.firstAfterMs} ms and the app stayed up`)
  } else {
    failed = true
    console.log(`FAIL  normal start: ${open.seen.length} request(s), ${good.length} correct app_opened, app ${open.stillUp ? 'stayed up' : 'stopped (' + open.exited + ')'}`)
  }

  const quiet = await run(port, { DO_NOT_TRACK: '1' }, false)
  const quietPass = quiet.seen.length === 0 && quiet.stillUp
  if (quietPass) {
    console.log('PASS  DO_NOT_TRACK=1: the app stayed up and no request arrived')
  } else {
    failed = true
    console.log(`FAIL  DO_NOT_TRACK=1: ${quiet.seen.length} request(s) arrived, app ${quiet.stillUp ? 'stayed up' : 'stopped (' + quiet.exited + ')'}`)
  }

  server.close()
  if (resultFile) {
    const result = {
      app: exe,
      expected: { app: WANT_APP, app_version: WANT_VERSION, os: WANT_OS },
      normal_start: { pass: openPass, first_request_after_ms: open.firstAfterMs, stayed_up: open.stillUp, requests: open.seen },
      do_not_track: { pass: quietPass, stayed_up: quiet.stillUp, requests: quiet.seen },
      result: failed ? 'FAIL' : 'PASS',
    }
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n')
  }
  console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS')
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
