import { clampDelay, cloneRules, DEFAULT_SETTINGS, findMatchingRule, normalizeRule, normalizeSettings, ruleDelaySeconds } from './rules.js'

const enabledBox = document.getElementById('enabled')
const onlyNewTabsBox = document.getElementById('onlyNewTabs')
const defaultDelayInput = document.getElementById('defaultDelay')
const rulesList = document.getElementById('rules')
const ruleTemplate = document.getElementById('ruleTemplate')
const testUrlInput = document.getElementById('testUrl')
const testResult = document.getElementById('testResult')
const saveStatus = document.getElementById('saveStatus')

init().catch(showError)

async function init() {
  renderSettings(normalizeSettings(await chrome.storage.sync.get(null)))

  document.getElementById('addRule').addEventListener('click', handleAddRule)
  document.getElementById('save').addEventListener('click', handleSave)
  document.getElementById('reset').addEventListener('click', handleReset)
  testUrlInput.addEventListener('input', updateTestResult)
  defaultDelayInput.addEventListener('input', handleEdit)
  rulesList.addEventListener('input', handleEdit)
  rulesList.addEventListener('change', handleEdit)
}

function renderSettings(settings) {
  enabledBox.checked = settings.enabled
  onlyNewTabsBox.checked = settings.onlyNewTabs
  defaultDelayInput.value = String(settings.defaultDelaySeconds)
  rulesList.replaceChildren(...settings.rules.map(renderRule))
  syncRows()
  updateTestResult()
}

function renderRule(rule) {
  const fragment = ruleTemplate.content.cloneNode(true)
  const row = fragment.querySelector('.rule')
  row.dataset.id = rule.id
  row.classList.toggle('disabled', !rule.enabled)
  row.querySelector('.rule-enabled').checked = rule.enabled
  row.querySelector('.rule-name').value = rule.name
  row.querySelector('.rule-delay-mode').value = rule.delaySeconds == null ? 'default' : 'custom'
  row.querySelector('.rule-delay').value = String(rule.delaySeconds ?? readDefaultDelay())
  row.querySelector('.rule-delay-mode').addEventListener('change', event => {
    // A rule switched to its own delay starts from the current default.
    if (event.target.value === 'custom') row.querySelector('.rule-delay').value = String(readDefaultDelay())
  })
  const patternsInput = row.querySelector('.rule-patterns')
  patternsInput.value = rule.patterns.join('\n')
  fitRows(patternsInput)
  patternsInput.addEventListener('input', () => fitRows(patternsInput))
  row.querySelector('.rule-delete').addEventListener('click', () => {
    row.remove()
    handleEdit()
  })
  return row
}

/** Grows the pattern box so every pattern stays visible. */
function fitRows(textarea) {
  textarea.rows = Math.max(2, textarea.value.split('\n').length)
}

function readDefaultDelay() {
  return clampDelay(defaultDelayInput.value)
}

/** Reads the form back into settings, dropping rules without patterns. */
function readSettings() {
  const rules = [...rulesList.querySelectorAll('.rule')]
    .map((row, index) =>
      normalizeRule(
        {
          id: row.dataset.id,
          name: row.querySelector('.rule-name').value,
          enabled: row.querySelector('.rule-enabled').checked,
          delaySeconds: row.querySelector('.rule-delay-mode').value === 'default' ? null : row.querySelector('.rule-delay').value,
          patterns: row.querySelector('.rule-patterns').value.split('\n')
        },
        index
      )
    )
    .filter(rule => rule != null)
  return { enabled: enabledBox.checked, onlyNewTabs: onlyNewTabsBox.checked, defaultDelaySeconds: readDefaultDelay(), rules }
}

/** Updates each rule row's look to match its inputs and the default delay. */
function syncRows() {
  const defaultLabel = `Default (${readDefaultDelay()}s)`
  for (const row of rulesList.querySelectorAll('.rule')) {
    row.classList.toggle('disabled', !row.querySelector('.rule-enabled').checked)
    const mode = row.querySelector('.rule-delay-mode')
    mode.options[0].textContent = defaultLabel
    row.querySelector('.rule-delay-custom').hidden = mode.value === 'default'
  }
}

function handleEdit() {
  syncRows()
  saveStatus.textContent = 'Unsaved changes'
  updateTestResult()
}

function handleAddRule() {
  const row = renderRule({ id: `rule-${Date.now()}`, name: '', enabled: true, delaySeconds: null, patterns: [] })
  rulesList.append(row)
  row.querySelector('.rule-name').focus()
  handleEdit()
}

function handleSave() {
  const settings = readSettings()
  chrome.storage.sync
    .set(settings)
    .then(() => {
      renderSettings(settings)
      saveStatus.textContent = 'Saved'
    })
    .catch(showError)
}

function handleReset() {
  const settings = { ...DEFAULT_SETTINGS, rules: cloneRules(DEFAULT_SETTINGS.rules) }
  chrome.storage.sync
    .set(settings)
    .then(() => {
      renderSettings(settings)
      saveStatus.textContent = 'Reset to defaults'
    })
    .catch(showError)
}

function updateTestResult() {
  const url = testUrlInput.value.trim()
  if (url === '') {
    testResult.textContent = ''
    return
  }
  const settings = readSettings()
  const rule = findMatchingRule(url, settings.rules)
  testResult.textContent =
    rule == null
      ? 'No enabled rule matches this URL.'
      : `Matches ${rule.name}: closes ${ruleDelaySeconds(rule, settings)}s after opening.`
}

function showError(error) {
  saveStatus.textContent = `Error: ${String(error)}`
}
