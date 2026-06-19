import type { Helia } from 'helia'
import type { CID } from 'multiformats/cid'

/**
 * Announce a CID to the DHT so other peers can discover this node as a provider.
 * This is equivalent to the `ipfs routing provide` command.
 */
export async function provideCID(helia: Helia, cid: CID): Promise<void> {
  await helia.libp2p.contentRouting.provide(cid)
}
