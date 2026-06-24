import { Helia } from 'helia'
import { IPNS } from '@helia/ipns'
import { Keychain } from '@libp2p/keychain'
import { CID } from 'multiformats'
import { base36 } from 'multiformats/bases/base36'
import {
  saveIpnsRecord as saveRecord,
  getIpnsRecord as getRecord,
  getAllIpnsRecords as getAllRecords,
  IpnsRecord
} from '@ipns/store.js'
import { createComponentLogger } from '@utils/logger.js'

const logger = createComponentLogger('ipns')

let ipnsInstance: IPNS | null = null

/**
 * Initialise the IPNS instance.
 * Call this after Helia is ready.
 */
export async function initIPNS(helia: Helia): Promise<IPNS> {
  if (ipnsInstance) {
    return ipnsInstance
  }
  ipnsInstance = await createIPNS(helia)
  logger.debug('IPNS instance initialised')
  return ipnsInstance
}

/**
 * Get the IPNS instance, throwing if not initialised.
 */
export function getIPNS(): IPNS {
  if (!ipnsInstance) {
    throw new Error('IPNS not initialised')
  }
  return ipnsInstance
}

/**
 * Parse a lifetime string (e.g. "87600h") into milliseconds.
 */
function parseLifetime(lifetimeStr: string): number {
  const match = lifetimeStr.match(/^(\d+)([hms])$/)
  if (!match) {
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
 * Convert a public key to a base36 libp2p-key CIDv1 string (k51...).
 */
function publicKeyToIPNSName(publicKeyBytes: Uint8Array): string {
  const cid = CID.createV1(0x72, { code: 0, digest: publicKeyBytes })
  return cid.toString(base36)
}

/**
 * Generate a new Ed25519 key.
 * Idempotent: if the key already exists, returns the existing key.
 *
 * @param keychain - The keychain instance
 * @param keyName - The name for the new key
 * @returns { Name, Id } where Id is the k51... IPNS name
 */
export async function keyGen(
  keychain: Keychain,
  keyName: string
): Promise<{ Name: string; Id: string }> {
  try {
    const existing = await keychain.findKey(keyName)
    if (existing) {
      const pubKeyBytes = existing.public.marshal()
      const ipnsName = publicKeyToIPNSName(pubKeyBytes)
      logger.debug('Key already exists', { keyName, ipnsName })
      return { Name: keyName, Id: ipnsName }
    }
  } catch (error) {
    // Key doesn't exist, proceed to creation
  }

  try {
    const key = await keychain.createKey(keyName, 'Ed25519')
    const pubKeyBytes = key.public.marshal()
    const ipnsName = publicKeyToIPNSName(pubKeyBytes)
    logger.info('Key generated', { keyName, ipnsName })
    return { Name: keyName, Id: ipnsName }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error('Failed to generate key', { keyName, error: errorMsg })
    throw error
  }
}

/**
 * Publish an IPNS record.
 *
 * @param ipns - The IPNS instance
 * @param keychain - The keychain instance
 * @param keyName - The key name to publish with
 * @param cid - The CID to publish
 * @param lifetime - The lifetime in milliseconds
 * @returns { Name, Value } where Name is the k51... IPNS name
 */
export async function namePublish(
  ipns: IPNS,
  keychain: Keychain,
  keyName: string,
  cid: CID,
  lifetime: number
): Promise<{ Name: string; Value: string }> {
  try {
    const key = await keychain.findKey(keyName)
    if (!key) {
      throw new Error(`Key not found: ${keyName}`)
    }

    const result = await ipns.publish(key, cid, { lifetime })
    const ipnsName = result.name.toString()

    const record: IpnsRecord = {
      keyName,
      ipnsName,
      cid: cid.toString(),
      publishedAt: Date.now(),
      lifetime: `${Math.floor(lifetime / 3600000)}h`
    }
    await saveRecord(record)

    logger.info('IPNS record published', { keyName, ipnsName, cid: cid.toString() })
    return { Name: ipnsName, Value: `/ipfs/${cid.toString()}` }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error('Failed to publish IPNS record', { keyName, error: errorMsg })
    throw error
  }
}

/**
 * Resolve an IPNS name.
 *
 * @param ipns - The IPNS instance
 * @param name - The IPNS name (k51... or /ipns/k51...)
 * @returns { Path } where Path is /ipfs/...
 */
export async function nameResolve(ipns: IPNS, name: string): Promise<{ Path: string }> {
  try {
    const namePath = name.startsWith('/ipns/') ? name : `/ipns/${name}`
    const result = await ipns.resolve(namePath)
    const path = result.toString()
    logger.debug('IPNS name resolved', { name: namePath, path })
    return { Path: path }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error('Failed to resolve IPNS name', { name, error: errorMsg })
    throw error
  }
}

/**
 * List all keys in the keychain.
 *
 * @param keychain - The keychain instance
 * @returns { Keys } array of { Name, Id }
 */
export async function keyList(keychain: Keychain): Promise<{ Keys: Array<{ Name: string; Id: string }> }> {
  try {
    const keys = await keychain.listKeys()
    const result = await Promise.all(
      keys.map(async (keyName: string) => {
        const key = await keychain.findKey(keyName)
        if (!key) return null
        const pubKeyBytes = key.public.marshal()
        const ipnsName = publicKeyToIPNSName(pubKeyBytes)
        return { Name: keyName, Id: ipnsName }
      })
    )
    const filtered = result.filter((k) => k !== null)
    logger.debug('Keys listed', { count: filtered.length })
    return { Keys: filtered }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error('Failed to list keys', { error: errorMsg })
    throw error
  }
}

// Re-export store functions for use in server.ts
export { saveIpnsRecord, getIpnsRecord, getAllIpnsRecords }
