import { createServer } from 'node:http'
import { CID } from 'multiformats/cid'
import { multiaddr } from '@multiformats/multiaddr'
import { sha256 } from 'multiformats/hashes/sha2'
import * as raw from 'multiformats/codecs/raw'
import { getHeliaInstance, getHeliaPeerId, getMultiaddrs, getConnectionDetails, getKeychain } from '@storage/helia.js'
import { addString, addBytes, addFile } from '@lib/add.js'
import { getBytes } from '@lib/get.js'
import { pinCID, unpinCID, isPinned, listPins } from '@lib/pin.js'
import { provideCID, findProviders } from '@lib/routing.js'
import { createComponentLogger } from '@utils/logger.js'
import { keyGen, namePublish, nameResolve, keyList, getIPNS, initIPNS } from '@lib/ipns.js'

const logger = createComponentLogger('api')
const API_PORT = parseInt(process.env.API_PORT || '8081', 10)
const SECRET_KEY = process.env.HELIA_SECRET_KEY || ''


function readBody(req: any): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    req.on('data', (chunk: Buffer) => {
      chunks.push(new Uint8Array(chunk))
    })
    req.on('end', () => {
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const result = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.length
      }
      resolve(result)
    })
    req.on('error', reject)
  })
}

function parseMultipartForm(body: Uint8Array, contentType: string): Map<string, Uint8Array> {
  const boundary = contentType.split('boundary=')[1]?.split(';')[0]
  if (!boundary) {
    throw new Error('Invalid multipart/form-data: missing boundary')
  }

  const parts = new Map<string, Uint8Array>()
  const decoder = new TextDecoder()
  const bodyStr = decoder.decode(body)

  const sections = bodyStr.split(`--${boundary}`)
  for (const section of sections) {
    if (!section.includes('Content-Disposition') || section.trim() === '--') continue

    const [headers, ...contentParts] = section.split('\r\n\r\n')
    const content = contentParts.join('\r\n\r\n').replace(/\r\n--$/, '').trim()

    const nameMatch = headers.match(/name="([^"]+)"/)
    if (nameMatch) {
      const name = nameMatch[1]
      parts.set(name, new TextEncoder().encode(content))
    }
  }

  return parts
}

function getQueryParam(url: string, paramName: string): string | null {
  const parsed = new URL(url, 'http://localhost')
  return parsed.searchParams.get(paramName)
}

function checkAuthentication(req: any, res: any): boolean {
  if (!SECRET_KEY) {
    return true
  }

  const authHeader = req.headers['authorization'] || ''
  const [scheme, token] = authHeader.split(' ')

  if (scheme !== 'Bearer' || !token) {
    res.writeHead(401)
    res.end(JSON.stringify({ error: 'Missing or invalid Authorization header' }))
    return false
  }

  if (token !== SECRET_KEY) {
    res.writeHead(401)
    res.end(JSON.stringify({ error: 'Invalid API key' }))
    return false
  }

  return true
}

async function handleRequest(req: any, res: any): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Content-Type', 'application/json')

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  if (!checkAuthentication(req, res)) {
    return
  }

  try {
    const helia = await getHeliaInstance()
    const urlPath = req.url.split('?')[0]

    // POST /api/v0/add (multipart/form-data)
    if (req.method === 'POST' && urlPath === '/api/v0/add') {
      const contentType = req.headers['content-type'] || ''

      if (contentType.includes('application/json')) {
        // Handle JSON input with content field
        const body = await readBody(req)
        const decoder = new TextDecoder()
        const text = decoder.decode(body)
        let data: any
        try {
          data = JSON.parse(text)
        } catch {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Invalid JSON' }))
          return
        }

        if (typeof data.content !== 'string') {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Missing or invalid "content" field (string)' }))
          return
        }

        const cid = await addString(helia, data.content)
        res.writeHead(200)
        res.end(JSON.stringify({ Name: '', Hash: cid.toString(), Size: Buffer.byteLength(data.content) }))
      } else if (contentType.includes('multipart/form-data')) {
        // Handle multipart/form-data
        const body = await readBody(req)
        try {
          const parts = parseMultipartForm(body, contentType)

          if (parts.size === 0) {
            res.writeHead(400)
            res.end(JSON.stringify({ error: 'No file data in multipart form' }))
            return
          }

          // Get first part (could be named 'file', 'data', or any field)
          const fileData = Array.from(parts.values())[0]
          const cid = await addBytes(helia, fileData)

          res.writeHead(200)
          res.end(JSON.stringify({ Name: '', Hash: cid.toString(), Size: fileData.length }))
        } catch (error: any) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: error.message }))
        }
      } else {
        // Handle raw binary data
        const bytes = await readBody(req)
        const cid = await addBytes(helia, bytes)
        res.writeHead(200)
        res.end(JSON.stringify({ Name: '', Hash: cid.toString(), Size: bytes.length }))
      }
      return
    }

    // GET /api/v0/cat?arg=<cid>
    if (req.method === 'GET' && urlPath === '/api/v0/cat') {
      const cidStr = getQueryParam(req.url, 'arg')
      if (!cidStr) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Missing required arg parameter' }))
        return
      }

      let cid: CID
      try {
        cid = CID.parse(cidStr)
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Invalid CID' }))
        return
      }

      try {
        const bytes = await getBytes(helia, cid)
        res.setHeader('Content-Type', 'application/octet-stream')
        if (bytes instanceof Uint8Array) {
          res.writeHead(200)
          res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
        } else if (Buffer.isBuffer(bytes)) {
          res.writeHead(200)
          res.end(bytes)
        } else {
          res.writeHead(500)
          res.end(JSON.stringify({ error: `Invalid type: ${typeof bytes}` }))
        }
      } catch (error: any) {
        if (!res.headersSent) {
          if (error.message?.includes('not found') || error.message?.includes('does not exist')) {
            res.writeHead(404)
            res.end(JSON.stringify({ error: 'Content not found' }))
          } else {
            res.writeHead(500)
            res.end(JSON.stringify({ error: error.message || 'Internal server error' }))
          }
        }
      }
      return
    }

    // POST /api/v0/pin/add?arg=<cid>
    if (req.method === 'POST' && urlPath === '/api/v0/pin/add') {
      const cidStr = getQueryParam(req.url, 'arg')
      if (!cidStr) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Missing required arg parameter' }))
        return
      }

      let cid: CID
      try {
        cid = CID.parse(cidStr)
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Invalid CID' }))
        return
      }

      await pinCID(helia, cid)

      res.writeHead(200)
      res.end(JSON.stringify({ Pins: [cid.toString()] }))
      return
    }

    // POST /api/v0/pin/rm?arg=<cid>
    if (req.method === 'POST' && urlPath === '/api/v0/pin/rm') {
      const cidStr = getQueryParam(req.url, 'arg')
      if (!cidStr) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Missing required arg parameter' }))
        return
      }

      let cid: CID
      try {
        cid = CID.parse(cidStr)
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Invalid CID' }))
        return
      }

      try {
        await unpinCID(helia, cid)
      } catch (error: any) {
        if (error.message?.includes('not pinned')) {
          res.writeHead(404)
          res.end(JSON.stringify({ error: 'CID not pinned' }))
          return
        } else {
          throw error
        }
      }

      res.writeHead(200)
      res.end(JSON.stringify({ Pins: [cid.toString()] }))
      return
    }

    // GET /api/v0/pin/ls (optional ?arg=<cid> to filter)
    if (req.method === 'GET' && urlPath === '/api/v0/pin/ls') {
      const cidStr = getQueryParam(req.url, 'arg')

      if (cidStr) {
        // Check if specific CID is pinned
        let cid: CID
        try {
          cid = CID.parse(cidStr)
        } catch {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Invalid CID' }))
          return
        }

        const pinned = await isPinned(helia, cid)
        if (pinned) {
          res.writeHead(200)
          res.end(JSON.stringify({ Keys: { [cid.toString()]: { Type: 'recursive' } } }))
        } else {
          res.writeHead(404)
          res.end(JSON.stringify({ error: 'CID not pinned' }))
        }
      } else {
        // List all pins
        const pins = await listPins(helia)
        const keys: Record<string, any> = {}
        for (const pin of pins) {
          keys[pin] = { Type: 'recursive' }
        }
        res.writeHead(200)
        res.end(JSON.stringify({ Keys: keys }))
      }
      return
    }

    // POST /api/v0/routing/provide?arg=<cid>
    if (req.method === 'POST' && urlPath === '/api/v0/routing/provide') {
      const cidStr = getQueryParam(req.url, 'arg')
      if (!cidStr) {
        res.writeHead(400)
        res.end(JSON.stringify({ Message: 'Missing required arg parameter', Code: 1 }))
        return
      }

      let cid: CID
      try {
        cid = CID.parse(cidStr)
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ Message: 'Invalid CID', Code: 1 }))
        return
      }

      try {
        await provideCID(helia, cid)
        res.writeHead(200)
        res.end(JSON.stringify({ CID: cid.toString() }))
      } catch (error: any) {
        res.writeHead(500)
        res.end(JSON.stringify({ Message: error.message || 'Failed to provide CID', Code: 1 }))
      }
      return
    }

    // GET /api/v0/routing/findprovs?arg=<cid>&num-providers=<int>
    if (req.method === 'GET' && urlPath === '/api/v0/routing/findprovs') {
      const cidStr = getQueryParam(req.url, 'arg')
      if (!cidStr) {
        res.writeHead(400)
        res.end(JSON.stringify({ Message: 'Missing required arg parameter', Code: 1 }))
        return
      }

      let cid: CID
      try {
        cid = CID.parse(cidStr)
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ Message: 'Invalid CID', Code: 1 }))
        return
      }

      const numProvidersStr = getQueryParam(req.url, 'num-providers')
      let maxProviders = 20
      if (numProvidersStr) {
        const parsed = parseInt(numProvidersStr, 10)
        if (!isNaN(parsed) && parsed > 0) {
          maxProviders = parsed
        }
      }

      try {
        const providers = await findProviders(helia, cid, { maxProviders, timeout: 20000 })
        const responses = providers.map(provider => ({
          ID: provider.id.toString(),
          Addrs: provider.multiaddrs.map(ma => ma.toString())
        }))
        res.writeHead(200)
        res.end(JSON.stringify({ Responses: responses }))
      } catch (error: any) {
        res.writeHead(500)
        res.end(JSON.stringify({ Message: error.message || 'Failed to find providers', Code: 1 }))
      }
      return
    }

    // GET /api/v0/id
    if (req.method === 'GET' && urlPath === '/api/v0/id') {
      const peerId = getHeliaPeerId()
      const addresses = getMultiaddrs()
      res.writeHead(200)
      res.end(JSON.stringify({
        ID: peerId,
        Addresses: addresses,
        AgentVersion: 'helia/6.0.16',
        ProtocolVersion: 'ipfs/0.1.0'
      }))
      return
    }

    // GET /api/v0/version
    if (req.method === 'GET' && urlPath === '/api/v0/version') {
      res.writeHead(200)
      res.end(JSON.stringify({
        Version: '6.0.16',
        Commit: '',
        Repo: '13',
        System: `node/${process.version.slice(1)}`,
        Golang: ''
      }))
      return
    }

    // GET /api/v0/swarm/peers
    if (req.method === 'GET' && urlPath === '/api/v0/swarm/peers') {
      const connectionDetails = getConnectionDetails()
      const peers = connectionDetails.map(conn => ({
        Peer: conn.peerId,
        Addr: conn.remoteAddr,
        Direction: conn.direction === 'outbound' ? 0 : 1
      }))
      res.writeHead(200)
      res.end(JSON.stringify({ Peers: peers }))
      return
    }

    // GET /api/v0/swarm/addrs/local
    if (req.method === 'GET' && urlPath === '/api/v0/swarm/addrs/local') {
      const addresses = getMultiaddrs()
      res.writeHead(200)
      res.end(JSON.stringify({ Strings: addresses }))
      return
    }

    // POST /api/v0/swarm/connect?arg=<multiaddr>
    if (req.method === 'POST' && urlPath === '/api/v0/swarm/connect') {
      const addr = getQueryParam(req.url, 'arg')
      if (!addr) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Missing required arg parameter' }))
        return
      }

      try {
        const ma = multiaddr(addr)
        const maString = ma.toString()
        const peerId = maString.split('/p2p/')[1]?.split('/')[0] || ''
        await helia.libp2p.dial(ma)
        res.writeHead(200)
        res.end(JSON.stringify({ Strings: [`connect ${peerId} success`] }))
      } catch (error: any) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: error.message || 'Failed to connect' }))
      }
      return
    }

    // POST /api/v0/swarm/disconnect?arg=<multiaddr>
    if (req.method === 'POST' && urlPath === '/api/v0/swarm/disconnect') {
      const addr = getQueryParam(req.url, 'arg')
      if (!addr) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Missing required arg parameter' }))
        return
      }

      try {
        const ma = multiaddr(addr)
        const maString = ma.toString()
        const peerId = maString.split('/p2p/')[1]?.split('/')[0] || ''
        await helia.libp2p.hangUp(ma)
        res.writeHead(200)
        res.end(JSON.stringify({ Strings: [`disconnect ${peerId} success`] }))
      } catch (error: any) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: error.message || 'Failed to disconnect' }))
      }
      return
    }

    // GET /api/v0/block/get?arg=<cid>
    if (req.method === 'GET' && urlPath === '/api/v0/block/get') {
      const cidStr = getQueryParam(req.url, 'arg')
      if (!cidStr) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Missing required arg parameter' }))
        return
      }

      let cid: CID
      try {
        cid = CID.parse(cidStr)
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Invalid CID' }))
        return
      }

      try {
        const chunks: Uint8Array[] = []
        for await (const chunk of helia.blockstore.get(cid)) {
          chunks.push(chunk)
        }
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
        const bytes = new Uint8Array(totalLength)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.length
        }
        res.setHeader('Content-Type', 'application/octet-stream')
        res.writeHead(200)
        res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      } catch (error: any) {
        if (!res.headersSent) {
          if (error.message?.includes('not found') || error.message?.includes('does not exist')) {
            res.writeHead(404)
            res.end(JSON.stringify({ error: 'Block not found' }))
          } else {
            res.writeHead(500)
            res.end(JSON.stringify({ error: error.message || 'Internal server error' }))
          }
        }
      }
      return
    }

    // POST /api/v0/block/put
    if (req.method === 'POST' && urlPath === '/api/v0/block/put') {
      try {
        const bytes = await readBody(req)
        const hash = await sha256.digest(bytes)
        const cid = CID.create(1, raw.code, hash)
        await helia.blockstore.put(cid, bytes)
        res.writeHead(200)
        res.end(JSON.stringify({ Key: cid.toString(), Size: bytes.length }))
      } catch (error: any) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: error.message || 'Failed to store block' }))
      }
      return
    }

    // GET /api/v0/block/stat?arg=<cid>
    if (req.method === 'GET' && urlPath === '/api/v0/block/stat') {
      const cidStr = getQueryParam(req.url, 'arg')
      if (!cidStr) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Missing required arg parameter' }))
        return
      }

      let cid: CID
      try {
        cid = CID.parse(cidStr)
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Invalid CID' }))
        return
      }

      try {
        let totalSize = 0
        for await (const chunk of helia.blockstore.get(cid)) {
          totalSize += chunk.length
        }
        res.writeHead(200)
        res.end(JSON.stringify({ Key: cid.toString(), Size: totalSize }))
      } catch (error: any) {
        if (!res.headersSent) {
          if (error.message?.includes('not found') || error.message?.includes('does not exist')) {
            res.writeHead(404)
            res.end(JSON.stringify({ error: 'Block not found' }))
          } else {
            res.writeHead(500)
            res.end(JSON.stringify({ error: error.message || 'Internal server error' }))
          }
        }
      }
      return
    }

    // GET /api/v0/stats/bw
    if (req.method === 'GET' && urlPath === '/api/v0/stats/bw') {
      res.writeHead(200)
      res.end(JSON.stringify({
        TotalIn: 0,
        TotalOut: 0,
        RateIn: 0,
        RateOut: 0
      }))
      return
    }

    // POST /api/v0/key/gen?arg=<keyName>&type=ed25519
    if (req.method === 'POST' && urlPath === '/api/v0/key/gen') {
      const keyName = getQueryParam(req.url, 'arg')
      const keyType = getQueryParam(req.url, 'type')

      if (!keyName) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Missing required arg parameter' }))
        return
      }

      if (!keyType || keyType !== 'ed25519') {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Only type=ed25519 is supported' }))
        return
      }

      try {
        const keychain = getKeychain()
        const result = await keyGen(keychain, keyName)
        res.writeHead(200)
        res.end(JSON.stringify(result))
      } catch (error: any) {
        logger.error('key/gen failed', { error: error.message })
        res.writeHead(500)
        res.end(JSON.stringify({ error: error.message || 'Failed to generate key' }))
      }
      return
    }

    // POST /api/v0/name/publish?arg=/ipfs/<cid>&key=<keyName>&lifetime=87600h&resolve=false
    if (req.method === 'POST' && urlPath === '/api/v0/name/publish') {
      const cidStr = getQueryParam(req.url, 'arg')
      const keyName = getQueryParam(req.url, 'key')
      const lifetimeStr = getQueryParam(req.url, 'lifetime') || '87600h'

      if (!cidStr || !cidStr.startsWith('/ipfs/')) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Missing or invalid arg parameter (must be /ipfs/<cid>)' }))
        return
      }

      if (!keyName) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Missing required key parameter' }))
        return
      }

      try {
        const cid = CID.parse(cidStr.substring(6))
        const lifetime = ((): number => {
          const match = lifetimeStr.match(/^(\d+)([hms])$/)
          if (!match) return 365 * 24 * 60 * 60 * 1000
          const [, value, unit] = match
          const num = parseInt(value, 10)
          switch (unit) {
            case 'h': return num * 60 * 60 * 1000
            case 'm': return num * 60 * 1000
            case 's': return num * 1000
            default: return 365 * 24 * 60 * 60 * 1000
          }
        })()

        const ipns = getIPNS()
        const keychain = getKeychain()
        const result = await namePublish(ipns, keychain, keyName, cid, lifetime)
        res.writeHead(200)
        res.end(JSON.stringify(result))
      } catch (error: any) {
        if (error.message?.includes('not found') || error.message?.includes('Key not found')) {
          res.writeHead(404)
          res.end(JSON.stringify({ error: 'Key not found' }))
        } else {
          logger.error('name/publish failed', { error: error.message })
          res.writeHead(400)
          res.end(JSON.stringify({ error: error.message || 'Failed to publish IPNS record' }))
        }
      }
      return
    }

    // GET /api/v0/name/resolve?arg=<ipnsName>
    if (req.method === 'GET' && urlPath === '/api/v0/name/resolve') {
      const name = getQueryParam(req.url, 'arg')
      if (!name) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Missing required arg parameter' }))
        return
      }

      try {
        const ipns = getIPNS()
        const result = await nameResolve(ipns, name)
        res.writeHead(200)
        res.end(JSON.stringify(result))
      } catch (error: any) {
        logger.error('name/resolve failed', { error: error.message })
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'IPNS name not found or could not be resolved' }))
      }
      return
    }

    // GET /api/v0/key/list
    if (req.method === 'GET' && urlPath === '/api/v0/key/list') {
      try {
        const keychain = getKeychain()
        const result = await keyList(keychain)
        res.writeHead(200)
        res.end(JSON.stringify(result))
      } catch (error: any) {
        logger.error('key/list failed', { error: error.message })
        res.writeHead(500)
        res.end(JSON.stringify({ error: error.message || 'Failed to list keys' }))
      }
      return
    }

    // 404
    res.writeHead(404)
    res.end(JSON.stringify({ error: 'Not found' }))
  } catch (error: any) {
    logger.error({ err: error }, 'API error')
    res.writeHead(500)
    res.end(JSON.stringify({ error: error.message || 'Internal server error' }))
  }
}

export function startApiServer() {
  const server = createServer(handleRequest)

  server.listen(API_PORT, '0.0.0.0', () => {
    console.log(`[API] Server listening on http://0.0.0.0:${API_PORT}`)
    console.log(`[API] Base URL: http://localhost:${API_PORT}/api/v0`)
    if (SECRET_KEY) {
      console.log(`[API] Authentication: Enabled (Bearer token required)`)
    } else {
      console.log(`[API] Authentication: Disabled`)
    }
    console.log(`[API] Examples:`)
    console.log(`  GET /api/v0/id - Node identity`)
    console.log(`  GET /api/v0/version - Version info`)
    console.log(`  GET /api/v0/swarm/peers - Connected peers`)
    console.log(`  GET /api/v0/swarm/addrs/local - Local multiaddresses`)
    console.log(`  POST /api/v0/swarm/connect?arg=<multiaddr> - Connect to peer`)
    console.log(`  POST /api/v0/swarm/disconnect?arg=<multiaddr> - Disconnect from peer`)
    console.log(`  POST /api/v0/add - Add content (multipart/form-data or raw binary)`)
    console.log(`  GET /api/v0/cat?arg=<cid> - Retrieve content by CID`)
    console.log(`  GET /api/v0/block/get?arg=<cid> - Get raw block`)
    console.log(`  POST /api/v0/block/put - Store raw block`)
    console.log(`  GET /api/v0/block/stat?arg=<cid> - Block metadata`)
    console.log(`  POST /api/v0/pin/add?arg=<cid> - Pin a CID`)
    console.log(`  POST /api/v0/pin/rm?arg=<cid> - Unpin a CID`)
    console.log(`  GET /api/v0/pin/ls - List all pinned CIDs`)
    console.log(`  POST /api/v0/routing/provide?arg=<cid> - Announce CID to DHT`)
    console.log(`  GET /api/v0/routing/findprovs?arg=<cid>&num-providers=<int> - Find providers for CID`)
    console.log(`  GET /api/v0/stats/bw - Bandwidth stats`)
  })

  return server
}

export function stopApiServer(server: any): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err: any) => {
      if (err) reject(err)
      else resolve()
    })
  })
}
