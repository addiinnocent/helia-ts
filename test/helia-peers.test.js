import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { getHeliaInstance, stopHeliaInstance, isHeliaRunning, getPeerCount, getConnectedPeers, getMultiaddrs } from '../src/storage/helia.js'

test('Helia Peer Connectivity', async (t) => {
  t.afterEach(async () => {
    if (isHeliaRunning()) await stopHeliaInstance()
  })

  await t.test('getPeerCount returns 0 before init', () => {
    assert.strictEqual(getPeerCount(), 0)
  })

  await t.test('getConnectedPeers returns empty array before init', () => {
    assert.deepStrictEqual(getConnectedPeers(), [])
  })

  await t.test('getMultiaddrs returns empty array before init', () => {
    assert.deepStrictEqual(getMultiaddrs(), [])
  })

  await t.test('getMultiaddrs returns TCP addresses after init', async () => {
    await getHeliaInstance()
    const addrs = getMultiaddrs()
    assert.ok(Array.isArray(addrs), 'returns array')
    assert.ok(addrs.length > 0, 'has addresses after init')
    assert.ok(addrs.some(a => a.includes('tcp')), 'has TCP address')
  })

  await t.test('getPeerCount returns a non-negative number after init', async () => {
    await getHeliaInstance()
    const count = getPeerCount()
    assert.ok(typeof count === 'number', 'peer count is a number')
    assert.ok(count >= 0, 'peer count is non-negative')
  })

  await t.test('getConnectedPeers returns an array after init', async () => {
    await getHeliaInstance()
    const peers = getConnectedPeers()
    assert.ok(Array.isArray(peers), 'returns array')
    peers.forEach(p => {
      assert.ok(typeof p === 'string', 'peer entry is string')
      if (p !== '—') {
        assert.ok(p.startsWith('12D3Koo'), `peer ID has correct format: ${p}`)
      }
    })
  })

  await t.test('DHT service is available on libp2p', async () => {
    const helia = await getHeliaInstance()
    assert.ok(helia.libp2p.services.dht, 'dht service registered')
    const mode = await helia.libp2p.services.dht.getMode()
    assert.ok(mode === 'client' || mode === 'server', `dht mode is valid: ${mode}`)
  })

  await t.test('returns 0 peers after shutdown', async () => {
    await getHeliaInstance()
    await stopHeliaInstance()
    assert.strictEqual(getPeerCount(), 0)
    assert.deepStrictEqual(getConnectedPeers(), [])
  })
})
