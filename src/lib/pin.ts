import type { Helia } from 'helia'
import type { CID } from 'multiformats/cid'

/**
 * Pin a CID so it survives garbage collection.
 *
 * CRITICAL: `helia.pins.add()` and `helia.pins.rm()` return AsyncGenerators —
 * they are LAZY. `await helia.pins.add(cid)` only awaits creation of the
 * generator and performs NO work, so the pin silently never happens (and
 * `isPinned`/`ls` keep returning false/empty). The generator MUST be drained.
 */
export async function pinCID(helia: Helia, cid: CID): Promise<void> {
  for await (const _ of helia.pins.add(cid)) {
    // draining the generator is what actually performs the pin
  }
}

export async function unpinCID(helia: Helia, cid: CID): Promise<void> {
  for await (const _ of helia.pins.rm(cid)) {
    // draining the generator is what actually performs the unpin
  }
}

export async function isPinned(helia: Helia, cid: CID): Promise<boolean> {
  return await helia.pins.isPinned(cid)
}

export async function listPins(helia: Helia): Promise<string[]> {
  const pins: string[] = []
  for await (const pin of helia.pins.ls()) {
    pins.push(pin.cid.toString())
  }
  return pins
}
