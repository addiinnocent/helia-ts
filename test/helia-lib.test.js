import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { getHeliaInstance, stopHeliaInstance, isHeliaRunning } from '@storage/helia.js'
import { addString, addBytes } from '@lib/add.js'
import { getString, getBytes } from '@lib/get.js'
import { pinCID, unpinCID, isPinned, listPins } from '@lib/pin.js'

// Regression tests for the @lib/* helpers. These lock down two Helia v6 traps
// that fail SILENTLY (no exception, just wrong results), so a future
// "simplification" of the helpers fails loudly here instead of in production:
//   1. blockstore.put is put(cid, bytes) — add must go through unixfs/cat.
//   2. pins.add/rm are lazy AsyncGenerators that must be drained.
// See .md/HELIA_101.md "Helia v6 API Gotchas".
test('Helia @lib helpers', async (t) => {
  t.after(async () => {
    if (isHeliaRunning()) {
      await stopHeliaInstance()
    }
  })

  await t.test('addString/getString roundtrip', async () => {
    const helia = await getHeliaInstance()
    const text = 'Hello IPFS guardrails!'

    const cid = await addString(helia, text)
    assert.ok(cid, 'addString returns a CID')

    const out = await getString(helia, cid)
    assert.equal(out, text, 'getString returns the original text')
  })

  await t.test('addBytes/getBytes roundtrip', async () => {
    const helia = await getHeliaInstance()
    const bytes = new Uint8Array([0, 1, 2, 3, 255, 128])

    const cid = await addBytes(helia, bytes)
    const out = await getBytes(helia, cid)

    assert.deepEqual(out, bytes, 'getBytes returns the original bytes')
  })

  await t.test('pin lifecycle: pin -> isPinned -> list -> unpin', async () => {
    const helia = await getHeliaInstance()
    const cid = await addString(helia, `pin-test-${Date.now()}`)

    await pinCID(helia, cid)
    assert.equal(await isPinned(helia, cid), true, 'isPinned true after pinCID')

    const pins = await listPins(helia)
    assert.ok(
      pins.includes(cid.toString()),
      'listPins includes the pinned CID (as a string, not [object Object])'
    )

    await unpinCID(helia, cid)
    assert.equal(await isPinned(helia, cid), false, 'isPinned false after unpinCID')
  })
})
