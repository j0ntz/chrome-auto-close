import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createdTabState, planNavigation, planSettingsChange, secondsLeft, UNKNOWN_TAB_STATE } from '../extension/plan.js'
import { DEFAULT_SETTINGS } from '../extension/rules.js'

const SLACK_URL = 'https://edgesecure.slack.com/archives/C0808NMRU93/p1790596658215339'
const NOW = 1_000_000

/** Feeds a sequence of navigations through planNavigation. */
function navigate(tabState, steps, settings = DEFAULT_SETTINGS) {
  const actions = []
  for (const [url, kind, startUrl] of steps) {
    const plan = planNavigation({ settings, tabState, url, startUrl, kind, now: NOW })
    actions.push(plan.action)
    tabState = plan.tabState
  }
  return { actions, tabState }
}

describe('planNavigation', () => {
  it('schedules a tab that opens on a matching URL', () => {
    const { actions, tabState } = navigate(createdTabState(SLACK_URL), [[SLACK_URL, 'commit']])
    assert.deepEqual(actions, ['schedule'])
    assert.deepEqual(tabState.pending, { closeAt: NOW + 5_000, ruleName: 'Slack' })
  })

  it('schedules after a client redirect chain such as a mail link wrapper', () => {
    const { actions } = navigate(createdTabState(''), [
      ['about:blank', 'commit'],
      ['https://www.google.com/url?q=x', 'commit'],
      [SLACK_URL, 'client-redirect']
    ])
    assert.deepEqual(actions, ['none', 'none', 'schedule'])
  })

  it('leaves a URL typed into the new-tab page alone', () => {
    const { actions } = navigate(createdTabState('chrome://newtab/'), [
      ['chrome://new-tab-page/', 'commit'],
      [SLACK_URL, 'commit']
    ])
    assert.deepEqual(actions, ['none', 'none'])
  })

  it('leaves a first commit on a new-tab page tab alone even without an NTP commit', () => {
    const { actions } = navigate(createdTabState('chrome://newtab/'), [[SLACK_URL, 'commit']])
    assert.deepEqual(actions, ['none'])
  })

  it('leaves a link followed inside an existing tab alone', () => {
    const { actions } = navigate(createdTabState('https://mail.example/'), [
      ['https://mail.example/', 'commit'],
      [SLACK_URL, 'commit']
    ])
    assert.deepEqual(actions, ['none', 'none'])
  })

  it('leaves tabs that existed before the worker saw them alone', () => {
    const { actions } = navigate(UNKNOWN_TAB_STATE, [[SLACK_URL, 'commit']])
    assert.deepEqual(actions, ['none'])
  })

  it('schedules when a server redirect moves the opening URL off the pattern', () => {
    const redirected = 'https://edgesecure.slack.com/?redir=%2Farchives%2FC0808NMRU93'
    const { actions } = navigate(createdTabState(SLACK_URL), [[redirected, 'commit', SLACK_URL]])
    assert.deepEqual(actions, ['schedule'])
  })

  it('ignores the start URL of a navigation the tab did not open with', () => {
    const { actions } = navigate(createdTabState('https://mail.example/'), [
      ['https://mail.example/', 'commit'],
      ['https://edgesecure.slack.com/?redir=x', 'commit', SLACK_URL]
    ])
    assert.deepEqual(actions, ['none', 'none'])
  })

  it('keeps the close through the opening redirect chain and in-page routing', () => {
    const { actions, tabState } = navigate(createdTabState(SLACK_URL), [
      [SLACK_URL, 'commit'],
      ['https://edgesecure.slack.com/signin', 'client-redirect'],
      ['https://edgesecure.slack.com/signin?step=2', 'same-document']
    ])
    assert.deepEqual(actions, ['schedule', 'none', 'none'])
    assert.equal(tabState.pending.closeAt, NOW + 5_000)
  })

  it('cancels when the user navigates the tab to a page that does not match', () => {
    const { actions, tabState } = navigate(createdTabState(SLACK_URL), [
      [SLACK_URL, 'commit'],
      ['https://app.slack.com/client/T1/C1', 'commit'],
      [SLACK_URL, 'commit']
    ])
    assert.deepEqual(actions, ['schedule', 'cancel', 'none'])
    assert.equal(tabState.pending, null)
  })

  it('keeps the original deadline when the user moves between matching pages', () => {
    const { actions, tabState } = navigate(createdTabState(SLACK_URL), [
      [SLACK_URL, 'commit'],
      [`${SLACK_URL}?thread=1`, 'commit']
    ])
    assert.deepEqual(actions, ['schedule', 'none'])
    assert.equal(tabState.pending.closeAt, NOW + 5_000)
  })

  it('uses the global default delay for rules without their own', () => {
    const settings = { ...DEFAULT_SETTINGS, defaultDelaySeconds: 30 }
    const { tabState } = navigate(createdTabState(SLACK_URL), [[SLACK_URL, 'commit']], settings)
    assert.equal(tabState.pending.closeAt, NOW + 30_000)
  })

  it("uses a rule's own delay over the global default", () => {
    const rules = DEFAULT_SETTINGS.rules.map(rule => (rule.id === 'slack' ? { ...rule, delaySeconds: 2 } : rule))
    const settings = { ...DEFAULT_SETTINGS, defaultDelaySeconds: 30, rules }
    const { tabState } = navigate(createdTabState(SLACK_URL), [[SLACK_URL, 'commit']], settings)
    assert.equal(tabState.pending.closeAt, NOW + 2_000)
  })

  it('never schedules a kept tab', () => {
    const { actions } = navigate({ ...createdTabState(SLACK_URL), kept: true }, [[SLACK_URL, 'commit']])
    assert.deepEqual(actions, ['none'])
  })

  it('does nothing while disabled', () => {
    const settings = { ...DEFAULT_SETTINGS, enabled: false }
    const { actions } = navigate(createdTabState(SLACK_URL), [[SLACK_URL, 'commit']], settings)
    assert.deepEqual(actions, ['none'])
  })

  it('schedules any matching commit when onlyNewTabs is off', () => {
    const settings = { ...DEFAULT_SETTINGS, onlyNewTabs: false }
    const { actions } = navigate(UNKNOWN_TAB_STATE, [
      [SLACK_URL, 'same-document'],
      [SLACK_URL, 'commit']
    ], settings)
    assert.deepEqual(actions, ['none', 'schedule'])
  })
})

describe('planSettingsChange', () => {
  const pendingState = { ...UNKNOWN_TAB_STATE, pending: { closeAt: NOW, ruleName: 'Slack' } }

  it('cancels when the rule is disabled', () => {
    const settings = { ...DEFAULT_SETTINGS, rules: DEFAULT_SETTINGS.rules.map(rule => ({ ...rule, enabled: false })) }
    assert.equal(planSettingsChange({ settings, tabState: pendingState, url: SLACK_URL }).action, 'cancel')
  })

  it('cancels when the extension is turned off', () => {
    const settings = { ...DEFAULT_SETTINGS, enabled: false }
    assert.equal(planSettingsChange({ settings, tabState: pendingState, url: SLACK_URL }).action, 'cancel')
  })

  it('keeps a close that still matches', () => {
    assert.equal(planSettingsChange({ settings: DEFAULT_SETTINGS, tabState: pendingState, url: SLACK_URL }).action, 'none')
  })
})

describe('secondsLeft', () => {
  it('rounds up and never goes negative', () => {
    assert.equal(secondsLeft({ closeAt: NOW + 1500 }, NOW), 2)
    assert.equal(secondsLeft({ closeAt: NOW - 1 }, NOW), 0)
  })
})
