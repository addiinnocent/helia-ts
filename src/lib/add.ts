import type { Helia } from 'helia'
import { unixfs } from '@helia/unixfs'
import type { CID } from 'multiformats/cid'

/**
 * Add raw bytes to IPFS and return the CID.
 *
 * IMPORTANT: Do NOT use `helia.blockstore.put(bytes)` for this. The Helia
 * blockstore signature is `put(cid, bytes)` — it expects a pre-computed CID as
 * the first argument. Passing raw bytes makes Helia treat them as a CID and
 * crashes with "Cannot read properties of undefined (reading 'code')".
 *
 * `unixfs().addBytes()` computes the CID and stores the block correctly, and
 * the result is retrievable with `unixfs().cat()` (see @lib/get.js).
 */
export async function addBytes(helia: Helia, bytes: Uint8Array): Promise<CID> {
  const fs = unixfs(helia)
  return await fs.addBytes(bytes)
}

export async function addString(helia: Helia, text: string): Promise<CID> {
  const encoder = new TextEncoder()
  return await addBytes(helia, encoder.encode(text))
}

/**
 * Add a file (with an optional filename preserved as UnixFS metadata).
 * Retrieve the contents with `unixfs().cat()` (see @lib/get.js).
 */
export async function addFile(helia: Helia, content: Uint8Array, path = 'file'): Promise<CID> {
  const fs = unixfs(helia)
  return await fs.addFile({ path, content })
}
