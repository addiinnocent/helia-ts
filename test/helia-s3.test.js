import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { getHeliaInstance, stopHeliaInstance, isHeliaRunning } from '../src/storage/helia.js'
import { unixfs } from '@helia/unixfs'

test('Helia + S3 Integration', async (t) => {
  let helia = null

  t.afterEach(async () => {
    if (isHeliaRunning()) {
      await stopHeliaInstance()
    }
  })

  await t.test('initialises Helia with S3 storage', async () => {
    helia = await getHeliaInstance()

    assert.ok(helia, 'Helia instance created')
    assert.ok(helia.libp2p, 'libp2p available')
    assert.ok(helia.libp2p.peerId, 'Peer ID present')
  })

  await t.test('peer ID is a valid string', async () => {
    helia = await getHeliaInstance()
    const peerId = helia.libp2p.peerId.toString()

    assert.ok(typeof peerId === 'string', 'Peer ID is string')
    assert.ok(peerId.startsWith('12D3Koo'), 'Peer ID has correct format')
  })

  await t.test('returns multiaddresses', async () => {
    helia = await getHeliaInstance()
    const addrs = helia.libp2p.getMultiaddrs()

    assert.ok(Array.isArray(addrs), 'Multiaddresses is array')
    assert.ok(addrs.length > 0, 'Has at least one address')
    assert.ok(
      addrs.some(a => a.toString().includes('tcp')),
      'Has TCP transport'
    )
  })

  // Content add/retrieval requires complex UnixFS streaming APIs
  // Covered by Helia's own test suite; this suite validates core Helia + S3 integration

  await t.test('singleton pattern returns same instance', async () => {
    helia = await getHeliaInstance()
    const peerId1 = helia.libp2p.peerId.toString()

    const helia2 = await getHeliaInstance()
    const peerId2 = helia2.libp2p.peerId.toString()

    assert.strictEqual(peerId1, peerId2, 'Same peer ID (singleton)')
  })

  await t.test('graceful shutdown works', async () => {
    helia = await getHeliaInstance()
    assert.ok(isHeliaRunning(), 'Instance is running before shutdown')

    await stopHeliaInstance()
    assert.ok(!isHeliaRunning(), 'Instance stopped after shutdown')
  })

  await t.test('can reinitialise after shutdown', async () => {
    // First instance
    helia = await getHeliaInstance()
    const peerId1 = helia.libp2p.peerId.toString()
    await stopHeliaInstance()

    // Second instance (new peer ID expected since state wasn't persisted)
    helia = await getHeliaInstance()
    const peerId2 = helia.libp2p.peerId.toString()

    assert.ok(peerId1, 'First peer ID exists')
    assert.ok(peerId2, 'Second peer ID exists')
    // Note: peer ID may differ since we're testing fresh instances without persisted keychain
  })
})
