import type { Helia } from 'helia'
import type { CID } from 'multiformats/cid'
import type { PeerInfo } from '@libp2p/interface'

/**
 * Announce a CID to the DHT so other peers can discover this node as a provider.
 * This is equivalent to the `ipfs routing provide` command.
 */
export async function provideCID(helia: Helia, cid: CID): Promise<void> {
  await helia.libp2p.contentRouting.provide(cid)
}

/**
 * Find providers for a given CID on the DHT.
 * This is equivalent to the `ipfs routing findprovs` command.
 */
export async function findProviders(
  helia: Helia,
  cid: CID,
  options: { maxProviders?: number; timeout?: number } = {}
): Promise<PeerInfo[]> {
  const maxProviders = options.maxProviders ?? 20
  const timeout = options.timeout ?? 20000

  const providers: PeerInfo[] = []
  const startTime = Date.now()

  try {
    for await (const provider of helia.libp2p.contentRouting.findProviders(cid)) {
      if (providers.length >= maxProviders) {
        break
      }

      providers.push(provider)

      if (Date.now() - startTime > timeout) {
        break
      }
    }
  } catch (error) {
    // If no DHT is available or other routing error, still return what we found
    // Only re-throw if we got no providers and it's a critical error
    if (providers.length === 0) {
      throw error
    }
  }

  return providers
}
