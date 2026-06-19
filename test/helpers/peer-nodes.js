import { createHelia } from 'helia'
import { S3Blockstore } from 'blockstore-s3'
import { S3Datastore } from 'datastore-s3'
import { tcp } from '@libp2p/tcp'
import { getS3Client } from '../../src/storage/s3-client.js'

const blockBucket = process.env.S3_BLOCK_BUCKET || 'ramunap'
const dataBucket = process.env.S3_DATA_BUCKET || 'ramunap'

/**
 * Apply the same NoSuchKey -> NotFoundError wrapper the main node uses, so that
 * libp2p's keychain can bootstrap a fresh self-key from an empty S3 datastore.
 * (See src/storage/helia.ts — this is non-negotiable for S3Datastore.)
 */
function wrapDatastoreGet (datastore) {
  const originalGet = datastore.get.bind(datastore)
  datastore.get = async (key) => {
    try {
      return await originalGet(key)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('NoSuchKey') || msg.includes('NotFound')) {
        const err = new Error('Not found')
        err.code = 'ERR_NOT_FOUND'
        err.name = 'NotFoundError'
        throw err
      }
      throw error
    }
  }
}

/**
 * Create a lightweight, ISOLATED Helia node for connectivity scenario tests.
 *
 * Isolated = no bootstrap/mDNS discovery and no DHT, so the node only ever has
 * the peers we explicitly dial. That makes connected-peer counts deterministic
 * (the real singleton auto-connects to ~dozens of public bootstrap peers, which
 * is exactly why exact-count assertions cannot run against it).
 *
 * Uses the same S3 storage backing as production (no memory stores — project
 * rule), with a unique datastore path per node to avoid keychain collisions.
 * Muxer/encrypter are intentionally left to Helia's defaults (yamux + mplex,
 * noise + tls) — the same set the production fix relies on.
 */
export async function createIsolatedNode (label = 'node') {
  const s3 = getS3Client()

  const blockstore = new S3Blockstore(s3, blockBucket, { createIfMissing: true })
  await blockstore.open()

  const uniquePath = `.ipfs/test/${label}-${process.pid}-${Math.random().toString(36).slice(2)}`
  const datastore = new S3Datastore(s3, dataBucket, { path: uniquePath, createIfMissing: true })
  wrapDatastoreGet(datastore)

  const helia = await createHelia({
    blockstore,
    datastore,
    blockBrokers: [],
    libp2p: {
      transports: [tcp()],
      addresses: {
        listen: ['/ip4/127.0.0.1/tcp/0']
      },
      // No discovery, no DHT: the node stays isolated until we dial peers.
      peerDiscovery: [],
      connectionManager: {
        maxConnections: 100
      }
    }
  })

  return helia
}

/** Dial `targets` from `source` and wait until all connections are open. */
export async function connectNodes (source, targets) {
  for (const target of targets) {
    const addr = target.libp2p.getMultiaddrs()[0]
    await source.libp2p.dial(addr)
  }
}

/** Stop a batch of nodes, ignoring individual shutdown errors. */
export async function stopNodes (nodes) {
  await Promise.all(nodes.map(async (n) => {
    try {
      await n.stop()
    } catch {
      // best-effort cleanup
    }
  }))
}
