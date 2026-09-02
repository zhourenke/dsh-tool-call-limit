import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config } from '../lib/index.js'

function createHarness(rawConfig = {}) {
  const listeners = new Map()
  const ctx = {
    on(name, listener) {
      listeners.set(name, listener)
      return () => true
    },
  }

  apply(ctx, Config(rawConfig))

  return {
    async preStep(payload, decision = { kind: 'enter', messages: [] }) {
      const listener = listeners.get('agent/pre-step')
      assert.equal(typeof listener, 'function')
      return listener(payload, async () => decision)
    },
    preStepThrows(payload) {
      const listener = listeners.get('agent/pre-step')
      assert.equal(typeof listener, 'function')
      return listener(payload, () => {
        throw new Error('step preparation failed')
      })
    },
    async preExecute(exec, next = async () => ({ kind: 'allow' })) {
      const listener = listeners.get('tools/pre-execute')
      assert.equal(typeof listener, 'function')
      return listener(exec, next)
    },
    dispose(agent) {
      const listener = listeners.get('agent/disposed')
      assert.equal(typeof listener, 'function')
      listener({ agent })
    },
    turnStopping(agent, turn) {
      const listener = listeners.get('agent/turn-stopping')
      assert.equal(typeof listener, 'function')
      listener({ agent, turn, signal: new AbortController().signal })
    },
    error(agent, turn, step) {
      const listener = listeners.get('agent/error')
      assert.equal(typeof listener, 'function')
      listener({ agent, turn, step, error: new Error('agent failure') })
    },
  }
}

test('the default configuration has no limits', () => {
  assert.deepEqual(Config(), { limits: {} })
  assert.deepEqual(Config({ limits: null }), { limits: {} })
})

test('configuration accepts non-negative safe integers and rejects invalid quotas', () => {
  assert.deepEqual(Config({ limits: { web_search: 0, grep: 2 } }), {
    limits: { web_search: 0, grep: 2 },
  })

  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.throws(() => Config({ limits: { web_search: value } }))
  }

  assert.throws(() => Config({ limits: { web_search: [] } }))
  assert.throws(() => Config({ limits: { '*': 1 } }))
  assert.throws(() => Config({ limits: { web_search: 1 }, verbose: true }))
})

test('each configured tool has its own counter', async () => {
  const harness = createHarness({ limits: { web_search: 1, grep: 2 } })
  const agent = {}
  await harness.preStep({ agent, turn: 1, step: 0 })

  assert.deepEqual(await harness.preExecute({ name: 'web_search', agent }), { kind: 'allow' })
  assert.deepEqual(await harness.preExecute({ name: 'grep', agent }), { kind: 'allow' })
  assert.deepEqual(await harness.preExecute({ name: 'grep', agent }), { kind: 'allow' })
  assert.deepEqual(await harness.preExecute({ name: 'grep', agent }), {
    kind: 'deny',
    reason: 'tool grep exceeded its per-step limit of 2',
  })
})

test('limits reset for each step and remain isolated between Agents', async () => {
  const harness = createHarness({ limits: { web_search: 1 } })
  const firstAgent = {}
  const secondAgent = {}

  await harness.preStep({ agent: firstAgent, turn: 1, step: 0 })
  assert.deepEqual(await harness.preExecute({ name: 'web_search', agent: firstAgent }), { kind: 'allow' })
  assert.deepEqual(await harness.preExecute({ name: 'web_search', agent: firstAgent }), {
    kind: 'deny',
    reason: 'tool web_search exceeded its per-step limit of 1',
  })

  await harness.preStep({ agent: firstAgent, turn: 1, step: 1 })
  assert.deepEqual(await harness.preExecute({ name: 'web_search', agent: firstAgent }), { kind: 'allow' })

  await harness.preStep({ agent: secondAgent, turn: 1, step: 0 })
  assert.deepEqual(await harness.preExecute({ name: 'web_search', agent: secondAgent }), { kind: 'allow' })
})

test('a downstream denial does not refund an accepted reservation', async () => {
  const harness = createHarness({ limits: { web_search: 2 } })
  const agent = {}
  await harness.preStep({ agent, turn: 1, step: 0 })

  assert.deepEqual(await harness.preExecute(
    { name: 'web_search', agent },
    async () => ({ kind: 'deny', reason: 'downstream policy' }),
  ), { kind: 'deny', reason: 'downstream policy' })
  assert.deepEqual(await harness.preExecute({ name: 'web_search', agent }), { kind: 'allow' })
  assert.deepEqual(await harness.preExecute({ name: 'web_search', agent }), {
    kind: 'deny',
    reason: 'tool web_search exceeded its per-step limit of 2',
  })
})

test('a rejected step does not leave an active quota state', async () => {
  const harness = createHarness({ limits: { web_search: 1 } })
  const agent = {}
  await harness.preStep({ agent, turn: 1, step: 0 }, { kind: 'reject' })
  assert.deepEqual(await harness.preExecute({ name: 'web_search', agent }), {
    kind: 'deny',
    reason: 'per-step tool limit has no active agent step',
  })
})

test('a synchronously failed step preparation cleans up its state', async () => {
  const harness = createHarness({ limits: { web_search: 1 } })
  const agent = {}
  assert.throws(() => harness.preStepThrows({ agent, turn: 1, step: 0 }))
  assert.deepEqual(await harness.preExecute({ name: 'web_search', agent }), {
    kind: 'deny',
    reason: 'per-step tool limit has no active agent step',
  })
})

test('turn stopping and agent errors clear only their matching active state', async () => {
  const harness = createHarness({ limits: { web_search: 1 } })
  const agent = {}

  await harness.preStep({ agent, turn: 1, step: 0 })
  harness.turnStopping(agent, 999)
  assert.deepEqual(await harness.preExecute({ name: 'web_search', agent }), { kind: 'allow' })

  await harness.preStep({ agent, turn: 2, step: 0 })
  harness.error(agent, 1, 0)
  assert.deepEqual(await harness.preExecute({ name: 'web_search', agent }), { kind: 'allow' })
  harness.error(agent, 2, 999)
  assert.deepEqual(await harness.preExecute({ name: 'web_search', agent }), {
    kind: 'deny',
    reason: 'tool web_search exceeded its per-step limit of 1',
  })

  harness.turnStopping(agent, 2)
  assert.deepEqual(await harness.preExecute({ name: 'web_search', agent }), {
    kind: 'deny',
    reason: 'per-step tool limit has no active agent step',
  })
})

test('unconfigured tools stay unlimited, including without an active step', async () => {
  const harness = createHarness({ limits: { web_search: 1 } })
  let downstreamCalls = 0
  const next = async () => {
    downstreamCalls++
    return { kind: 'allow' }
  }

  assert.deepEqual(await harness.preExecute({ name: 'web_fetch' }, next), { kind: 'allow' })
  assert.deepEqual(await harness.preExecute({ name: 'web_fetch' }, next), { kind: 'allow' })
  assert.equal(downstreamCalls, 2)
})

test('a restricted tool without an Agent or active step is denied', async () => {
  const harness = createHarness({ limits: { web_search: 1 } })
  assert.deepEqual(await harness.preExecute({ name: 'web_search' }), {
    kind: 'deny',
    reason: 'per-step tool limit requires an agent context',
  })

  const agent = {}
  await assert.doesNotReject(harness.preStep({ agent, turn: 1, step: 0 }))
  harness.dispose(agent)
  assert.deepEqual(await harness.preExecute({ name: 'web_search', agent }), {
    kind: 'deny',
    reason: 'per-step tool limit has no active agent step',
  })
})

test('synchronous reservation allows only one concurrent call in a one-call step', async () => {
  const harness = createHarness({ limits: { web_search: 1 } })
  const agent = {}
  await harness.preStep({ agent, turn: 1, step: 0 })

  let downstreamCalls = 0
  const next = async () => {
    downstreamCalls++
    await new Promise((resolve) => setImmediate(resolve))
    return { kind: 'allow' }
  }

  const results = await Promise.all([
    harness.preExecute({ name: 'web_search', agent }, next),
    harness.preExecute({ name: 'web_search', agent }, next),
  ])

  assert.equal(results.filter((result) => result.kind === 'allow').length, 1)
  assert.equal(results.filter((result) => result.kind === 'deny').length, 1)
  assert.equal(downstreamCalls, 1)
})

test('prototype-sensitive tool names do not inherit object properties', async () => {
  const rawConfig = JSON.parse('{"limits":{"constructor":1,"toString":1,"__proto__":1}}')
  const harness = createHarness(rawConfig)
  const agent = {}
  await harness.preStep({ agent, turn: 1, step: 0 })

  for (const name of ['constructor', 'toString', '__proto__']) {
    assert.deepEqual(await harness.preExecute({ name, agent }), { kind: 'allow' })
    assert.deepEqual(await harness.preExecute({ name, agent }), {
      kind: 'deny',
      reason: `tool ${name} exceeded its per-step limit of 1`,
    })
  }
})
