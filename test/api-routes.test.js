import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { getHeliaInstance, stopHeliaInstance, isHeliaRunning } from '../src/storage/helia.js'
import { startApiServer, stopApiServer } from '../src/api/server.js'

const API_PORT = parseInt(process.env.API_PORT || '8081', 10)
const API_BASE = `http://localhost:${API_PORT}`

test('API Routes: POST /api/v0/routing/provide', async (t) => {
  let helia = null
  let server = null

  t.before(async () => {
    helia = await getHeliaInstance()
    server = startApiServer()
    await new Promise(resolve => setTimeout(resolve, 100))
  })

  t.after(async () => {
    if (server) {
      try {
        await stopApiServer(server)
      } catch (err) {
        // Ignore errors
      }
    }
    if (isHeliaRunning()) {
      try {
        await stopHeliaInstance()
      } catch (err) {
        // Ignore errors
      }
    }
  })

  await t.test('returns 200 on successful provide', async () => {
    const testCid = 'QmdfTbBqBx61zamDzE42SQSvxQ9oGHbSNxaUpkaCHDeP45'

    const response = await fetch(`${API_BASE}/api/v0/routing/provide?arg=${testCid}`, {
      method: 'POST'
    })

    assert.strictEqual(response.status, 200, 'Expected 200 status')

    const data = await response.json()
    assert.ok(data.CID, 'Expected CID in response')
    assert.strictEqual(data.CID, testCid, 'CID in response should match provided CID')
  })

  await t.test('returns 400 when arg parameter is missing', async () => {
    const response = await fetch(`${API_BASE}/api/v0/routing/provide`, {
      method: 'POST'
    })

    assert.strictEqual(response.status, 400, 'Expected 400 status for missing arg')

    const data = await response.json()
    assert.ok(data.Message, 'Expected error message')
    assert.strictEqual(data.Code, 1, 'Expected error code 1')
  })

  await t.test('returns 400 when arg is invalid CID', async () => {
    const invalidCid = 'not-a-valid-cid'

    const response = await fetch(`${API_BASE}/api/v0/routing/provide?arg=${invalidCid}`, {
      method: 'POST'
    })

    assert.strictEqual(response.status, 400, 'Expected 400 status for invalid CID')

    const data = await response.json()
    assert.ok(data.Message, 'Expected error message')
    assert.strictEqual(data.Code, 1, 'Expected error code 1')
  })

  await t.test('returns 500 when contentRouting.provide fails', async () => {
    const originalProvide = helia.libp2p.contentRouting.provide
    helia.libp2p.contentRouting.provide = async () => {
      throw new Error('DHT error: unable to provide')
    }

    const testCid = 'QmdfTbBqBx61zamDzE42SQSvxQ9oGHbSNxaUpkaCHDeP45'

    const response = await fetch(`${API_BASE}/api/v0/routing/provide?arg=${testCid}`, {
      method: 'POST'
    })

    helia.libp2p.contentRouting.provide = originalProvide

    assert.strictEqual(response.status, 500, 'Expected 500 status on routing error')

    const data = await response.json()
    assert.ok(data.Message, 'Expected error message')
    assert.strictEqual(data.Code, 1, 'Expected error code 1')
  })

  await t.test('works with URL-encoded CIDv1', async () => {
    const testCidV1 = 'bafy2bzacedl4vjwwy4rvj5knfqsmkkeyswbv3sn4pjnxkh5cwvqpygvw3efyc'

    const response = await fetch(`${API_BASE}/api/v0/routing/provide?arg=${encodeURIComponent(testCidV1)}`, {
      method: 'POST'
    })

    assert.strictEqual(response.status, 200, 'Expected 200 status for CIDv1')

    const data = await response.json()
    assert.ok(data.CID, 'Expected CID in response')
  })
})
