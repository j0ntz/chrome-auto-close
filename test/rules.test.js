import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  clampDelay,
  DEFAULT_DELAY_SECONDS,
  DEFAULT_RULES,
  findMatchingRule,
  matchesPattern,
  normalizeSettings,
  ruleDelaySeconds
} from '../extension/rules.js'

describe('matchesPattern', () => {
  it('lets a *. host match subdomains and the bare domain', () => {
    assert.ok(matchesPattern('https://edgesecure.slack.com/archives/C1', 'https://*.slack.com/archives/*'))
    assert.ok(matchesPattern('https://slack.com/archives/C1', 'https://*.slack.com/archives/*'))
  })

  it('keeps host wildcards inside the host', () => {
    assert.ok(!matchesPattern('https://evil.com/?x=.slack.com/archives/C1', 'https://*.slack.com/archives/*'))
    assert.ok(!matchesPattern('https://slack.com.evil.com/archives/C1', 'https://*.slack.com/archives/*'))
  })

  it('lets path wildcards cross slashes and queries', () => {
    assert.ok(matchesPattern('https://app.asana.com/0/1/2?focus=true', 'https://app.asana.com/*'))
  })

  it('anchors both ends and escapes regex characters', () => {
    assert.ok(!matchesPattern('https://app.asana.com.evil.com/x', 'https://app.asana.com/*'))
    assert.ok(!matchesPattern('https://appxasana.com/x', 'https://app.asana.com/*'))
  })

  it('ignores case', () => {
    assert.ok(matchesPattern('HTTPS://EdgeSecure.Slack.com/archives/C1', 'https://*.slack.com/archives/*'))
  })

  it('matches ports literally', () => {
    assert.ok(matchesPattern('http://127.0.0.1:8080/launch/1', 'http://127.0.0.1:8080/launch*'))
    assert.ok(!matchesPattern('http://127.0.0.1:9090/launch/1', 'http://127.0.0.1:8080/launch*'))
  })

  it('treats a scheme-less pattern as a plain glob', () => {
    assert.ok(matchesPattern('https://example.com/meet/1', '*example.com/meet/*'))
  })
})

describe('default rules', () => {
  const cases = [
    ['https://edgesecure.slack.com/archives/C0808NMRU93/p1790596658215339', 'Slack'],
    ['https://slack.com/app_redirect?channel=C1', 'Slack'],
    ['https://us02web.zoom.us/j/123456789?pwd=abc', 'Zoom'],
    ['https://zoom.us/j/123456789', 'Zoom'],
    ['https://app.asana.com/0/1215088146871429/1218950707685619', 'Asana'],
    ['https://discord.com/channels/1/2', 'Discord'],
    ['https://discord.gg/abc', 'Discord'],
    ['https://teams.microsoft.com/l/meetup-join/19%3ameeting', 'Microsoft Teams']
  ]
  for (const [url, name] of cases) {
    it(`matches ${url}`, () => {
      assert.equal(findMatchingRule(url, DEFAULT_RULES)?.name, name)
    })
  }

  it('leaves the Slack, Zoom and Discord web apps alone', () => {
    for (const url of [
      'https://app.slack.com/client/T1/C1',
      'https://app.zoom.us/wc/home',
      'https://zoom.us/signin',
      'https://discord.com/app'
    ]) {
      assert.equal(findMatchingRule(url, DEFAULT_RULES), undefined, url)
    }
  })
})

describe('findMatchingRule', () => {
  it('skips disabled rules', () => {
    const rules = DEFAULT_RULES.map(rule => ({ ...rule, enabled: rule.id !== 'slack' }))
    assert.equal(findMatchingRule('https://edgesecure.slack.com/archives/C1', rules), undefined)
  })

  it('ignores non-web URLs', () => {
    const rules = [{ id: 'all', name: 'All', enabled: true, delaySeconds: 1, patterns: ['*'] }]
    assert.equal(findMatchingRule('chrome://newtab/', rules), undefined)
    assert.equal(findMatchingRule(undefined, rules), undefined)
    assert.equal(findMatchingRule('https://example.com/', rules)?.id, 'all')
  })
})

describe('normalizeSettings', () => {
  it('fills in defaults for a fresh install', () => {
    const settings = normalizeSettings({})
    assert.equal(settings.enabled, true)
    assert.equal(settings.onlyNewTabs, true)
    assert.equal(settings.defaultDelaySeconds, DEFAULT_DELAY_SECONDS)
    assert.deepEqual(settings.rules, DEFAULT_RULES)
    assert.ok(settings.rules.every(rule => rule.delaySeconds == null))
    assert.notEqual(settings.rules, DEFAULT_RULES)
  })

  it('keeps an empty rule list the user saved', () => {
    assert.deepEqual(normalizeSettings({ rules: [] }).rules, [])
  })

  it('drops malformed rules and blank patterns', () => {
    const settings = normalizeSettings({
      rules: [null, { name: 'Empty', patterns: [' ', 3] }, { patterns: [' https://a.example/* '], delaySeconds: '5' }]
    })
    assert.deepEqual(settings.rules, [
      { id: 'rule-2', name: 'https://a.example/*', enabled: true, delaySeconds: 5, patterns: ['https://a.example/*'] }
    ])
  })

  it('keeps a saved per-rule delay and treats a missing or invalid one as the default', () => {
    const delays = [10, null, undefined, '', 'abc'].map(
      delaySeconds => normalizeSettings({ rules: [{ patterns: ['https://a.example/*'], delaySeconds }] }).rules[0].delaySeconds
    )
    assert.deepEqual(delays, [10, null, null, null, null])
  })

  it('bounds the default delay and falls back when it is missing or invalid', () => {
    assert.equal(normalizeSettings({ defaultDelaySeconds: 20 }).defaultDelaySeconds, 20)
    assert.equal(normalizeSettings({ defaultDelaySeconds: 0 }).defaultDelaySeconds, 1)
    assert.equal(normalizeSettings({ defaultDelaySeconds: 'x' }).defaultDelaySeconds, DEFAULT_DELAY_SECONDS)
  })
})

describe('ruleDelaySeconds', () => {
  it('prefers the rule delay and falls back to the default', () => {
    const settings = { defaultDelaySeconds: 7 }
    assert.equal(ruleDelaySeconds({ delaySeconds: 3 }, settings), 3)
    assert.equal(ruleDelaySeconds({ delaySeconds: null }, settings), 7)
  })
})

describe('clampDelay', () => {
  it('bounds and rounds delays', () => {
    assert.equal(clampDelay(0), 1)
    assert.equal(clampDelay(99999), 3600)
    assert.equal(clampDelay('2.6'), 3)
    assert.equal(clampDelay('abc'), DEFAULT_DELAY_SECONDS)
  })
})
