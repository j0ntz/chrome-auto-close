import { secondsLeft } from './plan.js'
import { findMatchingRule, normalizeSettings } from './rules.js'

const statusText = document.getElementById('status')
const keepButton = document.getElementById('keep')
const enabledBox = document.getElementById('enabled')
const optionsLink = document.getElementById('options')

let tab
let refreshTimer

init().catch(showError)

async function init() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
  tab = activeTab
  const settings = normalizeSettings(await chrome.storage.sync.get(null))
  enabledBox.checked = settings.enabled

  enabledBox.addEventListener('change', handleEnabledChange)
  keepButton.addEventListener('click', handleKeep)
  optionsLink.addEventListener('click', handleOpenOptions)

  await refresh()
  refreshTimer = setInterval(() => {
    refresh().catch(showError)
  }, 1000)
}

async function refresh() {
  if (tab?.id == null) {
    render('This tab cannot be tracked.', false)
    return
  }
  const status = await chrome.runtime.sendMessage({ type: 'getTabStatus', tabId: tab.id })
  if (status.pending != null) {
    const seconds = secondsLeft(status.pending, status.now)
    render(`Closing in ${seconds}s (${status.pending.ruleName} rule).`, true)
    return
  }
  if (status.kept) {
    render('Kept open. This tab will not auto-close.', false)
    return
  }
  const settings = normalizeSettings(await chrome.storage.sync.get(null))
  const rule = findMatchingRule(tab.url, settings.rules)
  render(
    rule == null
      ? 'No rule matches this tab.'
      : `Matches the ${rule.name} rule, but this tab did not open on that URL, so it stays open.`,
    false
  )
}

function render(text, canKeep) {
  statusText.textContent = text
  keepButton.hidden = !canKeep
}

async function handleKeepAsync() {
  clearInterval(refreshTimer)
  await chrome.runtime.sendMessage({ type: 'keepTab', tabId: tab.id })
  render('Kept open. This tab will not auto-close.', false)
}

function handleKeep() {
  handleKeepAsync().catch(showError)
}

function handleEnabledChange() {
  chrome.storage.sync.set({ enabled: enabledBox.checked }).catch(showError)
}

function handleOpenOptions(event) {
  event.preventDefault()
  chrome.runtime.openOptionsPage().catch(showError)
}

function showError(error) {
  clearInterval(refreshTimer)
  statusText.textContent = `Error: ${String(error)}`
}
