import { PrismaClient } from '@prisma/client';
import { logger } from '../Utils/apiLogger';
import { BaileysMessageContent } from '../Types/api';

export class DatabaseService {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient({
      log: [
        {
          emit: 'event',
          level: 'query',
        },
        {
          emit: 'event',
          level: 'error',
        },
        {
          emit: 'event',
          level: 'info',
        },
        {
          emit: 'event',
          level: 'warn',
        },
      ],
    });

    // Log database queries in development
    if (process.env.NODE_ENV === 'development') {
      (this.prisma as any).$on('query', (e) => {
        logger.debug({
          query: e.query,
          params: e.params,
          duration: e.duration
        }, 'Database Query');
      });
    }

    (this.prisma as any).$on('error', (e) => {
      logger.error({
        target: e.target,
        message: e.message
      }, 'Database Error');
    });

    (this.prisma as any).$on('info', (e) => {
      logger.info({
        target: e.target,
        message: e.message
      }, 'Database Info');
    });

    (this.prisma as any).$on('warn', (e) => {
      logger.warn({
        target: e.target,
        message: e.message
      }, 'Database Warning');
    });
  }

  async connect() {
    try {
      await this.prisma.$connect();
      logger.info('Database connected successfully');
    } catch (error) {
      logger.error('Failed to connect to database:', error);
      throw error;
    }
  }

  async disconnect() {
    try {
      await this.prisma.$disconnect();
      logger.info('Database disconnected successfully');
    } catch (error) {
      logger.error('Failed to disconnect from database:', error);
      throw error;
    }
  }

  // User operations
  async createUser(data: {
    email: string;
    name?: string;
    password: string;
    role?: 'USER' | 'ADMIN';
  }) {
    return this.prisma.user.create({
      data,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        apiKey: true,
        isActive: true,
        createdAt: true
      }
    });
  }

  async getUserByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      include: {
        sessions: {
          where: { isActive: true },
          select: {
            id: true,
            sessionId: true,
            status: true,
            phoneNumber: true,
            name: true,
            lastSeen: true
          }
        }
      }
    });
  }

  async getUserByApiKey(apiKey: string) {
    return this.prisma.user.findUnique({
      where: { apiKey },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        apiKey: true,
        isActive: true
      }
    });
  }

  // Session operations
  async createSession(data: {
    sessionId: string;
    userId: string;
    phoneNumber?: string;
    name?: string;
  }) {
    return this.prisma.session.create({
      data
    });
  }

  async updateSession(sessionId: string, data: any) {
    return this.prisma.session.update({
      where: { sessionId },
      data
    });
  }

  async getSession(sessionId: string) {
    return this.prisma.session.findUnique({
      where: { sessionId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true
          }
        }
      }
    });
  }

  async getUserSessions(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, isActive: true },
      orderBy: { lastSeen: 'desc' }
    });
  }

  async getAllActiveSessions() {
    return this.prisma.session.findMany({
      where: { isActive: true },
      select: {
        id: true,
        sessionId: true,
        userId: true,
        status: true,
        phoneNumber: true,
        name: true
      },
      orderBy: { createdAt: 'asc' }
    });
  }

  async deleteSession(sessionId: string) {
    return this.prisma.session.update({
      where: { sessionId },
      data: { isActive: false }
    });
  }

  // Message operations
  async saveMessage(data: {
    messageId: string;
    sessionId: string;
    chatId: string;
    fromMe: boolean;
    fromJid?: string;
    toJid: string;
    messageType: string;
    content?: BaileysMessageContent;
    timestamp: Date;
    quotedMessage?: string;
    metadata?: any;
  }) {
    try {
      // Resolve sessionId string to session's internal ID
      const session = await this.prisma.session.findUnique({
        where: { sessionId: data.sessionId },
        select: { id: true }
      });

      if (!session) {
        throw new Error(`Session not found: ${data.sessionId}`);
      }

      // Ensure content is not undefined (use empty object if not provided)
      const content = data.content || {};

      // Use upsert to handle duplicate messages gracefully
      // If message already exists, update it; otherwise create it
      return this.prisma.message.upsert({
        where: {
          sessionId_messageId: {
            sessionId: session.id,
            messageId: data.messageId
          }
        },
        update: {
          // Update these fields if message already exists
          content: content,
          status: 'PENDING',
          metadata: data.metadata,
          updatedAt: new Date()
        },
        create: {
          // Create new message with all fields
          messageId: data.messageId,
          sessionId: session.id,
          chatId: data.chatId,
          fromMe: data.fromMe,
          fromJid: data.fromJid,
          toJid: data.toJid,
          messageType: data.messageType as any,
          content: content,
          timestamp: data.timestamp,
          quotedMessage: data.quotedMessage,
          metadata: data.metadata
        }
      });
    } catch (error) {
      logger.error({
        sessionId: data.sessionId,
        messageId: data.messageId,
        error: error instanceof Error ? error.message : String(error)
      }, 'Failed to save message');
      throw error;
    }
  }

  async updateMessageStatus(messageId: string, sessionId: string, status: string) {
    try {
      // Validate status is a valid MessageStatus enum
      const validStatuses = ['PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED'];
      if (!validStatuses.includes(status)) {
        throw new Error(`Invalid message status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
      }

      // Resolve sessionId string to session's internal ID
      const session = await this.prisma.session.findUnique({
        where: { sessionId },
        select: { id: true }
      });

      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      return this.prisma.message.updateMany({
        where: { messageId, sessionId: session.id },
        data: { status: status as any }
      });
    } catch (error) {
      logger.error({
        sessionId,
        messageId,
        status,
        error: error instanceof Error ? error.message : String(error)
      }, 'Failed to update message status');
      throw error;
    }
  }

  async getMessages(sessionId: string, chatId?: string, limit = 50, offset = 0) {
    try {
      // Resolve sessionId string to session's internal ID
      const session = await this.prisma.session.findUnique({
        where: { sessionId },
        select: { id: true }
      });

      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      return this.prisma.message.findMany({
        where: {
          sessionId: session.id,
          ...(chatId && { chatId })
        },
        orderBy: { timestamp: 'desc' },
        take: limit,
        skip: offset
      });
    } catch (error) {
      logger.error({
        sessionId,
        chatId,
        error: error instanceof Error ? error.message : String(error)
      }, 'Failed to get messages');
      throw error;
    }
  }

  async getMessageByMessageId(messageId: string, sessionId: string) {
  try {
    const session = await this.prisma.session.findUnique({
      where: { sessionId },
      select: { id: true }
    });

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return this.prisma.message.findFirst({
      where: {
        messageId,
        sessionId: session.id
      }
    });
  } catch (error) {
    logger.error({
      sessionId,
      messageId,
      error: error instanceof Error ? error.message : String(error)
    }, 'Failed to get message by ID');
    throw error;
  }
}

async deleteMessage(messageId: string, sessionId: string) {
  try {
    const session = await this.prisma.session.findUnique({
      where: { sessionId },
      select: { id: true }
    });

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return this.prisma.message.deleteMany({
      where: {
        messageId,
        sessionId: session.id
      }
    });
  } catch (error) {
    logger.error({
      sessionId,
      messageId,
      error: error instanceof Error ? error.message : String(error)
    }, 'Failed to delete message');
    throw error;
  }
}

  // Chat operations
  async upsertChat(data: {
    sessionId: string;
    jid: string;
    name?: string;
    isGroup: boolean;
    isArchived?: boolean;
    isPinned?: boolean;
    isMuted?: boolean;
    unreadCount?: number;
    lastMessage?: any;
    metadata?: any;
  }) {
    try {
      // Resolve sessionId string to session's internal ID
      const session = await this.prisma.session.findUnique({
        where: { sessionId: data.sessionId },
        select: { id: true }
      });

      if (!session) {
        throw new Error(`Session not found: ${data.sessionId}`);
      }

      return this.prisma.chat.upsert({
        where: {
          sessionId_jid: {
            sessionId: session.id,
            jid: data.jid
          }
        },
        update: {
          name: data.name,
          isArchived: data.isArchived,
          isPinned: data.isPinned,
          isMuted: data.isMuted,
          unreadCount: data.unreadCount,
          lastMessage: data.lastMessage,
          metadata: data.metadata,
          updatedAt: new Date()
        },
        create: {
          ...data,
          sessionId: session.id
        }
      });
    } catch (error) {
      logger.error({
        sessionId: data.sessionId,
        jid: data.jid,
        error: error instanceof Error ? error.message : String(error)
      }, 'Failed to upsert chat');
      throw error;
    }
  }

  async getChats(sessionId: string) {
    try {
      // Resolve sessionId string to session's internal ID
      const session = await this.prisma.session.findUnique({
        where: { sessionId },
        select: { id: true }
      });

      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      return this.prisma.chat.findMany({
        where: { sessionId: session.id },
        orderBy: { updatedAt: 'desc' }
      });
    } catch (error) {
      logger.error({
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      }, 'Failed to get chats');
      throw error;
    }
  }

  // Contact operations
  async upsertContact(data: {
    sessionId: string;
    jid: string;
    name?: string;
    pushName?: string;
    profilePicUrl?: string;
    isBlocked?: boolean;
    metadata?: any;
  }) {
    try {
      // Resolve sessionId string to session's internal ID
      const session = await this.prisma.session.findUnique({
        where: { sessionId: data.sessionId },
        select: { id: true }
      });

      if (!session) {
        throw new Error(`Session not found: ${data.sessionId}`);
      }

      return this.prisma.contact.upsert({
        where: {
          sessionId_jid: {
            sessionId: session.id,
            jid: data.jid
          }
        },
        update: {
          name: data.name,
          pushName: data.pushName,
          profilePicUrl: data.profilePicUrl,
          isBlocked: data.isBlocked,
          metadata: data.metadata,
          updatedAt: new Date()
        },
        create: {
          ...data,
          sessionId: session.id
        }
      });
    } catch (error) {
      logger.error({
        sessionId: data.sessionId,
        jid: data.jid,
        error: error instanceof Error ? error.message : String(error)
      }, 'Failed to upsert contact');
      throw error;
    }
  }

  async getContacts(sessionId: string) {
    try {
      // Resolve sessionId string to session's internal ID
      const session = await this.prisma.session.findUnique({
        where: { sessionId },
        select: { id: true }
      });

      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      return this.prisma.contact.findMany({
        where: { sessionId: session.id },
        orderBy: { name: 'asc' }
      });
    } catch (error) {
      logger.error({
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      }, 'Failed to get contacts');
      throw error;
    }
  }

  // Webhook operations
  async createWebhook(data: {
    userId: string;
    url: string;
    events: string[];
    secret?: string;
    maxRetries?: number;
  }) {
    return this.prisma.webhook.create({
      data
    });
  }

  async getUserWebhooks(userId: string) {
    return this.prisma.webhook.findMany({
      where: { userId, isActive: true }
    });
  }

  async updateWebhook(id: string, data: any) {
    return this.prisma.webhook.update({
      where: { id },
      data
    });
  }

  async deleteWebhook(id: string) {
    return this.prisma.webhook.update({
      where: { id },
      data: { isActive: false }
    });
  }

  // API Usage operations
  async getApiUsageStats(userId: string, startDate: Date, endDate: Date) {
    return this.prisma.apiUsage.groupBy({
      by: ['endpoint', 'method'],
      where: {
        userId,
        timestamp: {
          gte: startDate,
          lte: endDate
        }
      },
      _count: {
        id: true
      },
      _avg: {
        duration: true
      }
    });
  }

  async getDashboardStats(userId?: string) {
    const where = userId ? { userId } : {};
    const whereMessage = userId ? { session: { userId } } : {};

    const [
      totalSessions,
      activeSessions,
      totalMessages,
      messagesLast24h,
      totalUsers,
      apiCallsLast24h
    ] = await Promise.all([
      this.prisma.session.count({ where: { ...where, isActive: true } }),
      this.prisma.session.count({ 
        where: { 
          ...where, 
          isActive: true, 
          status: 'CONNECTED' 
        } 
      }),
      this.prisma.message.count({ where: whereMessage }),
      this.prisma.message.count({
        where: {
          ...whereMessage,
          timestamp: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
          }
        }
      }),
      userId ? 1 : this.prisma.user.count({ where: { isActive: true } }),
      this.prisma.apiUsage.count({
        where: {
          ...where,
          timestamp: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
          }
        }
      })
    ]);

    return {
      totalSessions,
      activeSessions,
      totalMessages,
      messagesLast24h,
      totalUsers,
      apiCallsLast24h
    };
  }

  get client() {
    return this.prisma;
  }
}
