// Launches Chrome with the extension installed, using only Node built-ins.
//
// Branded Chrome ignores --load-extension since version 137, so the extension
// goes in through the DevTools protocol instead: Extensions.loadUnpacked,
// which needs --remote-debugging-pipe and --enable-unsafe-extension-debugging.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension')

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
]

export function findChrome() {
  const fromEnv = process.env.CHROME_PATH
  if (fromEnv != null && fromEnv !== '') return fromEnv
  const found = CHROME_CANDIDATES.find(candidate => existsSync(candidate))
  if (found == null) throw new Error('Chrome not found. Set CHROME_PATH to the Chrome executable.')
  return found
}

/**
 * Starts Chrome, installs the extension and returns the protocol connection.
 * @returns {Promise<{ cdp: CdpConnection, extensionId: string, child: import('node:child_process').ChildProcess }>}
 */
export async function launchWithExtension({ userDataDir, headless, extraArgs = [], startUrl = 'about:blank' }) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    ...(headless ? ['--headless=new'] : []),
    ...extraArgs,
    startUrl
  ]
  const child = spawn(findChrome(), args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
  const stderrLines = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderrLines.push(...chunk.split('\n'))
    stderrLines.splice(0, Math.max(0, stderrLines.length - 50))
  })

  const cdp = new CdpConnection(child.stdio[3], child.stdio[4])
  child.on('exit', code => cdp.close(new Error(`Chrome exited (${code}):\n${stderrLines.join('\n')}`)))

  const { id: extensionId } = await cdp.send('Extensions.loadUnpacked', { path: EXTENSION_DIR })
  return { cdp, extensionId, child }
}

/** DevTools protocol over Chrome's debugging pipe: NUL-separated JSON messages. */
export class CdpConnection {
  constructor(writable, readable) {
    this.writable = writable
    this.nextId = 1
    this.callbacks = new Map()
    this.listeners = new Set()
    this.closedError = undefined
    let buffer = ''
    readable.setEncoding('utf8')
    readable.on('data', chunk => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\0')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        this.dispatch(message)
      }
    })
  }

  send(method, params = {}, sessionId) {
    if (this.closedError != null) return Promise.reject(this.closedError)
    const id = this.nextId++
    const message = { id, method, params, ...(sessionId != null ? { sessionId } : {}) }
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject, method })
      this.writable.write(`${JSON.stringify(message)}\0`)
    })
  }

  /** Calls the listener with every protocol event; returns an unsubscribe function. */
  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(error) {
    if (this.closedError != null) return
    this.closedError = error
    for (const { reject } of this.callbacks.values()) reject(error)
    this.callbacks.clear()
  }

  dispatch(message) {
    if (message.id == null) {
      for (const listener of this.listeners) listener(message)
      return
    }
    const callback = this.callbacks.get(message.id)
    if (callback == null) return
    this.callbacks.delete(message.id)
    if (message.error != null) {
      callback.reject(new Error(`${callback.method}: ${message.error.message}`))
    } else {
      callback.resolve(message.result)
    }
  }
}

/** Attaches to the extension's service worker and returns an evaluate helper. */
export async function attachServiceWorker(cdp, extensionId, timeoutMs = 10_000) {
  const prefix = `chrome-extension://${extensionId}/`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send('Target.getTargets')
    const worker = targetInfos.find(info => info.type === 'service_worker' && info.url.startsWith(prefix))
    if (worker != null) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })
      return expression => evaluate(cdp, sessionId, expression)
    }
    await delay(100)
  }
  throw new Error('Extension service worker did not start')
}

export async function evaluate(cdp, sessionId, expression, options = {}) {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, ...options },
    sessionId
  )
  if (exceptionDetails != null) {
    throw new Error(`Evaluation failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`)
  }
  return result.value
}

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
