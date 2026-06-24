import { Helia } from 'helia'
import { ipns as createIpns } from '@helia/ipns'
import type { IPNS, PublishOptions } from '@helia/ipns'
import type { Keychain } from '@libp2p/keychain'
import type { KeyType } from '@libp2p/interface'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { CID } from 'multiformats/cid'
import { base36 } from 'multiformats/bases/base36'
import { createComponentLogger } from '@utils/logger.js'

const logger = createComponentLogger('ipns')

let ipnsInstance: IPNS | null = null

/**
 * Initialise the IPNS instance.
 * Call this after Helia is ready.
 *
 * The instance is backed by Helia's (S3) datastore and starts its own
 * republisher automatically when Helia starts, so published records are
 * re-signed and re-announced without any manual loop.
 */
export async function initIPNS(helia: Helia): Promise<IPNS> {
  if (ipnsInstance) {
    return ipnsInstance
  }
  ipnsInstance = createIpns(helia)
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
 * Map a Kubo key-type string (case-insensitive) to a libp2p KeyType.
 */
function normaliseKeyType(type: string): KeyType {
  switch (type.toLowerCase()) {
    case 'ed25519':
      return 'Ed25519'
    case 'rsa':
      return 'RSA'
    case 'secp256k1':
      return 'secp256k1'
    case 'ecdsa':
      return 'ECDSA'
    default:
      throw new Error(`Unsupported key type: ${type}`)
  }
}

/**
 * Derive the IPNS name (base36 `k51...` libp2p-key CID) for a key already in
 * the keychain. This is the value Kubo returns as the key `Id`.
 */
async function ipnsNameForKey(keychain: Keychain, keyName: string): Promise<string> {
  const privateKey = await keychain.exportKey(keyName)
  return privateKey.publicKey.toCID().toString(base36)
}

/**
 * Generate a new key (Kubo `key/gen`).
 * Idempotent: if the key already exists, the existing key is returned.
 *
 * @param keychain - The keychain instance
 * @param keyName - The name for the new key
 * @param type - Key type: ed25519 (default), rsa, secp256k1, ecdsa
 * @param size - Key size in bits (RSA only)
 * @returns { Name, Id } where Id is the k51... IPNS name
 */
export async function keyGen(
  keychain: Keychain,
  keyName: string,
  type: string = 'ed25519',
  size?: number
): Promise<{ Name: string; Id: string }> {
  try {
    await keychain.findKeyByName(keyName)
    const id = await ipnsNameForKey(keychain, keyName)
    logger.debug('Key already exists', { keyName, ipnsName: id })
    return { Name: keyName, Id: id }
  } catch {
    // Key does not exist yet, fall through to creation
  }

  const keyType = normaliseKeyType(type)
  const privateKey = keyType === 'RSA'
    ? await generateKeyPair('RSA', size ?? 2048)
    : await generateKeyPair(keyType)
  await keychain.importKey(keyName, privateKey)
  const id = privateKey.publicKey.toCID().toString(base36)
  logger.info('Key generated', { keyName, type: keyType, ipnsName: id })
  return { Name: keyName, Id: id }
}

/**
 * List all keys in the keychain (Kubo `key/list`).
 *
 * @returns { Keys } array of { Name, Id }
 */
export async function keyList(keychain: Keychain): Promise<{ Keys: Array<{ Name: string; Id: string }> }> {
  const infos = await keychain.listKeys()
  const keys = await Promise.all(
    infos.map(async (info) => ({
      Name: info.name,
      Id: await ipnsNameForKey(keychain, info.name)
    }))
  )
  logger.debug('Keys listed', { count: keys.length })
  return { Keys: keys }
}

/**
 * Remove a key from the keychain (Kubo `key/rm`).
 *
 * @returns { Keys } the removed key as { Name, Id }
 */
export async function keyRemove(
  keychain: Keychain,
  keyName: string
): Promise<{ Keys: Array<{ Name: string; Id: string }> }> {
  // Resolve the IPNS name before removal, while the key still exists.
  const id = await ipnsNameForKey(keychain, keyName)
  await keychain.removeKey(keyName)
  logger.info('Key removed', { keyName, ipnsName: id })
  return { Keys: [{ Name: keyName, Id: id }] }
}

/**
 * Rename a key in the keychain (Kubo `key/rename`).
 *
 * @returns { Was, Now, Id, Overwrite }
 */
export async function keyRename(
  keychain: Keychain,
  oldName: string,
  newName: string
): Promise<{ Was: string; Now: string; Id: string; Overwrite: boolean }> {
  await keychain.renameKey(oldName, newName)
  const id = await ipnsNameForKey(keychain, newName)
  logger.info('Key renamed', { from: oldName, to: newName, ipnsName: id })
  return { Was: oldName, Now: newName, Id: id, Overwrite: false }
}

/**
 * Publish an IPNS record (Kubo `name/publish`).
 *
 * @param ipns - The IPNS instance
 * @param keyName - The key name to publish with (Kubo default: "self")
 * @param cid - The CID to publish
 * @param options - PublishOptions (lifetime, ttl, offline)
 * @returns { Name, Value } where Name is the k51... IPNS name
 */
export async function namePublish(
  ipns: IPNS,
  keyName: string,
  cid: CID,
  options: PublishOptions = {}
): Promise<{ Name: string; Value: string }> {
  const result = await ipns.publish(keyName, cid, options)
  const ipnsName = result.publicKey.toCID().toString(base36)
  logger.info('IPNS record published', { keyName, ipnsName, cid: cid.toString() })
  return { Name: ipnsName, Value: `/ipfs/${cid.toString()}` }
}

/**
 * Resolve an IPNS name (Kubo `name/resolve`).
 *
 * @param ipns - The IPNS instance
 * @param name - The IPNS name (k51... or /ipns/k51...)
 * @returns { Path } where Path is /ipfs/...
 */
export async function nameResolve(ipns: IPNS, name: string): Promise<{ Path: string }> {
  const clean = name.replace(/^\/ipns\//, '')
  const key = CID.parse(clean, base36) as Parameters<IPNS['resolve']>[0]
  const result = await ipns.resolve(key)
  const path = result.path
    ? `/ipfs/${result.cid.toString()}/${result.path}`
    : `/ipfs/${result.cid.toString()}`
  logger.debug('IPNS name resolved', { name: clean, path })
  return { Path: path }
}
