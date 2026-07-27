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
// The plugin's subscription watchdog should force a resubscribe after a
// grace period, and report a plugin error if the handler is still stuck
// after a second grace period.
// ---------------------------------------------------------------------------

const WATCHDOG_MS = 15000

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
        if (Object.prototype.hasOwnProperty.call(initialValues, subPath)) {
          callback(makeDelta(subPath, initialValues[subPath]))
        }
      }
    }
  }

  // Simulates a live 1 Hz feed for every path in initialValues, keeping
  // those handlers' staleness timers fresh across the ticks the test
  // advances — mirrors continuously-updating instruments on a real boat.
  function feedLiveValues() {
    for (const p of Object.keys(initialValues)) {
      const cb = callbacksByPath[p]
      if (cb) cb(makeDelta(p, initialValues[p]))
    }
  }

  return { app, subscribeCalls, errors, feedLiveValues }
}

function freshPlugin(app) {
  delete require.cache[require.resolve('../plugin/index.js')]
  return require('../plugin/index.js')(app)
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

  it('force-resubscribes a handler stuck with no data, leaves healthy handlers alone', () => {
    const { app, subscribeCalls, errors, feedLiveValues } = makeWatchdogApp(dataDir, {
      'environment.wind.angleTrueWater': 2.6,
      'navigation.speedThroughWater': 3.2
      // environment.wind.speedTrue deliberately absent — never gets a delta
    })
    const plugin = freshPlugin(app)
    plugin.start({})

    assert.equal(subscribeCalls.filter(p => p === 'environment.wind.speedTrue').length, 1)

    // Advance to the first watchdog check in 1s steps, re-feeding the
    // healthy paths each step so they never go idle/stale themselves.
    for (let i = 0; i < WATCHDOG_MS / 1000; i++) {
      mock.timers.tick(1000)
      feedLiveValues()
    }

    assert.equal(
      subscribeCalls.filter(p => p === 'environment.wind.speedTrue').length,
      2,
      'stuck handler should have been resubscribed once'
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
    assert.equal(errors.length, 0, 'no error yet — still within the second grace period')

    plugin.stop()
  })

  it('reports a plugin error if the handler is still stuck after the resubscribe grace period', () => {
    const { app, errors, feedLiveValues } = makeWatchdogApp(dataDir, {
      'environment.wind.angleTrueWater': 2.6,
      'navigation.speedThroughWater': 3.2
    })
    const plugin = freshPlugin(app)
    plugin.start({})

    for (let i = 0; i < (2 * WATCHDOG_MS) / 1000; i++) {
      mock.timers.tick(1000)
      feedLiveValues()
    }

    assert.ok(
      errors.some(e => e.includes('true wind speed') && e.includes('environment.wind.speedTrue')),
      `expected a plugin error naming the stuck path, got: ${JSON.stringify(errors)}`
    )

    plugin.stop()
  })

  it('does not resubscribe or report errors when every handler receives data normally', () => {
    const { app, subscribeCalls, errors, feedLiveValues } = makeWatchdogApp(dataDir, {
      'environment.wind.speedTrue': 4.5,
      'environment.wind.angleTrueWater': 2.6,
      'navigation.speedThroughWater': 3.2
    })
    const plugin = freshPlugin(app)
    plugin.start({})

    for (let i = 0; i < (2 * WATCHDOG_MS) / 1000; i++) {
      mock.timers.tick(1000)
      feedLiveValues()
    }

    assert.equal(subscribeCalls.filter(p => p === 'environment.wind.speedTrue').length, 1)
    assert.equal(subscribeCalls.filter(p => p === 'environment.wind.angleTrueWater').length, 1)
    assert.equal(subscribeCalls.filter(p => p === 'navigation.speedThroughWater').length, 1)
    assert.equal(errors.length, 0)

    plugin.stop()
  })
})
