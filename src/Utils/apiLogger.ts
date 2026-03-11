import pino from 'pino';
import { createWriteStream } from 'fs';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

// Ensure logs directory exists
const logsDir = join(process.cwd(), 'logs');
if (!existsSync(logsDir)) {
  mkdirSync(logsDir, { recursive: true });
}

// Create log streams
const logFile = join(logsDir, 'app.log');
const errorFile = join(logsDir, 'error.log');

const streams = [
  // Console output for development
  {
    level: process.env.LOG_LEVEL || 'info',
    stream: process.stdout
  },
  // File output for all logs
  {
    level: 'info',
    stream: createWriteStream(logFile, { flags: 'a' })
  },
  // Separate file for errors
  {
    level: 'error',
    stream: createWriteStream(errorFile, { flags: 'a' })
  }
];

// Create logger with multiple streams
export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => {
        return { level: label };
      }
    },
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        headers: {
          'user-agent': req.headers['user-agent'],
          'content-type': req.headers['content-type'],
          'x-forwarded-for': req.headers['x-forwarded-for']
        },
        remoteAddress: req.remoteAddress,
        remotePort: req.remotePort
      }),
      res: (res) => ({
        statusCode: res.statusCode,
        headers: {
          'content-type': res.getHeader('content-type'),
          'content-length': res.getHeader('content-length')
        }
      }),
      err: pino.stdSerializers.err
    }
  },
  pino.multistream(streams)
);

// Create child loggers for different components
export const createLogger = (component: string) => {
  return logger.child({ component });
};

// Specific loggers for different parts of the application
export const apiLogger = createLogger('api');

// Raw whatsapp logger - will be wrapped with filter below
const rawWhatsappLogger = createLogger('whatsapp');

export const dbLogger = createLogger('database');
export const webhookLogger = createLogger('webhook');

// Helper function to log API requests
export const logApiRequest = (req: any, res: any, duration: number) => {
  apiLogger.info({
    req,
    res,
    duration,
    userId: req.user?.id,
    sessionId: req.sessionId
  }, 'API Request');
};

// Helper function to log WhatsApp events
export const logWhatsAppEvent = (sessionId: string, event: string, data?: any) => {
  whatsappLogger.info({
    sessionId,
    event,
    data
  }, 'WhatsApp Event');
};

// Helper function to log errors with context
export const logError = (error: Error, context?: any) => {
  logger.error({
    err: error,
    context
  }, 'Application Error');
};

// Helper function to log webhook deliveries
export const logWebhookDelivery = (webhookId: string, url: string, event: string, status: string, response?: any) => {
  webhookLogger.info({
    webhookId,
    url,
    event,
    status,
    response
  }, 'Webhook Delivery');
};

// Suppressed errors list
const SUPPRESSED_ERRORS = [
  'Invalid PreKey ID',
  'No session record',
  'No SenderKeyRecord found',
  'No matching sessions',
  'No session found'
];

const shouldSuppress = (error: any): boolean => {
  if (!error) return false;
  const errorMsg = error?.message || error?.toString?.() || '';
  return SUPPRESSED_ERRORS.some(msg => errorMsg.includes(msg));
};

/**
 * Create a filtered WhatsApp logger that suppresses known decryption errors
 * These errors are already handled gracefully in our code, so we don't need
 * to log them to error.log and clutter the logs
 */
class FilteredLogger {
  baseLogger: any;

  constructor(baseLogger: any) {
    this.baseLogger = baseLogger;
  }

  get level(): string {
    return this.baseLogger.level;
  }

  child(obj: Record<string, unknown>): any {
    const childLogger = this.baseLogger.child(obj);
    return new FilteredLogger(childLogger);
  }

  trace(...args: any[]): void {
    this.baseLogger.trace(...args);
  }

  debug(...args: any[]): void {
    this.baseLogger.debug(...args);
  }

  info(...args: any[]): void {
    this.baseLogger.info(...args);
  }

  warn(...args: any[]): void {
    this.baseLogger.warn(...args);
  }

  error(...args: any[]): void {
    // Suppress known decryption errors that we handle gracefully
    // args[0] is typically the object or message
    if (shouldSuppress(args[0])) {
      return;
    }
    this.baseLogger.error(...args);
  }
}

// Create the filtered WhatsApp logger
export const whatsappLogger = new FilteredLogger(rawWhatsappLogger);

export const createFilteredWhatsAppLogger = (): any => {
  return whatsappLogger;
};

export default logger;
