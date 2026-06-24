import { createHelia, Helia } from 'helia'
import { S3Blockstore } from 'blockstore-s3'
import { S3Datastore } from 'datastore-s3'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { tcp } from '@libp2p/tcp'
import { yamux } from '@chainsafe/libp2p-yamux'
import { mplex } from '@libp2p/mplex'
import { bootstrap } from '@libp2p/bootstrap'
import { kadDHT } from '@libp2p/kad-dht'
import { bitswap, trustlessGateway } from '@helia/block-brokers'
import { keychain } from '@libp2p/keychain'
import type { Keychain } from '@libp2p/keychain'
import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { logger } from '@utils/logger.js'
import { getS3Client } from '@storage/s3-client.js'

let heliaInstance: Helia | null = null
let datastore: any = null
let blockstore: any = null
let isInitialising = false

const endpoint = process.env.S3_ENDPOINT || 'http://localhost:9000'
const accessKeyId = process.env.S3_ACCESS_KEY_ID || 'minioadmin'
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || 'minioadmin'
const blockBucket = process.env.S3_BLOCK_BUCKET || 'ramunap'
const dataBucket = process.env.S3_DATA_BUCKET || 'ramunap'

/**
 * Get bootstrap node multiaddresses. Supports customisation via environment:
 *
 * BOOTSTRAP_NODES   - Comma-separated list of multiaddresses to use as bootstrap nodes
 * BOOTSTRAP_ENABLED - Set to 'false' to disable bootstrap entirely (DHT-only discovery)
 *
 * By default uses the public libp2p bootstrap nodes via dnsaddr.
 *
 * NOTE: If the node starts up isolated (0 peers) despite working DNS/network, the cause
 * is almost always a stale persisted peerstore, not bootstrap config — see
 * prunePeerstore() below and .md/BOOTSTRAP_TROUBLESHOOTING.md.
 */
function getBootstrapNodes(): string[] {
  // Check for completely disabled bootstrap
  if (process.env.BOOTSTRAP_ENABLED === 'false') {
    logger.info('Bootstrap discovery disabled via BOOTSTRAP_ENABLED=false')
    return []
  }

  // Check for custom bootstrap nodes via environment
  if (process.env.BOOTSTRAP_NODES) {
    const nodes = process.env.BOOTSTRAP_NODES.split(',').map(n => n.trim()).filter(n => n.length > 0)
    logger.info(`Using custom bootstrap nodes (${nodes.length} configured)`)
    return nodes
  }

  // Default: dnsaddr-based bootstrap (requires DNS resolution of bootstrap.libp2p.io)
  logger.debug('Using default libp2p bootstrap nodes (dnsaddr)')
  return [
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt'
  ]
}

/**
 * Prune the persisted libp2p peerstore from the S3 datastore on startup.
 *
 * WHY: libp2p persists *resolved* bootstrap addresses (e.g.
 * /dns/sv15.bootstrap.libp2p.io/tcp/4001) into the peerstore with a TTL. If the node is
 * offline long enough for those addresses to expire, the peer *record* persists but with
 * zero dialable addresses, and bootstrap does not re-add the original /dnsaddr/ to the
 * existing record. Every bootstrap dial then fails with `NoValidAddressesError` and the
 * node stays isolated (0 peers) forever — even though DNS and the network are fine.
 *
 * Clearing the `peers/` prefix on boot removes only the stale peer cache; libp2p rebuilds
 * it from bootstrap + DHT within seconds. Node identity (info/self, pkcs8/self) and pins
 * (pin/, pinned-block/) are NOT touched, so the peer ID and pinned content are preserved.
 *
 * Disable with PEERSTORE_PRUNE_ON_START=false (e.g. if you want a warm peer cache and
 * accept the small risk of an expired-address lockout after long downtime).
 */
async function prunePeerstore(): Promise<void> {
  if (process.env.PEERSTORE_PRUNE_ON_START === 'false') {
    logger.debug('Peerstore prune-on-start disabled via PEERSTORE_PRUNE_ON_START=false')
    return
  }

  const datastorePath = process.env.DATASTORE_PATH || '.ipfs/datastore'
  const prefix = `${datastorePath}/peers/`

  try {
    const s3 = getS3Client()
    let token: string | undefined
    let deleted = 0

    do {
      const out = await s3.send(new ListObjectsV2Command({
        Bucket: dataBucket,
        Prefix: prefix,
        ContinuationToken: token
      }))
      const objects = (out.Contents || []).map(o => ({ Key: o.Key as string }))
      if (objects.length > 0) {
        await s3.send(new DeleteObjectsCommand({
          Bucket: dataBucket,
          Delete: { Objects: objects, Quiet: true }
        }))
        deleted += objects.length
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined
    } while (token)

    if (deleted > 0) {
      logger.info(`Pruned ${deleted} persisted peerstore record(s) on startup`, { prefix })
    } else {
      logger.debug('No persisted peerstore records to prune', { prefix })
    }
  } catch (error) {
    // Non-fatal: a failed prune must not block node startup. Worst case the node may
    // start isolated, which the operator can resolve with `npm run clear-peerstore`.
    logger.warn('Peerstore prune-on-start failed (continuing startup)', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}


/**
 * Test S3 connectivity before mounting storage.
 * This validates that the S3 service is reachable and credentials are valid.
 * Does NOT require buckets to exist - they will be created automatically via createIfMissing.
 *
 * @throws Error if S3 connection fails
 */
async function testS3Connection(): Promise<void> {
  try {
    const s3 = getS3Client()
    logger.debug('Testing S3 connection...', { endpoint, blockBucket, dataBucket });

    // Test S3 connectivity by listing buckets (this verifies credentials work)
    try {
      await s3.listBuckets();
      logger.debug('S3 service accessible', { endpoint });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot reach S3 service or invalid credentials: ${errorMsg}`)
    }

    logger.debug('S3 connection test successful', {
      endpoint,
      note: 'Buckets will be created automatically if they do not exist'
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Provide helpful diagnostics based on error type
    if (errorMsg.includes('InvalidAccessKeyId') || errorMsg.includes('SignatureDoesNotMatch')) {
      throw new Error(`S3 authentication failed. Check S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY credentials.`);
    } else if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('ENOTFOUND')) {
      throw new Error(`Cannot reach S3 service. Verify S3_ENDPOINT is correct and S3 service is running.`);
    } else if (errorMsg.includes('timeout')) {
      throw new Error(`S3 connection timeout. The endpoint is not responding within the timeout window.`);
    } else {
      throw error;
    }
  }
}

export async function getHeliaInstance(): Promise<Helia> {
  // Return existing instance if already initialised
  if (heliaInstance) {
    return heliaInstance
  }

  // Wait if another initialisation is in progress
  if (isInitialising) {
    logger.debug('Helia initialisation already in progress, waiting...')
    while (isInitialising) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (heliaInstance) {
      return heliaInstance
    }
  }

  // Initialise new instance
  isInitialising = true

  try {
    // Get shared S3 client with connection pooling
    const s3 = getS3Client()

    // Test S3 connection before initializing stores
    await testS3Connection();

    let storageType = 'S3';

    // Initialize S3 blockstore using the same S3 client
    try {
      blockstore = new S3Blockstore(s3, blockBucket, { createIfMissing: true });
      await blockstore.open();

      logger.info('✓ S3 blockstore connected successfully', { endpoint, blockBucket })
    } catch (s3Error) {
      // NEVER use MemoryBlockstore (project rule)
      const errorMessage = s3Error instanceof Error ? s3Error.message : String(s3Error);
      logger.error({
        error: errorMessage,
        endpoint,
        blockBucket,
        accessKeyId: accessKeyId ? `${accessKeyId.slice(0, 4)}***` : 'not set',
        region: 'eu-central-1',
        details: s3Error instanceof Error ? s3Error.stack : undefined
      }, '✗ S3 blockstore connection FAILED - cannot continue without persistent storage');
      throw new Error(`S3 blockstore initialisation failed and fallback to MemoryBlockstore is forbidden. Error: ${errorMessage}`);
    }

    // Initialize S3Datastore for pin metadata using the same S3 client
    try {
      const datastorePath = process.env.DATASTORE_PATH || '.ipfs/datastore';
      const s3datastore = new S3Datastore(s3, dataBucket, { path: datastorePath, createIfMissing: true });

      // Wrap the get method to convert S3 NoSuchKey errors to NotFoundError
      // This is required because libp2p's keychain expects NotFoundError, not GetFailedError
      const originalGet = s3datastore.get.bind(s3datastore);
      s3datastore.get = async (key: any) => {
        try {
          return await originalGet(key)
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error)
          // S3 NoSuchKey errors - convert to NotFoundError that libp2p recognizes
          if (errorMsg.includes('NoSuchKey') || errorMsg.includes('NotFound')) {
            const err = new Error('Not found')
            ;(err as any).code = 'ERR_NOT_FOUND'
            ;(err as any).name = 'NotFoundError'
            throw err
          }
          throw error
        }
      };

      // Also wrap the query method to handle errors during pin listing operations
      // pins.ls() uses query/iteration methods which can throw S3 errors
      const originalQuery = s3datastore.query.bind(s3datastore);
      s3datastore.query = function(query: any) {
        const queryResult = originalQuery(query);

        // Wrap the async iterator to catch errors during iteration
        if (queryResult && typeof queryResult[Symbol.asyncIterator] === 'function') {
          const originalIterator = queryResult[Symbol.asyncIterator]();
          const wrappedIterator = {
            async next() {
              try {
                return await originalIterator.next();
              } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error)
                // If it's a NotFound/NoSuchKey error during listing, return done instead of throwing
                // This treats "path doesn't exist" as "no results" which is the expected behaviour
                if (errorMsg.includes('NoSuchKey') || errorMsg.includes('NotFound') || errorMsg.includes('Error: Not found')) {
                  return { done: true, value: undefined }
                }
                throw error
              }
            },
            [Symbol.asyncIterator]() {
              return this
            }
          };

          return {
            [Symbol.asyncIterator]() {
              return wrappedIterator
            }
          };
        }
        return queryResult;
      };

      datastore = s3datastore;
      logger.info('✓ S3Datastore initialized for pin metadata', { bucket: dataBucket, path: '.ipfs/datastore' })
    } catch (datastoreError) {
      const errorMessage = datastoreError instanceof Error ? datastoreError.message : String(datastoreError);
      logger.error({
        error: errorMessage,
        endpoint,
        dataBucket,
        accessKeyId: accessKeyId ? `${accessKeyId.slice(0, 4)}***` : 'not set',
        region: 'eu-central-1',
        details: datastoreError instanceof Error ? datastoreError.stack : undefined
      }, '✗ S3Datastore connection FAILED - cannot continue without persistent storage');
      throw new Error(`S3Datastore initialisation failed. Error: ${errorMessage}`);
    }

    // Prune any stale persisted peerstore BEFORE starting libp2p, so a node that was
    // offline long enough for its bootstrap addresses to expire does not boot isolated.
    // See prunePeerstore() for the full rationale.
    await prunePeerstore()

    // Create a minimal Helia node with blockstore, datastore, and block brokers
    // blockBrokers enables peer-to-peer block retrieval via bitswap and fallback to trustless gateways
    heliaInstance = await createHelia({
      blockstore,
      datastore,
      blockBrokers: [
        bitswap(),
        trustlessGateway()
      ],
      libp2p: {
        transports: [
          tcp({
            inboundSocketInactivityTimeout: 30000
          })
        ],
        addresses: {
          listen: ['/ip4/0.0.0.0/tcp/4001']
        },
        transportManager: {
          faultTolerance: 'NO_FATAL'
        },
        connectionManager: {
          maxConnections: 50
        },
        // NOTE: Helia merges this libp2p config over its defaults with a SHALLOW
        // spread, so each top-level key REPLACES Helia's default entirely. The
        // previous code set `streamMuxers: [mplex()]`, which wiped out Helia's
        // default yamux muxer and left the node mplex-only. Modern bootstrap and
        // public peers negotiate yamux (mplex is deprecated), so every connection
        // upgrade failed and the node reported 0 connected peers. yamux MUST come
        // first. Encryption (noise/tls) is intentionally left to Helia's defaults.
        streamMuxers: [yamux(), mplex()],
        peerDiscovery: [
          bootstrap({
            list: getBootstrapNodes()
          })
        ],
        services: {
          identify: identify(),
          ping: ping(),
          dht: kadDHT({ clientMode: false }),
          keychain: keychain()
        }
      }
    } as any)

    logger.info('Helia instance initialised successfully', {
      peerId: heliaInstance.libp2p.peerId.toString(),
      storageType,
      blockBucket,
      dataBucket
    })

    // Wire up libp2p connection lifecycle events (debug level only — avoids log spam).
    // Enable with LOG_LEVEL=debug to observe peer connect/disconnect for diagnostics.
    const libp2p = heliaInstance.libp2p as any
    libp2p.addEventListener('peer:discovery', (evt: any) => {
      const peerId = evt.detail?.id?.toString?.() ?? String(evt.detail?.id)
      logger.debug({ peerId }, 'Peer discovered')
    })
    libp2p.addEventListener('connection:open', (evt: any) => {
      const conn = evt.detail
      logger.debug({
        peerId: conn?.remotePeer?.toString?.(),
        remoteAddr: conn?.remoteAddr?.toString?.(),
        direction: conn?.direction,
        totalConnected: libp2p.getConnections().length
      }, 'Peer connected')
    })
    libp2p.addEventListener('connection:close', (evt: any) => {
      const conn = evt.detail
      logger.debug({
        peerId: conn?.remotePeer?.toString?.(),
        direction: conn?.direction,
        totalConnected: libp2p.getConnections().length
      }, 'Peer disconnected')
    })

    // Log current addresses being advertised by libp2p
    try {
      const currentAddresses = heliaInstance.libp2p.getMultiaddrs()
      const addressStrings = currentAddresses.map((addr: any) => addr.toString())
      logger.info('Current libp2p multiaddresses', {
        count: addressStrings.length,
        note: 'These are the addresses other peers will use to connect to this node'
      })
      // Log each address separately to ensure visibility
      addressStrings.forEach((addr: string, index: number) => {
        logger.info(`  Address ${index + 1}/${addressStrings.length}: ${addr}`)
      })
      if (addressStrings.length === 0) {
        logger.warn('No multiaddresses advertised! Other peers will not be able to connect.')
      }
    } catch (err) {
      logger.error('Error logging multiaddresses', {
        error: err instanceof Error ? err.message : String(err)
      })
    }

    return heliaInstance
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    const errorStack = error instanceof Error ? error.stack : ''
    logger.error({
      errorMessage: errorMsg,
      errorStack: errorStack,
      errorType: error?.constructor?.name,
      blockBucket,
      dataBucket
    }, `Failed to initialise Helia instance: ${errorMsg}`)
    throw new Error(`Failed to initialise Helia: ${errorMsg}`)
  } finally {
    isInitialising = false
  }
}

/**
 * Stop the Helia instance and clean up resources.
 * Call this during graceful shutdown.
 *
 * @returns Promise that resolves when Helia is stopped
 */
export async function stopHeliaInstance(): Promise<void> {
  if (!heliaInstance) {
    logger.debug('No Helia instance to stop')
    return
  }

  try {
    logger.info('Stopping Helia instance')

    // Stop Helia (this should close libp2p and related resources)
    await heliaInstance.stop()
    heliaInstance = null

    // Close blockstore
    if (blockstore) {
      try {
        if (typeof blockstore.close === 'function') {
          await blockstore.close()
        }
        blockstore = null
      } catch (error) {
        logger.warn('Error closing blockstore', { error })
      }
    }

    // Close datastore if needed
    if (datastore) {
      try {
        // S3Datastore doesn't require explicit close
        datastore = null
      } catch (error) {
        logger.warn('Error closing datastore', {
          error: error instanceof Error ? error.message : String(error)
        })
        datastore = null
      }
    }

    logger.info('Helia instance stopped successfully')
  } catch (error) {
    logger.error('Error stopping Helia instance', {
      error: error instanceof Error ? error.message : String(error)
    })
    // Don't re-throw - allow graceful shutdown even if there are errors
  }
}

/**
 * Check if a Helia instance is currently active.
 * Useful for health checks and testing.
 *
 * @returns boolean indicating if Helia is running
 */
export function isHeliaRunning(): boolean {
  return heliaInstance !== null
}

/**
 * Get the peer ID of the running Helia instance.
 * Throws if Helia is not initialised.
 *
 * @returns The peer ID as a string
 */
export function getHeliaPeerId(): string {
  if (!heliaInstance) {
    throw new Error('Helia instance not initialised')
  }
  return heliaInstance.libp2p.peerId.toString()
}

/**
 * Get the keychain instance for IPNS key operations.
 * Throws if Helia is not initialised.
 *
 * @returns The keychain instance
 */
export function getKeychain(): Keychain {
  if (!heliaInstance) {
    throw new Error('Helia not initialised')
  }
  const kc = heliaInstance.libp2p.services.keychain as Keychain
  if (!kc) {
    throw new Error('Keychain not initialised')
  }
  return kc
}

/**
 * Resolve the libp2p instance to query. Defaults to the running singleton, but
 * accepts an explicit libp2p (or Helia) instance so the same reporting logic can
 * be exercised against helper nodes in tests.
 */
function resolveLibp2p(instance?: any): any | null {
  if (instance) {
    return instance.libp2p ?? instance
  }
  return heliaInstance ? heliaInstance.libp2p : null
}

export function getPeerCount(instance?: any): number {
  const libp2p = resolveLibp2p(instance)
  if (!libp2p) return 0
  return libp2p.getPeers().length
}

export function getConnectedPeers(instance?: any): string[] {
  const libp2p = resolveLibp2p(instance)
  if (!libp2p) return []
  return libp2p.getPeers().map((p: any) => p.toString())
}

export function getMultiaddrs(instance?: any): string[] {
  const libp2p = resolveLibp2p(instance)
  if (!libp2p) return []
  return libp2p.getMultiaddrs().map((a: any) => a.toString())
}

export interface ConnectionDetail {
  peerId: string
  remoteAddr: string
  direction: string
  status: string
}

/**
 * Return one entry per open connection with peer id, remote address and
 * direction (inbound/outbound). Richer than getConnectedPeers() — used by the
 * dashboard to make connectivity visible at a glance.
 */
export function getConnectionDetails(instance?: any): ConnectionDetail[] {
  const libp2p = resolveLibp2p(instance)
  if (!libp2p) return []
  return libp2p.getConnections().map((conn: any) => ({
    peerId: conn.remotePeer?.toString?.() ?? 'unknown',
    remoteAddr: conn.remoteAddr?.toString?.() ?? 'unknown',
    direction: conn.direction ?? 'unknown',
    status: conn.status ?? 'unknown'
  }))
}

