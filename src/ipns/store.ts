import { LevelDatastore } from 'datastore-level'
import { Key } from 'interface-datastore'
import { logger } from '@utils/logger.js'
import path from 'path'
import os from 'os'

export interface IpnsRecord {
  keyName: string
  ipnsName: string
  cid: string
  publishedAt: number
  lifetime: string
}

let recordStore: LevelDatastore | null = null

/**
 * Initialise the IPNS record store backed by LevelDB.
 * This persists published IPNS records so they can be republished on restarts.
 *
 * @returns Promise<void>
 */
export async function initIpnsStore(): Promise<void> {
  const storePath = process.env.IPNS_STORE_PATH || path.join(os.homedir(), '.ipns-records')
  try {
    recordStore = new LevelDatastore(storePath, { createIfMissing: true })
    await recordStore.open()
    logger.info('IPNS record store initialised', { path: storePath })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error('Failed to initialise IPNS record store', { error: errorMsg })
    throw new Error(`IPNS store initialisation failed: ${errorMsg}`)
  }
}

/**
 * Save an IPNS record to persistent storage.
 *
 * @param record - The IPNS record to save
 */
export async function saveIpnsRecord(record: IpnsRecord): Promise<void> {
  if (!recordStore) {
    throw new Error('IPNS record store not initialised')
  }
  try {
    const key = new Key(`/ipns-records/${record.keyName}`)
    const value = JSON.stringify(record)
    await recordStore.put(key, new TextEncoder().encode(value))
    logger.debug('IPNS record saved', { keyName: record.keyName, ipnsName: record.ipnsName })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error('Failed to save IPNS record', { keyName: record.keyName, error: errorMsg })
    throw error
  }
}

/**
 * Retrieve all IPNS records from persistent storage.
 *
 * @returns Promise<IpnsRecord[]> - Array of stored IPNS records
 */
export async function getAllIpnsRecords(): Promise<IpnsRecord[]> {
  if (!recordStore) {
    throw new Error('IPNS record store not initialised')
  }
  try {
    const records: IpnsRecord[] = []
    const prefix = new Key('/ipns-records/')
    for await (const entry of recordStore.query({ prefix })) {
      try {
        const value = new TextDecoder().decode(entry.value)
        const record = JSON.parse(value) as IpnsRecord
        records.push(record)
      } catch (parseError) {
        logger.warn('Failed to parse IPNS record', {
          key: entry.key.toString(),
          error: parseError instanceof Error ? parseError.message : String(parseError)
        })
      }
    }
    return records
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error('Failed to retrieve IPNS records', { error: errorMsg })
    throw error
  }
}

/**
 * Retrieve a single IPNS record by key name.
 *
 * @param keyName - The key name to look up
 * @returns Promise<IpnsRecord | null> - The record or null if not found
 */
export async function getIpnsRecord(keyName: string): Promise<IpnsRecord | null> {
  if (!recordStore) {
    throw new Error('IPNS record store not initialised')
  }
  try {
    const key = new Key(`/ipns-records/${keyName}`)
    const value = await recordStore.get(key)
    const record = JSON.parse(new TextDecoder().decode(value)) as IpnsRecord
    return record
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    if (errorMsg.includes('Not found') || errorMsg.includes('NotFound')) {
      return null
    }
    logger.error('Failed to retrieve IPNS record', { keyName, error: errorMsg })
    throw error
  }
}

/**
 * Close the IPNS record store.
 */
export async function closeIpnsStore(): Promise<void> {
  if (!recordStore) {
    return
  }
  try {
    await recordStore.close()
    recordStore = null
    logger.debug('IPNS record store closed')
  } catch (error) {
    logger.warn('Error closing IPNS record store', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
