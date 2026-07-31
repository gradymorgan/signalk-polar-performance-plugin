'use strict'

const { describe, it, beforeEach, afterEach, mock } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')

// ---------------------------------------------------------------------------
// Regression test for the startup subscription race: a handler occasionally
// never receives its first delta after start() (observed live on
// environment.wind.speedTrue while environment.wind.angleTrueWater and
// navigation.speedThroughWater subscribed fine in the same start() call).
//
// A single retry is not enough: on the real boat, the upstream wind
// calculator (AdvancedWind) sometimes doesn't start publishing true wind
// until well after the plugin starts (it needs GPS/apparent wind/boat speed
// first). A one-shot "retry once, then give up" watchdog stops listening
// before the source ever starts — the plugin had to be restarted manually
// after true wind data appeared. Resubscribing is cheap, so the watchdog
// retries forever instead: quickly at first, backing off to a steady 30s
// poll, with a one-time status note (not a hard stop) if it's been stuck a
// long while.
// ---------------------------------------------------------------------------

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000]
const WARN_AFTER_MS = 5 * 60 * 1000

function makeDelta(path, value) {
  return {
    context: 'vessels.self',
    updates: [{
      $source: 'test-source',
      timestamp: new Date(0).toISOString(),
      values: [{ path, value }]
    }]
  }
}

// initialValues: map of path -> value delivered synchronously on first
// subscribe (paths not present in the map never receive a delta on
// subscribe, simulating the stuck-handler race).
function makeWatchdogApp(dataDir, initialValues) {
  const subscribeCalls = []
  const errors = []
  const callbacksByPath = {}
  const liveValues = { ...initialValues }

  const app = {
    debug: () => {},
    error: () => {},
    setPluginStatus: () => {},
    setPluginError: (msg) => errors.push(msg),
    savePluginOptions: (_options, callback) => callback && callback(),
    getDataDirPath: () => dataDir,
    handleMessage: () => {},
    config: { port: 3000 },
    subscriptionmanager: {
      subscribe: (command, unsubscribes, _errorCallback, callback) => {
        const subPath = command.subscribe[0].path
        subscribeCalls.push(subPath)
        callbacksByPath[subPath] = callback
        unsubscribes.push(() => {})
        if (Object.prototype.hasOwnProperty.call(liveValues, subPath)) {
          callback(makeDelta(subPath, liveValues[subPath]))
        }
      }
    }
  }

  // Simulates a live 1 Hz feed for every currently-publishing path, keeping
  // those handlers' staleness timers fresh across the ticks the test
  // advances — mirrors continuously-updating instruments on a real boat.
  function feedLiveValues() {
    for (const p of Object.keys(liveValues)) {
      const cb = callbacksByPath[p]
      if (cb) cb(makeDelta(p, liveValues[p]))
    }
  }

  // Simulates an upstream source that starts publishing a path only after
  // the plugin has already started (and already subscribed to it) — the
  // exact real-world case that broke the one-shot version of the watchdog.
  function startPublishing(p, value) {
    liveValues[p] = value
    const cb = callbacksByPath[p]
    if (cb) cb(makeDelta(p, value))
  }

  return { app, subscribeCalls, errors, feedLiveValues, startPublishing }
}

function freshPlugin(app) {
  delete require.cache[require.resolve('../plugin/index.js')]
  return require('../plugin/index.js')(app)
}

// Advances the fake clock in 1s steps, re-feeding whatever's currently
// publishing on every step so healthy handlers never go idle/stale.
function advance(feedLiveValues, totalMs) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += 1000) {
    mock.timers.tick(1000)
    feedLiveValues()
  }
}

// Cumulative time (ms) at which the Nth resubscribe attempt (1-indexed) fires,
// per the backoff schedule (quick at first, capped at the last entry).
function timeOfAttemptFixed(n) {
  if (n <= 0) return 0
  let t = BACKOFF_MS[0]
  for (let i = 1; i < n; i++) {
    t += BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]
  }
  return t
}

describe('Subscription watchdog', () => {
  let dataDir

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polar-watchdog-'))
    mock.timers.enable({ apis: ['setTimeout'] })
  })

  afterEach(() => {
    mock.timers.reset()
    fs.rmSync(dataDir, { recursive: true, force: true })
    delete require.cache[require.resolve('../plugin/index.js')]
  })

  it('keeps resubscribing a stuck handler with a quick-then-30s backoff, leaves healthy handlers alone', () => {
    const { app, subscribeCalls, errors, feedLiveValues } = makeWatchdogApp(dataDir, {
      'environment.wind.angleTrueWater': 2.6,
      'navigation.speedThroughWater': 3.2
      // environment.wind.speedTrue deliberately absent — never gets a delta
    })
    const plugin = freshPlugin(app)
    plugin.start({})

    assert.equal(subscribeCalls.filter(p => p === 'environment.wind.speedTrue').length, 1)

    // First retry fires quickly (1s), not on a 15s/30s cadence.
    advance(feedLiveValues, BACKOFF_MS[0])
    assert.equal(
      subscribeCalls.filter(p => p === 'environment.wind.speedTrue').length,
      2,
      'first retry should fire after the short initial backoff, not a long interval'
    )

    // Advance through several more attempts — should keep retrying, backing off.
    advance(feedLiveValues, timeOfAttemptFixed(5) - timeOfAttemptFixed(1))
    assert.equal(
      subscribeCalls.filter(p => p === 'environment.wind.speedTrue').length,
      1 + 5,
      'should have kept retrying through the backoff schedule (initial subscribe + 5 retries)'
    )
    assert.equal(
      subscribeCalls.filter(p => p === 'environment.wind.angleTrueWater').length,
      1,
      'healthy angle handler should not have been resubscribed'
    )
    assert.equal(
      subscribeCalls.filter(p => p === 'navigation.speedThroughWater').length,
      1,
      'healthy boat-speed handler should not have been resubscribed'
    )
    assert.equal(errors.length, 0, 'well within the warn threshold — no status note yet')

    plugin.stop()
  })

  it('keeps retrying indefinitely at a steady 30s cadence once backed off, never gives up', () => {
    const { app, subscribeCalls, feedLiveValues } = makeWatchdogApp(dataDir, {
      'environment.wind.angleTrueWater': 2.6,
      'navigation.speedThroughWater': 3.2
    })
    const plugin = freshPlugin(app)
    plugin.start({})

    // Run well past the point where the backoff has settled at its 30s cap.
    const settleTime = timeOfAttemptFixed(BACKOFF_MS.length + 2)
    advance(feedLiveValues, settleTime)
    const attemptsAtSettle = subscribeCalls.filter(p => p === 'environment.wind.speedTrue').length

    // One more 30s step should mean exactly one more attempt — steady polling,
    // not stopped and not accelerating/decelerating.
    advance(feedLiveValues, 30000)
    assert.equal(
      subscribeCalls.filter(p => p === 'environment.wind.speedTrue').length,
      attemptsAtSettle + 1,
      'should still be retrying on a steady 30s cadence, indefinitely'
    )

    plugin.stop()
  })

  it('recovers automatically once the source starts publishing after several retries, without a manual restart', () => {
    const { app, subscribeCalls, errors, feedLiveValues, startPublishing } = makeWatchdogApp(dataDir, {
      'environment.wind.angleTrueWater': 2.6,
      'navigation.speedThroughWater': 3.2
    })
    const plugin = freshPlugin(app)
    plugin.start({})

    // A few retries pass with the source still not publishing...
    advance(feedLiveValues, timeOfAttemptFixed(3))
    const attemptsBeforeRecovery = subscribeCalls.filter(p => p === 'environment.wind.speedTrue').length

    // ...then the source (e.g. AdvancedWind finishing its own startup) begins publishing.
    startPublishing('environment.wind.speedTrue', 4.5)

    // Further watchdog checks should not resubscribe an already-healthy handler.
    advance(feedLiveValues, 60000)

    assert.equal(
      subscribeCalls.filter(p => p === 'environment.wind.speedTrue').length,
      attemptsBeforeRecovery,
      'no further resubscribes once the handler is receiving data'
    )
    assert.equal(errors.length, 0, 'recovered well before the warn threshold')

    plugin.stop()
  })

  it('surfaces a one-time status note if still stuck after a long while, but keeps retrying', () => {
    const { app, subscribeCalls, errors, feedLiveValues } = makeWatchdogApp(dataDir, {
      'environment.wind.angleTrueWater': 2.6,
      'navigation.speedThroughWater': 3.2
    })
    const plugin = freshPlugin(app)
    plugin.start({})

    advance(feedLiveValues, WARN_AFTER_MS + 30000)

    assert.equal(errors.length, 1, 'exactly one status note, not one per retry')
    assert.ok(
      errors[0].includes('true wind speed') && errors[0].includes('environment.wind.speedTrue'),
      `expected the note to name the stuck path, got: ${errors[0]}`
    )

    // Retrying continues after the note — advancing further should still resubscribe.
    const attemptsAtWarn = subscribeCalls.filter(p => p === 'environment.wind.speedTrue').length
    advance(feedLiveValues, 30000)
    assert.equal(
      subscribeCalls.filter(p => p === 'environment.wind.speedTrue').length,
      attemptsAtWarn + 1,
      'should keep retrying after the status note, not stop'
    )
    assert.equal(errors.length, 1, 'still only one note — not repeated on every subsequent retry')

    plugin.stop()
  })

  it('does not resubscribe or report anything when every handler receives data normally', () => {
    const { app, subscribeCalls, errors, feedLiveValues } = makeWatchdogApp(dataDir, {
      'environment.wind.speedTrue': 4.5,
      'environment.wind.angleTrueWater': 2.6,
      'navigation.speedThroughWater': 3.2
    })
    const plugin = freshPlugin(app)
    plugin.start({})

    advance(feedLiveValues, 60000)

    assert.equal(subscribeCalls.filter(p => p === 'environment.wind.speedTrue').length, 1)
    assert.equal(subscribeCalls.filter(p => p === 'environment.wind.angleTrueWater').length, 1)
    assert.equal(subscribeCalls.filter(p => p === 'navigation.speedThroughWater').length, 1)
    assert.equal(errors.length, 0)

    plugin.stop()
  })
})
