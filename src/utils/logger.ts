/**
 * Pino-based structured logging utility with pretty printing in development
 * Supports component-specific log levels and correlation IDs
 */

import pino, { type Logger } from 'pino'

// Custom logger interface with flexible method signatures
interface FlexibleLogger extends Logger {
  debug(obj: Record<string, any>, msg: string): void
  debug(msg: string, ...args: any[]): void
  info(obj: Record<string, any>, msg: string): void
  info(msg: string, ...args: any[]): void
  warn(obj: Record<string, any>, msg: string): void
  warn(msg: string, ...args: any[]): void
  error(obj: Record<string, any>, msg: string): void
  error(msg: string, ...args: any[]): void
}

// Determine if we're in development mode
const isDevelopment = process.env.NODE_ENV !== 'production'

// BigInt serializer for pino
const bigintSerializer = (value: unknown): unknown => {
  if (typeof value === 'bigint') {
    return value.toString() + 'n'
  }
  return value
}

// Component-specific log levels (can override global level)
type ComponentLogLevels = {
  [component: string]: pino.Level
}

// Parse component-specific log levels from environment
// Format: {"websocket": "debug", "upload": "info", "api": "warn"}
const parseComponentLevels = (): ComponentLogLevels => {
  try {
    const levelsStr = process.env.LOG_LEVELS
    if (levelsStr) {
      return JSON.parse(levelsStr) as ComponentLogLevels
    }
  } catch (err) {
    console.warn('Failed to parse LOG_LEVELS environment variable:', err)
  }
  return {}
}

const componentLevels = parseComponentLevels()

// Create pino logger with pretty printing in development
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',

  // Pretty print in development, JSON in production
  transport: isDevelopment ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'yyyy-mm-dd HH:MM:ss',
      ignore: 'pid,hostname',
      singleLine: false,
      hideObject: false,
    }
  } : undefined,

  // Serializers for special types
  serializers: {
    // Handle BigInt values in log data
    data: (data: unknown) => {
      if (typeof data === 'object' && data !== null) {
        return JSON.parse(JSON.stringify(data, (key, value) => bigintSerializer(value)))
      }
      return bigintSerializer(data)
    },
    // Standard error serializer
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },

  // Base configuration
  base: {
    env: process.env.NODE_ENV || 'development',
  },
}) as unknown as FlexibleLogger

// Re-export LogLevel enum for backward compatibility
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  TRACE = 'trace'
}

/**
 * Valid component names for structured logging
 */
export type LogComponent = 'helia' | 'storage' | 'api'

/**
 * Create a child logger for a specific component with optional correlation ID
 * Applies component-specific log level if configured
 */
export function createComponentLogger(
  component: LogComponent,
  correlationId?: string
): FlexibleLogger {
  const bindings: Record<string, string> = { component }
  if (correlationId) {
    bindings.correlationId = correlationId
  }

  const childLogger = logger.child(bindings)

  // Apply component-specific log level if configured
  if (componentLevels[component]) {
    childLogger.level = componentLevels[component]
  }

  return childLogger as unknown as FlexibleLogger
}

/**
 * Add correlation ID to an existing logger
 */
export function addCorrelationId(baseLogger: FlexibleLogger, correlationId: string): FlexibleLogger {
  return baseLogger.child({ correlationId }) as unknown as FlexibleLogger
}

/**
 * Dynamically update component log levels at runtime
 * Used by admin endpoints to change log verbosity without restart
 */
export function updateComponentLevel(component: LogComponent, level: pino.Level): void {
  componentLevels[component] = level
  logger.info({ component, level }, 'Updated component log level')
}
