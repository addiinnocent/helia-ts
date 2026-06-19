/**
 * Centralized S3 Client Configuration
 *
 * Manages a single shared S3 client instance with proper connection pooling
 * and AWS SDK configuration to prevent socket exhaustion.
 *
 * Key improvements:
 * - Connection pooling with configurable socket limits
 * - Request queue to control concurrency
 * - Exponential backoff with jitter
 * - Single client instance for all operations
 */

import { S3 } from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import http from 'node:http'
import https from 'node:https'
import { logger } from '@utils/logger.js'

let s3Instance: S3 | null = null

const endpoint = process.env.S3_ENDPOINT || 'http://localhost:9000'
const accessKeyId = process.env.S3_ACCESS_KEY_ID || 'minioadmin'
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || 'minioadmin'

/**
 * Socket pooling configuration.
 * Prevents socket exhaustion by limiting concurrent connections per host.
 */
const SOCKET_CONFIG = {
  // Maximum number of sockets per host (increased from 64 to handle concurrent DHT promotions + S3 operations)
  maxSockets: 512,
  // Maximum number of keep-alive sockets
  maxFreeSockets: 64,
  // How long to keep sockets alive (ms)
  socketTimeout: 30000,
  // Enable keep-alive for connection reuse
  keepAlive: true,
  // Initial delay before keep-alive probes (ms)
  keepAliveInitialDelay: 1000
}

/**
 * Create HTTP/HTTPS agents with proper socket pooling.
 * These are passed to the SDK requestHandler to control connection reuse.
 */
function createHttpAgents() {
  const httpAgent = new http.Agent({
    maxSockets: SOCKET_CONFIG.maxSockets,
    maxFreeSockets: SOCKET_CONFIG.maxFreeSockets,
    timeout: SOCKET_CONFIG.socketTimeout,
    keepAlive: SOCKET_CONFIG.keepAlive,
    keepAliveInitialDelay: SOCKET_CONFIG.keepAliveInitialDelay
  })

  const httpsAgent = new https.Agent({
    maxSockets: SOCKET_CONFIG.maxSockets,
    maxFreeSockets: SOCKET_CONFIG.maxFreeSockets,
    timeout: SOCKET_CONFIG.socketTimeout,
    keepAlive: SOCKET_CONFIG.keepAlive,
    keepAliveInitialDelay: SOCKET_CONFIG.keepAliveInitialDelay
  })

  return { httpAgent, httpsAgent }
}

/**
 * Get or create the shared S3 client instance.
 * Ensures only one S3 client is used throughout the application.
 */
export function getS3Client(): S3 {
  if (s3Instance) {
    return s3Instance
  }

  const { httpAgent, httpsAgent } = createHttpAgents()

  // Create request handler with socket pooling configuration
  const requestHandler = new NodeHttpHandler({
    httpAgent,
    httpsAgent,
    requestTimeout: 30000,
    // Emit warning when socket queue gets too deep
    socketAcquisitionWarningTimeout: 5000
  })

  s3Instance = new S3({
    endpoint: endpoint,
    region: 'eu-central-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: accessKeyId,
      secretAccessKey: secretAccessKey
    },
    // Use custom request handler with socket pooling
    requestHandler: requestHandler,
    // Reduce retry attempts to prevent socket exhaustion
    maxAttempts: 2,
    retryMode: 'adaptive'
  })

  logger.debug('S3 client created with connection pooling', {
    endpoint,
    maxSockets: SOCKET_CONFIG.maxSockets,
    maxFreeSockets: SOCKET_CONFIG.maxFreeSockets,
    keepAlive: SOCKET_CONFIG.keepAlive
  })

  return s3Instance
}

/**
 * Destroy the S3 client and release all resources.
 * Call during graceful shutdown.
 */
export async function destroyS3Client(): Promise<void> {
  if (!s3Instance) {
    return
  }

  try {
    await s3Instance.destroy()
    s3Instance = null
    logger.debug('S3 client destroyed successfully')
  } catch (error) {
    logger.warn('Error destroying S3 client', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * Check if S3 client is initialised.
 */
export function isS3ClientReady(): boolean {
  return s3Instance !== null
}
