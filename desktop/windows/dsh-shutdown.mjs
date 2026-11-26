import { Server } from 'node:http'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import path, { posix } from 'node:path'

// The locked DSH CLI also tries to persist an unfiltered startup dump. Let
// its write fall back to stderr, which the desktop supervisor classifies.
const rawLogDir = path.resolve(process.env.DSH_HOME, 'logs').toLowerCase()
const writeFile = fs.writeFile
fs.writeFile = function (file, ...args) {
  if (typeof file === 'string' && path.dirname(path.resolve(file)).toLowerCase() === rawLogDir
    && /^startup-[\dTZ.-]+-[a-f0-9-]{36}\.log$/i.test(path.basename(file))) {
    return Promise.reject(new Error('Desktop startup diagnostics use the redacted supervisor log.'))
  }
  return writeFile(file, ...args)
}
syncBuiltinESMExports()

// This dedicated DSH instance only serves the desktop workbench. Route the
// stock DSH configuration, credentials and upgrade endpoints away from HTTP.
const emit = Server.prototype.emit
function isWorkbenchRequest(target) {
  if (!target?.startsWith('/bohack/')) return false
  try {
    const pathname = decodeURIComponent(new URL(target, 'http://127.0.0.1').pathname)
    return !pathname.includes('\\') && posix.normalize(pathname).startsWith('/bohack/')
  } catch { return false }
}
Server.prototype.emit = function (event, ...args) {
  if (event === 'upgrade' || event === 'connect') {
    args[1].destroy()
    return true
  }
  if (event === 'request' && !isWorkbenchRequest(args[0].url)) {
    args[1].writeHead(404, { 'cache-control': 'no-store' }).end()
    return true
  }
  return emit.call(this, event, ...args)
}

// A hidden Windows process has no console group to signal. Translate the
// authenticated parent IPC channel into the DSH CLI's normal disposal path.
process.once('message', message => {
  if (message !== 'shutdown') {
    process.exitCode = 1
    process.disconnect?.()
    return
  }
  process.disconnect?.()
  if (!process.emit('SIGTERM')) process.exit(0)
})
process.channel?.unref()
