import 'dotenv/config'
import { createComponentLogger } from '@utils/logger.js'
import { getHeliaInstance, stopHeliaInstance } from '@storage/helia.js'
import { destroyS3Client } from '@storage/s3-client.js'
import { startDashboardServer, stopDashboardServer } from '@dashboard/server.js'
import { startApiServer, stopApiServer } from '@api/server.js'

const logger = createComponentLogger('helia')

let dashboardServer: any = null
let apiServer: any = null

async function start() {
  try {
    logger.info('Starting Helia node with S3/MinIO storage')

    const helia = await getHeliaInstance()

    const peerId = helia.libp2p.peerId.toString()
    logger.info('Helia node started successfully', { peerId })

    const addresses = helia.libp2p.getMultiaddrs()
    const addressStrings = addresses.map((addr: any) => addr.toString())
    logger.info('Node addresses:', {
      count: addressStrings.length,
      addresses: addressStrings
    })

    // Start dashboard on separate port
    dashboardServer = startDashboardServer()

    // Start API server on separate port
    apiServer = startApiServer()
  } catch (error) {
    logger.error({ err: error }, 'Failed to start Helia')
    process.exit(1)
  }
}

async function handleShutdown(signal: string) {
  logger.info('Received signal', { signal })
  try {
    if (dashboardServer) {
      await stopDashboardServer(dashboardServer)
    }
    if (apiServer) {
      await stopApiServer(apiServer)
    }
    await stopHeliaInstance()
    await destroyS3Client()
    logger.info('Shutdown complete')
    process.exit(0)
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown')
    process.exit(1)
  }
}

process.on('SIGINT', () => handleShutdown('SIGINT'))
process.on('SIGTERM', () => handleShutdown('SIGTERM'))

start()
