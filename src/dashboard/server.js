import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isHeliaRunning, getHeliaPeerId, getPeerCount, getConnectedPeers, getMultiaddrs, getConnectionDetails } from '../storage/helia.js'
import { isS3ClientReady } from '../storage/s3-client.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const PORT = parseInt(process.env.DASHBOARD_PORT || '9999', 10)

export function startDashboardServer() {
  const server = createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Content-Type', 'application/json')

    // Handle metrics endpoint
    if (req.url === '/metrics' && req.method === 'GET') {
      try {
        const isRunning = isHeliaRunning()
        const s3Ready = isS3ClientReady()
        let peerId = null
        let multiaddrs = []
        let connections = []

        if (isRunning) {
          try {
            peerId = getHeliaPeerId()
            multiaddrs = getMultiaddrs()
            connections = getConnectionDetails()
          } catch (e) {
            // Helia may not be fully initialized
          }
        }

        const peerCount = isRunning ? getPeerCount() : 0
        // Connectivity health relative to the configured connection manager.
        // healthy: enough peers for reliable P2P retrieval; degraded: a few;
        // isolated: none (the "0 connected peers" symptom).
        const maxConnections = 50
        let health = 'isolated'
        if (peerCount >= 5) health = 'healthy'
        else if (peerCount > 0) health = 'degraded'

        // Count connection directions for at-a-glance visibility
        const inbound = connections.filter(c => c.direction === 'inbound').length
        const outbound = connections.filter(c => c.direction === 'outbound').length

        const metrics = {
          timestamp: new Date().toISOString(),
          helia: {
            running: isRunning,
            peerId: peerId,
            multiaddrs: multiaddrs,
            peerCount: peerCount,
            connectedPeers: isRunning ? getConnectedPeers() : [],
            connections: connections,
            health: isRunning ? health : 'stopped',
            maxConnections: maxConnections,
            inbound: inbound,
            outbound: outbound
          },
          api: {
            authenticationEnabled: !!process.env.HELIA_SECRET_KEY,
            port: parseInt(process.env.API_PORT || '8081', 10)
          },
          storage: {
            s3Ready: s3Ready,
            endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
            blockBucket: process.env.S3_BLOCK_BUCKET || 'ramunap',
            dataBucket: process.env.S3_DATA_BUCKET || 'ramunap'
          },
          environment: {
            nodeEnv: process.env.NODE_ENV || 'development',
            logLevel: process.env.LOG_LEVEL || 'info'
          }
        }

        res.writeHead(200)
        res.end(JSON.stringify(metrics, null, 2))
      } catch (error) {
        res.writeHead(500)
        res.end(JSON.stringify({ error: error.message }))
      }
    }
    // Serve dashboard HTML
    else if ((req.url === '/' || req.url === '/index.html') && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      import('node:fs/promises').then(fs => {
        fs.readFile(join(__dirname, 'index.html'), 'utf-8')
          .then(html => {
            res.writeHead(200)
            res.end(html)
          })
          .catch(error => {
            res.writeHead(500)
            res.end(`<h1>Error loading dashboard</h1><p>${error.message}</p>`)
          })
      }).catch(error => {
        res.writeHead(500)
        res.end(`<h1>Error</h1><p>${error.message}</p>`)
      })
    }
    // 404
    else {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  })

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Dashboard] Server listening on http://0.0.0.0:${PORT}`)
    console.log(`[Dashboard] View at http://localhost:${PORT}`)
  })

  return server
}

export function stopDashboardServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}
