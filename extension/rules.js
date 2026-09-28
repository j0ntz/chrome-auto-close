// Rule matching and settings shared by the service worker, the extension
// pages and the unit tests. Pure functions only: no chrome.* access.

export const DEFAULT_DELAY_SECONDS = 5
export const MIN_DELAY_SECONDS = 1
export const MAX_DELAY_SECONDS = 3600

// A rule's `delaySeconds` of null means it follows the global default delay.
export const DEFAULT_RULES = [
  {
    id: 'slack',
    name: 'Slack',
    enabled: true,
    delaySeconds: null,
    patterns: ['https://*.slack.com/archives/*', 'https://*.slack.com/app_redirect*']
  },
  {
    id: 'zoom',
    name: 'Zoom',
    enabled: true,
    delaySeconds: null,
    patterns: ['https://*.zoom.us/j/*', 'https://*.zoom.us/s/*', 'https://*.zoom.us/my/*']
  },
  {
    id: 'asana',
    name: 'Asana',
    enabled: true,
    delaySeconds: null,
    patterns: ['https://app.asana.com/*']
  },
  {
    id: 'discord',
    name: 'Discord',
    enabled: true,
    delaySeconds: null,
    patterns: ['https://discord.com/channels/*', 'https://discord.com/invite/*', 'https://discord.gg/*']
  },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    enabled: true,
    delaySeconds: null,
    patterns: ['https://teams.microsoft.com/l/*']
  }
]

export const DEFAULT_SETTINGS = {
  enabled: true,
  onlyNewTabs: true,
  defaultDelaySeconds: DEFAULT_DELAY_SECONDS,
  rules: DEFAULT_RULES
}

const patternCache = new Map()

/**
 * Compiles a URL glob into a RegExp. `*` matches any run of characters, except
 * inside the host, where it stops at the end of the host. A host that starts
 * with `*.` also matches the bare domain, as Chrome match patterns do, so
 * `https://*.slack.com/*` matches `https://slack.com/x` but not
 * `https://evil.com/?slack.com/x`. Matching ignores case.
 */
export function compilePattern(pattern) {
  const cached = patternCache.get(pattern)
  if (cached != null) return cached

  const trimmed = pattern.trim()
  const schemeEnd = trimmed.indexOf('://')
  let source
  if (schemeEnd < 0) {
    source = globToRegex(trimmed, '.*')
  } else {
    const hostStart = schemeEnd + 3
    const pathStart = findHostEnd(trimmed, hostStart)
    const scheme = trimmed.slice(0, hostStart)
    const host = trimmed.slice(hostStart, pathStart)
    const rest = trimmed.slice(pathStart)
    const hostSource = host.startsWith('*.')
      ? `(?:[^/?#]*\\.)?${globToRegex(host.slice(2), '[^/?#]*')}`
      : globToRegex(host, '[^/?#]*')
    source = globToRegex(scheme, '.*') + hostSource + globToRegex(rest, '.*')
  }
  const regex = new RegExp(`^${source}$`, 'i')
  patternCache.set(pattern, regex)
  return regex
}

export function matchesPattern(url, pattern) {
  return compilePattern(pattern).test(url)
}

/** Returns the first enabled rule with a pattern matching the URL. */
export function findMatchingRule(url, rules) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return undefined
  return rules.find(rule => rule.enabled && rule.patterns.some(pattern => matchesPattern(url, pattern)))
}

/**
 * Fills in defaults and drops malformed values, so stored settings from an
 * older version or a hand-edited sync store can never break the worker.
 * Missing rules (a fresh install) become the default rules.
 */
export function normalizeSettings(raw) {
  const stored = raw != null && typeof raw === 'object' ? raw : {}
  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULT_SETTINGS.enabled,
    onlyNewTabs: typeof stored.onlyNewTabs === 'boolean' ? stored.onlyNewTabs : DEFAULT_SETTINGS.onlyNewTabs,
    defaultDelaySeconds: clampDelay(stored.defaultDelaySeconds),
    rules: Array.isArray(stored.rules) ? stored.rules.map(normalizeRule).filter(rule => rule != null) : cloneRules(DEFAULT_RULES)
  }
}

export function normalizeRule(raw, index = 0) {
  if (raw == null || typeof raw !== 'object') return undefined
  const patterns = (Array.isArray(raw.patterns) ? raw.patterns : [])
    .filter(pattern => typeof pattern === 'string')
    .map(pattern => pattern.trim())
    .filter(pattern => pattern !== '')
  if (patterns.length === 0) return undefined
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : patterns[0]
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `rule-${index}`,
    name,
    enabled: raw.enabled !== false,
    delaySeconds: normalizeRuleDelay(raw.delaySeconds),
    patterns
  }
}

/** The rule's own delay, or the global default when the rule has none. */
export function ruleDelaySeconds(rule, settings) {
  return rule.delaySeconds ?? settings.defaultDelaySeconds
}

/** A rule delay is either a clamped number of seconds or null (use the default). */
function normalizeRuleDelay(value) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return null
  return clampDelay(value)
}

export function clampDelay(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return DEFAULT_DELAY_SECONDS
  return Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, Math.round(seconds)))
}

export function cloneRules(rules) {
  return rules.map(rule => ({ ...rule, patterns: [...rule.patterns] }))
}

function findHostEnd(pattern, hostStart) {
  for (let index = hostStart; index < pattern.length; ++index) {
    if ('/?#'.includes(pattern[index])) return index
  }
  return pattern.length
}

function globToRegex(glob, wildcard) {
  return glob
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join(wildcard)
}
