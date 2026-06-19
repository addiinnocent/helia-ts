import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { getPeerCount, getConnectedPeers, getConnectionDetails } from '../src/storage/helia.js'
import { createIsolatedNode, connectNodes, stopNodes } from './helpers/peer-nodes.js'

/**
 * Peer connectivity scenarios.
 *
 * These exercise the real reporting functions (getPeerCount / getConnectedPeers
 * / getConnectionDetails) against real libp2p connection state, using isolated
 * nodes so the connected-peer count is deterministic. The same functions, with
 * no argument, read the production singleton — here we pass an explicit instance.
 *
 * Requires MinIO/S3 reachable (same as the other integration tests).
 */
test('Peer Connectivity Scenarios', async (t) => {
  await t.test('LOW connectivity: a single connected peer is reported', async () => {
    const target = await createIsolatedNode('target-low')
    const peer = await createIsolatedNode('peer-low')

    try {
      // Baseline: isolated node has no peers.
      assert.strictEqual(getPeerCount(target), 0, 'starts isolated')

      await connectNodes(target, [peer])

      assert.strictEqual(getPeerCount(target), 1, 'reports exactly 1 connected peer')

      const peers = getConnectedPeers(target)
      assert.strictEqual(peers.length, 1, 'one peer id listed')
      assert.strictEqual(peers[0], peer.libp2p.peerId.toString(), 'correct peer id')

      const details = getConnectionDetails(target)
      assert.strictEqual(details.length, 1, 'one connection detail')
      assert.strictEqual(details[0].direction, 'outbound', 'dialled connection is outbound')
      assert.ok(details[0].remoteAddr.includes('/tcp/'), 'has a tcp remote address')
    } finally {
      await stopNodes([target, peer])
    }
  })

  await t.test('MANY connectivity: five connected peers are reported', async () => {
    const target = await createIsolatedNode('target-many')
    const peers = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createIsolatedNode(`peer-many-${i}`))
    )

    try {
      assert.strictEqual(getPeerCount(target), 0, 'starts isolated')

      await connectNodes(target, peers)

      assert.strictEqual(getPeerCount(target), 5, 'reports all 5 connected peers')

      const connectedIds = new Set(getConnectedPeers(target))
      for (const p of peers) {
        assert.ok(connectedIds.has(p.libp2p.peerId.toString()), 'each peer is connected')
      }

      const details = getConnectionDetails(target)
      assert.strictEqual(details.length, 5, 'five connection details')
      assert.ok(details.every(d => d.direction === 'outbound'), 'all dialled are outbound')
    } finally {
      await stopNodes([target, ...peers])
    }
  })

  await t.test('connection count drops after a peer disconnects', async () => {
    const target = await createIsolatedNode('target-drop')
    const peers = await Promise.all(
      Array.from({ length: 3 }, (_, i) => createIsolatedNode(`peer-drop-${i}`))
    )

    try {
      await connectNodes(target, peers)
      assert.strictEqual(getPeerCount(target), 3, 'three connected')

      // Disconnect one peer and confirm the reported count drops.
      await target.libp2p.hangUp(peers[0].libp2p.peerId)
      assert.strictEqual(getPeerCount(target), 2, 'count drops to 2 after hangUp')
    } finally {
      await stopNodes([target, ...peers])
    }
  })
})
