import { runCli } from './cli'

// Entry point for the bundled `reborn` executable.

const abort = new AbortController()
process.once('SIGINT', () => {
  abort.abort()
  process.exitCode = 130
  // Give `watch` a moment to close its stream, then leave even if stdin holds the loop open.
  setTimeout(() => process.exit(130), 500).unref()
})

// The Linux AppImage shim passes --no-sandbox first so the AppImage launcher
// doesn't put it before the script, where Node would reject it. See
// apps/desktop/src/cli-shim.ts.
const args = process.argv.slice(2)
if (args[0] === '--no-sandbox') args.shift()

runCli(args, {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  env: process.env,
  input: process.stdin,
  output: process.stdout,
  signal: abort.signal,
}).then(
  (code) => {
    if (!process.exitCode) process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exitCode = 1
  },
)
