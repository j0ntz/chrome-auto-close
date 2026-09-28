// Service worker: watches main-frame navigations and closes tabs that opened
// on a URL matching an enabled rule once that rule's delay runs out.
//
// MV3 workers sleep after ~30s idle, so tab state lives in
// chrome.storage.session and every scheduled close has a chrome.alarms
// backstop next to its in-memory timer.

import { createdTabState, planNavigation, planSettingsChange, secondsLeft, UNKNOWN_TAB_STATE } from './plan.js'
import { DEFAULT_SETTINGS, normalizeSettings } from './rules.js'

const ALARM_PREFIX = 'close:'
const BADGE_COLOR = '#b3261e'
const TABS_KEY = 'tabs'

const timers = new Map()
// URL each main-frame navigation started on, before any server redirect.
const startUrls = new Map()
let tabStates
let settings
let badgeTicker
let queue = Promise.resolve()

// Listeners register synchronously so events that wake the worker reach them.
chrome.runtime.onInstalled.addListener(() => run(installDefaults))
chrome.runtime.onStartup.addListener(() => run(reconcile))
chrome.tabs.onCreated.addListener(tab => {
  run(async () => {
    await setTabState(tab.id, createdTabState(tab.pendingUrl ?? tab.url))
  })
})
chrome.tabs.onRemoved.addListener(tabId => run(() => forgetTab(tabId)))
chrome.webNavigation.onBeforeNavigate.addListener(details => {
  if (isMainFrame(details)) startUrls.set(details.tabId, details.url)
})
chrome.webNavigation.onCommitted.addListener(details => {
  if (!isMainFrame(details)) return
  const kind = details.transitionQualifiers.includes('client_redirect') ? 'client-redirect' : 'commit'
  const startUrl = startUrls.get(details.tabId) ?? details.url
  startUrls.delete(details.tabId)
  run(() => handleNavigation(details.tabId, details.url, kind, startUrl))
})
chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (!isMainFrame(details)) return
  run(() => handleNavigation(details.tabId, details.url, 'same-document'))
})
chrome.webNavigation.onReferenceFragmentUpdated.addListener(details => {
  if (!isMainFrame(details)) return
  run(() => handleNavigation(details.tabId, details.url, 'same-document'))
})
chrome.alarms.onAlarm.addListener(alarm => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return
  run(() => closeIfDue(Number(alarm.name.slice(ALARM_PREFIX.length))))
})
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return
  settings = undefined
  run(handleSettingsChange)
})
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  run(() => handleMessage(message))
    .then(sendResponse)
    .catch(error => sendResponse({ error: String(error) }))
  return true
})

run(reconcile)

/** Writes the default rules unless sync already carries this user's settings. */
async function installDefaults() {
  const stored = await chrome.storage.sync.get(null)
  if (stored.rules == null) await chrome.storage.sync.set(DEFAULT_SETTINGS)
}

async function handleNavigation(tabId, url, kind, startUrl = url) {
  const states = await loadTabStates()
  const tabState = states[tabId] ?? UNKNOWN_TAB_STATE
  const plan = planNavigation({ settings: await loadSettings(), tabState, url, startUrl, kind, now: Date.now() })
  await setTabState(tabId, plan.tabState)
  if (plan.action === 'schedule') armClose(tabId, plan.tabState.pending)
  if (plan.action === 'cancel') disarmClose(tabId)
}

async function handleSettingsChange() {
  const current = await loadSettings()
  const states = await loadTabStates()
  for (const [key, tabState] of Object.entries(states)) {
    if (tabState.pending == null) continue
    const tabId = Number(key)
    const tab = await getTab(tabId)
    if (tab == null) {
      await forgetTab(tabId)
      continue
    }
    const plan = planSettingsChange({ settings: current, tabState, url: tab.url })
    if (plan.action !== 'cancel') continue
    await setTabState(tabId, plan.tabState)
    disarmClose(tabId)
  }
}

async function handleMessage(message) {
  if (message?.type === 'getTabStatus') {
    const states = await loadTabStates()
    const tabState = states[message.tabId] ?? UNKNOWN_TAB_STATE
    return { kept: tabState.kept, pending: tabState.pending, now: Date.now() }
  }
  if (message?.type === 'keepTab') {
    const states = await loadTabStates()
    const tabState = states[message.tabId] ?? UNKNOWN_TAB_STATE
    await setTabState(message.tabId, { ...tabState, kept: true, pending: null })
    disarmClose(message.tabId)
    return { kept: true, pending: null, now: Date.now() }
  }
  throw new Error(`Unknown message type: ${String(message?.type)}`)
}

/** Closes tabs whose deadline passed while the worker slept, re-arms the rest. */
async function reconcile() {
  const states = await loadTabStates()
  const openTabIds = new Set((await chrome.tabs.query({})).map(tab => tab.id))
  for (const [key, tabState] of Object.entries(states)) {
    const tabId = Number(key)
    if (!openTabIds.has(tabId)) {
      await forgetTab(tabId)
      continue
    }
    if (tabState.pending != null) armClose(tabId, tabState.pending)
  }
}

function armClose(tabId, pending) {
  clearTimeout(timers.get(tabId))
  const delay = Math.max(0, pending.closeAt - Date.now())
  timers.set(
    tabId,
    setTimeout(() => run(() => closeIfDue(tabId)), delay)
  )
  chrome.alarms.create(ALARM_PREFIX + tabId, { when: pending.closeAt }).catch(logError)
  startBadgeTicker()
}

function disarmClose(tabId) {
  clearTimeout(timers.get(tabId))
  timers.delete(tabId)
  chrome.alarms.clear(ALARM_PREFIX + tabId).catch(logError)
  chrome.action.setBadgeText({ tabId, text: '' }).catch(ignoreClosedTab)
}

async function closeIfDue(tabId) {
  const states = await loadTabStates()
  const pending = states[tabId]?.pending
  if (pending == null) return
  if (pending.closeAt > Date.now()) {
    armClose(tabId, pending)
    return
  }
  await forgetTab(tabId)
  await chrome.tabs.remove(tabId).catch(ignoreClosedTab)
}

async function forgetTab(tabId) {
  clearTimeout(timers.get(tabId))
  timers.delete(tabId)
  startUrls.delete(tabId)
  await chrome.alarms.clear(ALARM_PREFIX + tabId)
  const states = await loadTabStates()
  if (!(tabId in states)) return
  delete states[tabId]
  await chrome.storage.session.set({ [TABS_KEY]: states })
}

async function setTabState(tabId, tabState) {
  const states = await loadTabStates()
  states[tabId] = tabState
  await chrome.storage.session.set({ [TABS_KEY]: states })
}

async function loadTabStates() {
  if (tabStates == null) {
    const stored = await chrome.storage.session.get(TABS_KEY)
    tabStates = stored[TABS_KEY] ?? {}
  }
  return tabStates
}

async function loadSettings() {
  if (settings == null) settings = normalizeSettings(await chrome.storage.sync.get(null))
  return settings
}

/** Shows each pending tab's remaining seconds on the toolbar badge. */
function startBadgeTicker() {
  if (badgeTicker != null) return
  const tick = () => {
    const pendingTabs = Object.entries(tabStates ?? {}).filter(([, tabState]) => tabState.pending != null)
    if (pendingTabs.length === 0) {
      clearInterval(badgeTicker)
      badgeTicker = undefined
      return
    }
    const now = Date.now()
    for (const [key, tabState] of pendingTabs) {
      const tabId = Number(key)
      chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }).catch(ignoreClosedTab)
      chrome.action.setBadgeText({ tabId, text: String(secondsLeft(tabState.pending, now)) }).catch(ignoreClosedTab)
    }
  }
  badgeTicker = setInterval(tick, 1000)
  tick()
}

/** Serializes handlers so concurrent events never interleave state writes. */
function run(task) {
  const result = queue.then(task)
  queue = result.catch(logError)
  return result
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId)
  } catch (error) {
    ignoreClosedTab(error)
    return undefined
  }
}

function isMainFrame(details) {
  return details.frameId === 0 && (details.documentLifecycle ?? 'active') === 'active'
}

function ignoreClosedTab(error) {
  if (!/No tab with id/i.test(String(error))) logError(error)
}

function logError(error) {
  console.error('[auto-close]', error)
}
