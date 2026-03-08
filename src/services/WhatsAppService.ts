import { Server as SocketIOServer } from 'socket.io';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  AnyMessageContent,
  WASocket,
  BaileysEventMap,
  ConnectionState
} from '../index';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { logger, whatsappLogger } from '../Utils/apiLogger';
import { DatabaseService } from './DatabaseService';
import { WebhookService } from './WebhookService';
import { WhatsAppSession, SessionStatus } from '../Types/api';

export class WhatsAppService {
  private sessions: Map<string, WhatsAppSession> = new Map();
  private io: SocketIOServer;
  private dbService: DatabaseService;
  private webhookService: WebhookService;

  constructor(io: SocketIOServer) {
    this.io = io;
    this.dbService = new DatabaseService();
    this.webhookService = new WebhookService();
    
    // Ensure auth directory exists
    const authDir = join(process.cwd(), 'auth_sessions');
    if (!existsSync(authDir)) {
      mkdirSync(authDir, { recursive: true });
    }
  }

  /**
   * Convert Baileys message status (numeric) to MessageStatus enum
   * Baileys status codes: 0=UNSENT, 1=SENT, 2=DELIVERED, 3=READ, 4=PLAYED
   */
  private mapBaileysStatusToMessageStatus(status: number): string {
    const statusMap: Record<number, string> = {
      0: 'PENDING',
      1: 'SENT',
      2: 'DELIVERED',
      3: 'READ',
      4: 'READ' // PLAYED also maps to READ
    };
    return statusMap[status] || 'PENDING';
  }

  async createSession(sessionId: string, userId: string, usePairingCode = false): Promise<WhatsAppSession> {
    try {
      if (this.sessions.has(sessionId)) {
        throw new Error('Session already exists');
      }

      // Create session record in database
      await this.dbService.createSession({
        sessionId,
        userId
      });

      const session: WhatsAppSession = {
        id: sessionId,
        socket: null,
        status: SessionStatus.CONNECTING,
        lastSeen: new Date()
      };

      this.sessions.set(sessionId, session);

      // Initialize WhatsApp connection
      await this.initializeWhatsAppConnection(sessionId, usePairingCode);

      return session;
    } catch (error) {
      whatsappLogger.error(`Failed to create session ${sessionId}:`, error);
      throw error;
    }
  }

  private async initializeWhatsAppConnection(sessionId: string, usePairingCode = false) {
    try {
      const authDir = join(process.cwd(), 'auth_sessions', sessionId);
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const { version } = await fetchLatestBaileysVersion();

      const socket = makeWASocket({
        version,
        logger: whatsappLogger,
        printQRInTerminal: false,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, whatsappLogger)
        },
        generateHighQualityLinkPreview: true,
        getMessage: async (key) => {
          // Implement message retrieval from database
          return undefined;
          // return {
          //   conversation: 'Pesan terenkripsi'
          // };
        }
      });

      // ADD 8-Maret-2026, FIX 1: Gunakan Map (.has dan .set) agar memori sesi tidak bocor
      if (!this.sessions.has(sessionId)) {
        this.sessions.set(sessionId, {} as WhatsAppSession);
      }

      const session = this.sessions.get(sessionId)!;
      session.socket = socket;

      // Handle connection events
      socket.ev.on('connection.update', async (update) => {
        await this.handleConnectionUpdate(sessionId, update);
      });

      // Handle credentials update
      socket.ev.on('creds.update', saveCreds);

      // Handle messages
      socket.ev.on('messages.upsert', async (messageUpdate) => {
        await this.handleMessagesUpsert(sessionId, messageUpdate);
      });

      // Handle message updates (read receipts, etc.)
      socket.ev.on('messages.update', async (messageUpdates) => {
        await this.handleMessagesUpdate(sessionId, messageUpdates);
      });

      // Handle chats
      socket.ev.on('chats.upsert', async (chats) => {
        await this.handleChatsUpsert(sessionId, chats);
      });

      // Handle contacts
      socket.ev.on('contacts.upsert', async (contacts) => {
        await this.handleContactsUpsert(sessionId, contacts);
      });

      // Handle groups
      socket.ev.on('groups.upsert', async (groups) => {
        await this.handleGroupsUpsert(sessionId, groups);
      });

      // Handle pairing code if requested
      if (usePairingCode && !socket.authState.creds.registered) {
        session.status = SessionStatus.PAIRING_REQUIRED;
        await this.updateSessionInDatabase(sessionId, { status: 'PAIRING_REQUIRED' });
        this.emitSessionUpdate(sessionId);
      }

    } catch (error) {
      whatsappLogger.error(`Failed to initialize WhatsApp connection for ${sessionId}:`, error);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.status = SessionStatus.ERROR;
        await this.updateSessionInDatabase(sessionId, { status: 'ERROR' });
        this.emitSessionUpdate(sessionId);
      }
      throw error;
    }
  }

  private async handleConnectionUpdate(sessionId: string, update: Partial<ConnectionState>) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const { connection, lastDisconnect, qr } = update;

    whatsappLogger.info(`Connection update for ${sessionId}:`, { connection, lastDisconnect: lastDisconnect?.error?.message });

    if (qr) {
      // Generate QR code
      try {
        const qrCodeDataURL = await QRCode.toDataURL(qr);
        session.qrCode = qrCodeDataURL;
        session.status = SessionStatus.QR_REQUIRED;
        await this.updateSessionInDatabase(sessionId, { 
          status: 'QR_REQUIRED',
          qrCode: qrCodeDataURL 
        });
        this.emitSessionUpdate(sessionId);
      } catch (error) {
        whatsappLogger.error(`Failed to generate QR code for ${sessionId}:`, error);
      }
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      
      if (shouldReconnect) {
        whatsappLogger.info(`Reconnecting session ${sessionId}`);
        session.status = SessionStatus.CONNECTING;
        await this.updateSessionInDatabase(sessionId, { status: 'CONNECTING' });
        this.emitSessionUpdate(sessionId);
        
        // Reconnect after a delay
        setTimeout(() => {
          this.initializeWhatsAppConnection(sessionId);
        }, 5000);
      } else {
        whatsappLogger.info(`Session ${sessionId} logged out`);
        session.status = SessionStatus.DISCONNECTED;
        await this.updateSessionInDatabase(sessionId, { status: 'DISCONNECTED' });
        this.emitSessionUpdate(sessionId);
      }
    } else if (connection === 'open') {
      whatsappLogger.info(`Session ${sessionId} connected`);
      session.status = SessionStatus.CONNECTED;
      session.lastSeen = new Date();
      session.qrCode = undefined;
      session.pairingCode = undefined;
      
      // Get user info
      const user = session.socket?.user;
      if (user) {
        session.phoneNumber = user.id.split(':')[0];
        session.name = user.name;
      }

      await this.updateSessionInDatabase(sessionId, {
        status: 'CONNECTED',
        phoneNumber: session.phoneNumber,
        name: session.name,
        lastSeen: session.lastSeen,
        qrCode: null
      });
      
      this.emitSessionUpdate(sessionId);
    }
  }

  private async handleMessagesUpsert(sessionId: string, messageUpdate: any) {
    const { messages, type } = messageUpdate;

    for (const message of messages) {
      try {
        // Skip messages that failed to decrypt (message is empty)
        if (!message.message) {
          whatsappLogger.warn(`Skipping undecryptable message ${message.key.id} from ${message.key.remoteJid}`);
          
          // For group messages, request sender keys
          if (message.key.remoteJid?.endsWith('@g.us')) {
            try {
              const session = this.sessions.get(sessionId);
              if (session?.socket) {
                await session.socket.resyncAppState(['critical_block'], false);
              }
            } catch (error) {
              whatsappLogger.debug('Could not request app state resync:', error);
            }
          }
          continue;
        }

        // Save message to database
        await this.dbService.saveMessage({
          messageId: message.key.id!,
          sessionId,
          chatId: message.key.remoteJid!,
          fromMe: message.key.fromMe || false,
          fromJid: message.key.participant || message.key.remoteJid,
          toJid: message.key.remoteJid!,
          messageType: this.getMessageType(message.message),
          content: message.message,
          timestamp: new Date(message.messageTimestamp! * 1000),
          quotedMessage: message.message?.extendedTextMessage?.contextInfo?.quotedMessage ? 
            message.message.extendedTextMessage.contextInfo.stanzaId : undefined,
          metadata: { type, pushName: message.pushName }
        });

        // Emit to websocket clients
        this.io.emit('message', {
          sessionId,
          message,
          type
        });

        // Send webhook
        await this.webhookService.sendWebhook(sessionId, 'message.received', {
          sessionId,
          message,
          type
        });

      } catch (error) {
        // Log error but don't throw - continue processing other messages
        const errorMsg = error instanceof Error ? error.message : String(error);
        
        // Only log critical errors, skip decryption errors
        if (!errorMsg.includes('decryption') && !errorMsg.includes('SenderKeyRecord')) {
          whatsappLogger.error(`Failed to handle message for ${sessionId}:`, error);
        }
      }
    }
  }

  private async handleMessagesUpdate(sessionId: string, messageUpdates: any[]) {
    for (const update of messageUpdates) {
      try {
        const { key, update: messageUpdate } = update;
        
        if (messageUpdate.status !== undefined && messageUpdate.status !== null) {
          // Convert numeric Baileys status to MessageStatus enum
          const mappedStatus = this.mapBaileysStatusToMessageStatus(messageUpdate.status);
          await this.dbService.updateMessageStatus(
            key.id!,
            sessionId,
            mappedStatus
          );
        }

        // Emit to websocket clients
        this.io.emit('messageUpdate', {
          sessionId,
          key,
          update: messageUpdate
        });

        // Send webhook
        await this.webhookService.sendWebhook(sessionId, 'message.updated', {
          sessionId,
          key,
          update: messageUpdate
        });

      } catch (error) {
        whatsappLogger.error(`Failed to handle message update for ${sessionId}:`, error);
      }
    }
  }

  private async handleChatsUpsert(sessionId: string, chats: any[]) {
    for (const chat of chats) {
      try {
        await this.dbService.upsertChat({
          sessionId,
          jid: chat.id,
          name: chat.name,
          isGroup: chat.id.endsWith('@g.us'),
          isArchived: chat.archived || false,
          isPinned: chat.pinned || false,
          isMuted: chat.mute || false,
          unreadCount: chat.unreadCount || 0,
          lastMessage: chat.lastMessage,
          metadata: chat
        });

        // Emit to websocket clients
        this.io.emit('chatUpdate', {
          sessionId,
          chat
        });

      } catch (error) {
        whatsappLogger.error(`Failed to handle chat upsert for ${sessionId}:`, error);
      }
    }
  }

  private async handleContactsUpsert(sessionId: string, contacts: any[]) {
    for (const contact of contacts) {
      try {
        await this.dbService.upsertContact({
          sessionId,
          jid: contact.id,
          name: contact.name,
          pushName: contact.notify,
          profilePicUrl: contact.imgUrl,
          isBlocked: contact.blocked || false,
          metadata: contact
        });

        // Emit to websocket clients
        this.io.emit('contactUpdate', {
          sessionId,
          contact
        });

      } catch (error) {
        whatsappLogger.error(`Failed to handle contact upsert for ${sessionId}:`, error);
      }
    }
  }

  private async handleGroupsUpsert(sessionId: string, groups: any[]) {
    for (const group of groups) {
      try {
        await this.dbService.upsertGroup({
          sessionId,
          jid: group.id,
          subject: group.subject,
          description: group.desc,
          owner: group.owner,
          participants: group.participants,
          settings: group,
          metadata: group
        });

        // Emit to websocket clients
        this.io.emit('groupUpdate', {
          sessionId,
          group
        });

      } catch (error) {
        whatsappLogger.error(`Failed to handle group upsert for ${sessionId}:`, error);
      }
    }
  }

  private getMessageType(message: any): string {
    if (message?.conversation) return 'TEXT';
    if (message?.extendedTextMessage) return 'TEXT';
    if (message?.imageMessage) return 'IMAGE';
    if (message?.videoMessage) return 'VIDEO';
    if (message?.audioMessage) return 'AUDIO';
    if (message?.documentMessage) return 'DOCUMENT';
    if (message?.stickerMessage) return 'STICKER';
    if (message?.locationMessage) return 'LOCATION';
    if (message?.contactMessage) return 'CONTACT';
    if (message?.pollCreationMessage) return 'POLL';
    if (message?.reactionMessage) return 'REACTION';
    return 'TEXT';
  }

  private async updateSessionInDatabase(sessionId: string, data: any) {
    try {
      await this.dbService.updateSession(sessionId, data);
    } catch (error) {
      whatsappLogger.error(`Failed to update session ${sessionId} in database:`, error);
    }
  }

  private emitSessionUpdate(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.io.emit('sessionUpdate', {
        sessionId,
        status: session.status,
        qrCode: session.qrCode,
        pairingCode: session.pairingCode,
        phoneNumber: session.phoneNumber,
        name: session.name,
        lastSeen: session.lastSeen
      });
    }
  }

  // Public methods for API endpoints
  async getSession(sessionId: string): Promise<WhatsAppSession | undefined> {
    return this.sessions.get(sessionId);
  }

  async getAllSessions(): Promise<WhatsAppSession[]> {
    return Array.from(this.sessions.values());
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session?.socket) {
      session.socket.end(undefined);
    }
    this.sessions.delete(sessionId);
    await this.dbService.deleteSession(sessionId);
    // Clear session ID cache
    this.dbService.clearSessionIdCache(sessionId);
  }

  async requestPairingCode(sessionId: string, phoneNumber: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session?.socket) {
      throw new Error('Session not found or not initialized');
    }

    const code = await session.socket.requestPairingCode(phoneNumber);
    session.pairingCode = code;
    session.phoneNumber = phoneNumber;
    
    await this.updateSessionInDatabase(sessionId, {
      pairingCode: code,
      phoneNumber
    });
    
    this.emitSessionUpdate(sessionId);
    return code;
  }

  // Typing Indicators
  async sendTypingIndicator(sessionId: string, chatId: string, isTyping: boolean = true) {
    const session = this.sessions.get(sessionId);
    if (!session?.socket) {
      throw new Error('Session not connected');
    }

    try {
      await session.socket.sendPresenceUpdate(isTyping ? 'composing' : 'paused', chatId);
      whatsappLogger.info(`Typing indicator ${isTyping ? 'started' : 'stopped'} for ${sessionId} in ${chatId}`);
    } catch (error) {
      whatsappLogger.error(`Failed to send typing indicator for ${sessionId}:`, error);
      throw error;
    }
  }

  // Mark chat as read
  async markChatAsRead(sessionId: string, chatId: string) {
    const session = this.sessions.get(sessionId);
    if (!session?.socket) {
      throw new Error('Session not connected');
    }

    try {
      await session.socket.chatModify({ markRead: true, lastMessages: [] }, chatId);
      whatsappLogger.info(`Chat ${chatId} marked as read for ${sessionId}`);
    } catch (error) {
      whatsappLogger.error(`Failed to mark chat as read for ${sessionId}:`, error);
      throw error;
    }
  }

  // Delete message
  async deleteMessage(sessionId: string, chatId: string, messageKey: any) {
    const session = this.sessions.get(sessionId);
    if (!session?.socket) {
      throw new Error('Session not connected');
    }

    try {
      await session.socket.sendMessage(chatId, { delete: messageKey });
      whatsappLogger.info(`Message deleted in ${chatId} for ${sessionId}`);
    } catch (error) {
      whatsappLogger.error(`Failed to delete message for ${sessionId}:`, error);
      throw error;
    }
  }

  // Edit message
  async editMessage(sessionId: string, chatId: string, messageKey: any, newText: string) {
    const session = this.sessions.get(sessionId);
    if (!session?.socket) {
      throw new Error('Session not connected');
    }

    try {
      await session.socket.sendMessage(chatId, { edit: messageKey, text: newText });
      whatsappLogger.info(`Message edited in ${chatId} for ${sessionId}`);
    } catch (error) {
      whatsappLogger.error(`Failed to edit message for ${sessionId}:`, error);
      throw error;
    }
  }

  async sendMessage(sessionId: string, to: string, content: AnyMessageContent): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session?.socket) {
      throw new Error('Session not found or not connected');
    }

    if (session.status !== SessionStatus.CONNECTED) {
      throw new Error('Session not connected');
    }

    return await session.socket.sendMessage(to, content);
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down WhatsApp service...');
    
    for (const [sessionId, session] of this.sessions) {
      if (session.socket) {
        try {
          session.socket.end(undefined);
        } catch (error) {
          whatsappLogger.error(`Error closing session ${sessionId}:`, error);
        }
      }
    }
    
    this.sessions.clear();
    await this.dbService.disconnect();
    logger.info('WhatsApp service shutdown complete');
  }

  /**
   * Recover and reconnect to all existing active sessions
   * This is called when the server starts to re-establish connections
   */
  async recoverSessions(): Promise<void> {
    try {
      logger.info('Recovering existing sessions...');
      
      // Get all active sessions from database
      const allSessions = await this.dbService.getAllActiveSessions();
      
      if (allSessions.length === 0) {
        logger.info('No active sessions to recover');
        return;
      }

      logger.info(`Found ${allSessions.length} active sessions to recover`);

      // Reconnect to each session
      for (const dbSession of allSessions) {
        try {
          const { sessionId, userId } = dbSession;
          
          // Check if auth credentials exist
          const authDir = join(process.cwd(), 'auth_sessions', sessionId);
          if (!existsSync(authDir)) {
            logger.warn(`Auth directory not found for session ${sessionId}, skipping recovery`);
            continue;
          }

          logger.info(`Recovering session ${sessionId}...`);
          
          // Initialize the connection without waiting for user interaction
          await this.initializeWhatsAppConnection(sessionId, false);
          
          // Update session status to CONNECTING
          await this.updateSessionInDatabase(sessionId, { status: 'CONNECTING' });
          
          logger.info(`Session ${sessionId} connection initiated`);
        } catch (error) {
          whatsappLogger.error(`Failed to recover session ${dbSession.sessionId}:`, error);
          // Continue with next session even if one fails
        }
      }

      logger.info('Session recovery process completed');
    } catch (error) {
      logger.error('Error during session recovery:', error);
    }
  }
}
