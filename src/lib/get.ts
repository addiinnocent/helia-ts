import type { Helia } from 'helia'
import { unixfs } from '@helia/unixfs'
import type { CID } from 'multiformats/cid'

/**
 * Retrieve bytes previously stored with @lib/add.js helpers.
 *
 * IMPORTANT: content added via `unixfs().addBytes()` / `addFile()` must be read
 * back via `unixfs().cat()`. A raw `helia.blockstore.get(cid)` returns the
 * encoded UnixFS/dag-pb block, not the original payload.
 */
export async function getBytes(helia: Helia, cid: CID): Promise<Uint8Array> {
  const fs = unixfs(helia)
  const chunks: Uint8Array[] = []

  for await (const chunk of fs.cat(cid)) {
    chunks.push(chunk)
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }

  return result
}

export async function getString(helia: Helia, cid: CID): Promise<string> {
  const bytes = await getBytes(helia, cid)
  return new TextDecoder().decode(bytes)
}

/**
 * Alias for getBytes — files added with addFile are read back the same way.
 */
export async function getFile(helia: Helia, cid: CID): Promise<Uint8Array> {
  return await getBytes(helia, cid)
}
