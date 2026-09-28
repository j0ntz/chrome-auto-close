// End-to-end check: installs the extension into a scratch Chrome profile and
// drives real tabs through the DevTools protocol.
//
// Slack URLs are answered locally through Fetch interception, so the test uses
// the real default rules and the real Slack URL shape without network access.
// Everything else is served from a local HTTP server.
//
// Usage: node scripts/e2e.mjs [--headed]

import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachServiceWorker, delay, evaluate, launchWithExtension } from './chrome.mjs'

const SLACK_URL = 'https://edgesecure.slack.com/archives/C0808NMRU93/p1790596658215339'
const SLACK_DELAY_MS = 5_000
const CLOSE_SLACK_MS = 5_000

const headless = !process.argv.includes('--headed')
const userDataDir = mkdtempSync(path.join(tmpdir(), 'auto-close-e2e-'))
const server = await startServer()
const localUrl = `http://127.0.0.1:${server.address().port}`

// Hosted CI runners block the sandbox's user namespaces.
const extraArgs = process.env.CI != null ? ['--no-sandbox'] : []
const { cdp, extensionId, child } = await launchWithExtension({ userDataDir, headless, extraArgs })
const results = []
try {
  await interceptSlack(cdp)
  const workerEval = await attachServiceWorker(cdp, extensionId)
  await waitFor('default rules installed', async () => {
    const stored = await workerEval('chrome.storage.sync.get(null)')
    return Array.isArray(stored.rules) && stored.rules.some(rule => rule.id === 'slack')
  })

  // Every tab in this test has a distinct URL, so the URL maps a target to its tab.
  const tabIdOf = async targetId => {
    let tabId
    await waitFor('tab id', async () => {
      const tabs = await workerEval('chrome.tabs.query({})')
      const { targetInfo } = await cdp.send('Target.getTargetInfo', { targetId })
      tabId = tabs.find(tab => tab.status === 'complete' && tab.url === targetInfo.url)?.id
      return tabId != null
    })
    return tabId
  }
  const isOpen = async targetId => {
    const { targetInfos } = await cdp.send('Target.getTargets')
    return targetInfos.some(info => info.targetId === targetId)
  }

  // Tabs whose first page is a matching URL: the Slack desktop-app case.
  const slackTab = await newTab(SLACK_URL)
  const keptTab = await newTab(`${SLACK_URL}?kept=1`)

  // Tabs that must stay open.
  const otherTab = await newTab(`${localUrl}/page`)
  const typedTab = await newTab('chrome://newtab/')
  await navigate(typedTab, SLACK_URL)
  const linkTab = await newTab(`${localUrl}/links`)
  await clickLink(linkTab, '#same-tab')

  // A link that opens a new tab, as clicking a Slack link in email does.
  const popupSource = await newTab(`${localUrl}/links`)
  const popupTarget = await waitForNewTarget(() => clickLink(popupSource, '#new-tab'))

  // Keep one of the matching tabs through the popup's message API.
  const keptTabId = await tabIdOf(keptTab)
  const popup = await newTab(`chrome-extension://${extensionId}/popup.html`)
  // The new target starts on about:blank, which is already "complete".
  await waitFor('popup page loaded', () => pageEval(popup, 'location.protocol === "chrome-extension:" && document.readyState === "complete"'))
  const keepResponse = await pageEval(popup, `chrome.runtime.sendMessage({ type: 'keepTab', tabId: ${keptTabId} })`)
  assert.equal(keepResponse.kept, true)

  const status = await pageEval(popup, `chrome.runtime.sendMessage({ type: 'getTabStatus', tabId: ${await tabIdOf(slackTab)} })`)
  record('status reports a pending close for the Slack tab', status.pending?.ruleName === 'Slack', JSON.stringify(status))

  record('Slack tab is still open before its delay', await isOpen(slackTab))
  await waitFor('Slack tab closes', async () => !(await isOpen(slackTab)), SLACK_DELAY_MS + CLOSE_SLACK_MS)
  record('Slack tab opened on a matching URL closes after the delay', true)
  await waitFor('new-tab link closes', async () => !(await isOpen(popupTarget)), SLACK_DELAY_MS + CLOSE_SLACK_MS)
  record('matching link opened in a new tab closes', true)

  record('non-matching tab stays open', await isOpen(otherTab))
  record('matching URL typed into a new tab page stays open', await isOpen(typedTab))
  record('matching link followed inside an open tab stays open', await isOpen(linkTab))
  record('tab kept from the popup stays open', await isOpen(keptTab))
} catch (error) {
  record(`run finished without errors`, false, error.stack)
} finally {
  // Browser.close also stops Chrome's helper processes, which keep writing to
  // the profile after a killed main process exits.
  const exited = child.exitCode != null || child.signalCode != null ? Promise.resolve() : once(child, 'exit')
  await cdp.send('Browser.close').catch(() => child.kill())
  server.close()
  await exited
  try {
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10 })
  } catch (error) {
    console.warn(`Could not remove ${userDataDir}: ${error.message}`)
  }
}

for (const { name, ok, detail } of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail == null ? '' : `\n  ${detail}`}`)
}
const failed = results.filter(result => !result.ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)

function record(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail })
}

async function newTab(url) {
  const { targetId } = await cdp.send('Target.createTarget', { url })
  return targetId
}

async function sessionFor(targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  return sessionId
}

async function pageEval(targetId, expression) {
  return evaluate(cdp, await sessionFor(targetId), expression, { userGesture: true })
}

async function navigate(targetId, url) {
  const sessionId = await sessionFor(targetId)
  await cdp.send('Page.navigate', { url, transitionType: 'typed' }, sessionId)
  const { host } = new URL(url)
  await waitFor(`navigation to ${url}`, async () => {
    const { targetInfo } = await cdp.send('Target.getTargetInfo', { targetId })
    return URL.canParse(targetInfo.url) && new URL(targetInfo.url).host === host
  })
}

async function clickLink(targetId, selector) {
  await waitFor(`${selector} rendered`, () => pageEval(targetId, `document.querySelector('${selector}') != null`))
  await pageEval(targetId, `document.querySelector('${selector}').click()`)
}

/** Runs the action and returns the id of the page target it opened. */
async function waitForNewTarget(action) {
  const { targetInfos } = await cdp.send('Target.getTargets')
  const before = new Set(targetInfos.map(info => info.targetId))
  await action()
  let found
  await waitFor('new tab opened', async () => {
    const { targetInfos: after } = await cdp.send('Target.getTargets')
    found = after.find(info => info.type === 'page' && !before.has(info.targetId))?.targetId
    return found != null
  })
  return found
}

async function waitFor(label, check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await delay(200)
  }
  throw new Error(`Timed out waiting for: ${label}`)
}

/**
 * Answers *.slack.com requests locally, the way Slack answers a logged-out
 * browser: the archive link 302s to `/?redir=...`, which serves a page.
 * Fetch on the browser target sees every tab's requests from the first one.
 */
async function interceptSlack(connection) {
  connection.onEvent(message => {
    if (message.method !== 'Fetch.requestPaused') return
    const { requestId, request } = message.params
    const { pathname, search } = new URL(request.url)
    const response = pathname.startsWith('/archives/')
      ? { responseCode: 302, responseHeaders: [{ name: 'Location', value: `/?redir=${encodeURIComponent(pathname + search)}` }] }
      : {
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
          body: Buffer.from('<!doctype html><title>Slack stub</title><p>Opening Slack...</p>').toString('base64')
        }
    connection.send('Fetch.fulfillRequest', { requestId, ...response }).catch(() => {})
  })
  await connection.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*.slack.com/*' }] })
}

function startServer() {
  const pages = {
    '/page': '<!doctype html><title>Other page</title><p>Not a matching URL.</p>',
    '/links': `<!doctype html><title>Links</title>
      <a id="same-tab" href="${SLACK_URL}?same=1">Same tab</a>
      <a id="new-tab" href="${SLACK_URL}?new=1" target="_blank">New tab</a>`
  }
  return new Promise(resolve => {
    const httpServer = createServer((request, response) => {
      const page = pages[new URL(request.url, 'http://localhost').pathname]
      response.writeHead(page == null ? 404 : 200, { 'Content-Type': 'text/html' })
      response.end(page ?? 'Not found')
    })
    httpServer.listen(0, '127.0.0.1', () => resolve(httpServer))
  })
}
