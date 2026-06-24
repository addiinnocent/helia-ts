import { IPNS } from '@helia/ipns'
import { Keychain } from '@libp2p/keychain'
import { CID } from 'multiformats'
import { logger } from '@utils/logger.js'
import { getAllIpnsRecords } from './store.js'

let republishIntervalId: NodeJS.Timeout | null = null
let isRepublishing = false

/**
 * Parse a duration string (e.g. "87600h", "24h") into milliseconds.
 *
 * @param durationStr - The duration string
 * @returns milliseconds
 */
function parseLifetime(durationStr: string): number {
  const match = durationStr.match(/^(\d+)([hms])$/)
  if (!match) {
    // Default to 1 year if unparseable
    return 365 * 24 * 60 * 60 * 1000
  }
  const [, value, unit] = match
  const num = parseInt(value, 10)
  switch (unit) {
    case 'h':
      return num * 60 * 60 * 1000
    case 'm':
      return num * 60 * 1000
    case 's':
      return num * 1000
    default:
      return 365 * 24 * 60 * 60 * 1000
  }
}

/**
 * Republish all stored IPNS records to the DHT.
 *
 * @param ipns - The IPNS instance
 * @param keychain - The keychain to retrieve keys
 */
async function republishRecords(ipns: IPNS, keychain: Keychain): Promise<void> {
  if (isRepublishing) {
    logger.debug('IPNS republish already in progress, skipping')
    return
  }

  isRepublishing = true
  try {
    const records = await getAllIpnsRecords()
    if (records.length === 0) {
      logger.debug('No IPNS records to republish')
      return
    }

    logger.info('Republishing IPNS records', { count: records.length })

    for (const record of records) {
      try {
        const key = await keychain.findKey(record.keyName)
        if (!key) {
          logger.warn('IPNS key not found during republish', { keyName: record.keyName })
          continue
        }

        const lifetime = parseLifetime(record.lifetime)
        const cid = CID.parse(record.cid)
        await ipns.publish(key, cid, { lifetime })
        logger.debug('IPNS record republished', {
          keyName: record.keyName,
          ipnsName: record.ipnsName,
          cid: record.cid
        })
      } catch (error) {
        logger.error('Failed to republish IPNS record', {
          keyName: record.keyName,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    logger.info('IPNS republish pass completed', { count: records.length })
  } catch (error) {
    logger.error('IPNS republish pass failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    isRepublishing = false
  }
}

/**
 * Start the IPNS auto-republish loop.
 * Performs one immediate republish pass, then repeats on a fixed interval.
 *
 * @param ipns - The IPNS instance
 * @param keychain - The keychain to retrieve keys
 * @param initialOnly - If true, only run once on startup (for testing)
 */
export async function startRepublishLoop(
  ipns: IPNS,
  keychain: Keychain,
  initialOnly: boolean = false
): Promise<void> {
  // Run initial republish pass immediately
  await republishRecords(ipns, keychain)

  if (initialOnly) {
    logger.debug('IPNS republish in initial-only mode (no scheduled loop)')
    return
  }

  // Schedule periodic republish
  const intervalMs = parseInt(process.env.IPNS_REPUBLISH_INTERVAL_MS || '43200000', 10)
  republishIntervalId = setInterval(() => {
    republishRecords(ipns, keychain).catch(error => {
      logger.error('Unhandled error in republish loop', {
        error: error instanceof Error ? error.message : String(error)
      })
    })
  }, intervalMs)

  logger.info('IPNS republish loop started', { intervalMs })
}

/**
 * Stop the IPNS auto-republish loop.
 */
export function stopRepublishLoop(): void {
  if (republishIntervalId) {
    clearInterval(republishIntervalId)
    republishIntervalId = null
    logger.info('IPNS republish loop stopped')
  }
}
