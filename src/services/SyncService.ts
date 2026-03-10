import { WASocket } from '../index';
import { logger } from '../Utils/apiLogger';

export class SyncService {
  /**
   * Comprehensive app state sync sequence
   * Follows recommended order:
   * 1. Critical block (highest priority data)
   * 2. Regular high (chat list, contacts, groups)
   * 3. Regular (standard priority data)
   * NOTE: regular_low is SKIPPED - known to cause "tried remove, but no previous op" patch corruption error
   * 4. Message history
   * 
   * Each collection syncs independently - if one fails, others continue
   */
  static async fullySync(
    socket: WASocket,
    sessionId: string,
    options?: {
      skipHistory?: boolean;
      timeout?: number;
    }
  ): Promise<SyncResult> {
    const result: SyncResult = {
      sessionId,
      startTime: new Date(),
      steps: [],
      success: false,
      error: null
    };

    try {
      logger.info(`[SyncService] Starting comprehensive sync for session ${sessionId}`);

      // Step 1: Sync critical_block (highest priority)
      // This includes encryption keys, critical data
      result.steps.push(
        await this.syncAppStateCollection(socket, 'critical_block', sessionId)
      );

      // Step 2: Sync regular_high (chats, contacts, groups)
      // This is the main data users care about
      result.steps.push(
        await this.syncAppStateCollection(socket, 'regular_high', sessionId)
      );

      // Step 3: Sync regular (standard priority data)
      result.steps.push(
        await this.syncAppStateCollection(socket, 'regular', sessionId)
      );

      // Step 4: SKIP regular_low
      // NOTE: Baileys has known issue with regular_low - patch corruption error:
      // "Error: tried remove, but no previous op" at chat-utils.ts:74
      // This is low priority data anyway, so safe to skip
      logger.debug(`[SyncService] Skipping regular_low collection (known patch corruption issue)`);
      result.steps.push({
        collection: 'regular_low',
        status: 'skipped',
        message: 'Skipped - known patch corruption issue in Baileys core',
        error: null,
        retryCount: 0
      });

      // Step 5: Fetch latest messages from all chats (if available)
      if (!options?.skipHistory) {
        result.steps.push(
          await this.fetchMessageHistory(socket, sessionId)
        );
      }

      // Determine overall success: at least critical_block and regular_high must succeed
      const criticalBlockStatus = result.steps.find(s => s.collection === 'critical_block')?.status;
      const regularHighStatus = result.steps.find(s => s.collection === 'regular_high')?.status;
      
      result.success = criticalBlockStatus === 'success' && regularHighStatus === 'success';

      result.endTime = new Date();

      const successfulCount = result.steps.filter(s => s.status === 'success').length;
      const failedCount = result.steps.filter(s => s.status === 'failed').length;

      logger.info(`[SyncService] Comprehensive sync completed for session ${sessionId}`, {
        duration: `${(result.endTime.getTime() - result.startTime.getTime()) / 1000}s`,
        success: result.success,
        successful: successfulCount,
        failed: failedCount,
        steps: result.steps.map(s => `${s.collection}: ${s.status}`)
      });

      return result;
    } catch (error) {
      result.success = false;
      result.error = error instanceof Error ? error.message : String(error);
      result.endTime = new Date();

      logger.error(`[SyncService] Comprehensive sync failed for session ${sessionId}:`, error);
      return result;
    }
  }

  /**
   * Sync single app state collection with retry logic and individual error handling
   * If a collection fails, it doesn't break the entire sync process
   */
  private static async syncAppStateCollection(
    socket: WASocket,
    collection: 'critical_block' | 'regular_high' | 'regular',
    sessionId: string,
    retries = 3
  ): Promise<SyncStep> {
    const step: SyncStep = {
      collection,
      status: 'pending',
      message: '',
      error: null,
      retryCount: 0
    };

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        logger.debug(`[SyncService] Syncing ${collection} (attempt ${attempt}/${retries})...`);

        // isInitialSync: true = full sync (slower but complete)
        await socket.resyncAppState([collection], true);

        step.status = 'success';
        step.message = `${collection} synced successfully`;
        logger.info(`[SyncService] ✓ ${collection} sync completed for session ${sessionId}`);
        return step;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        step.error = errorMsg;
        step.retryCount = attempt;

        // Check if this is the known regular_low patch corruption error
        const isPatchCorruptionError = errorMsg.includes('tried remove, but no previous op');

        if (attempt < retries && !isPatchCorruptionError) {
          const delayMs = 2000 * attempt; // exponential backoff: 2s, 4s, 6s
          logger.warn(
            `[SyncService] ${collection} sync failed (attempt ${attempt}/${retries}), retrying in ${delayMs}ms...`,
            { error: errorMsg }
          );
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } else {
          step.status = 'failed';
          logger.error(
            `[SyncService] ✗ ${collection} sync failed after ${attempt} attempts for session ${sessionId}`,
            { 
              error: errorMsg,
              isPatchCorruption: isPatchCorruptionError
            }
          );
          // Return with failed status - don't throw, let other collections continue
          return step;
        }
      }
    }

    return step;
  }

  /**
   * Fetch message history from all chats
   */
  private static async fetchMessageHistory(
    socket: WASocket,
    sessionId: string
  ): Promise<SyncStep> {
    const step: SyncStep = {
      collection: 'message_history',
      status: 'pending',
      message: '',
      error: null,
      retryCount: 0
    };

    try {
      logger.debug(`[SyncService] Fetching message history from all chats...`);

      // Fetch latest messages from all chats
      const fetchLatestFunc = (socket as any).fetchLatestMessagesFromAllChats;
      if (typeof fetchLatestFunc === 'function') {
        const result = await fetchLatestFunc();
        step.status = 'success';
        step.message = `Fetched message history from ${result?.length || 0} chats`;
        logger.info(
          `[SyncService] ✓ Message history sync completed for session ${sessionId}`,
          { chatCount: result?.length }
        );
      } else {
        step.status = 'skipped';
        step.message = 'fetchLatestMessagesFromAllChats not available';
        logger.debug(`[SyncService] Message history fetch not available in this version`);
      }

      return step;
    } catch (error) {
      step.status = 'failed';
      step.error = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[SyncService] Message history sync failed for session ${sessionId}`,
        { error: step.error }
      );
      return step;
    }
  }

  /**
   * Quick app state sync (incremental)
   * Faster than full sync but only gets changes
   * Also skips regular_low to avoid patch corruption errors
   */
  static async quickSync(socket: WASocket, sessionId: string): Promise<SyncResult> {
    const result: SyncResult = {
      sessionId,
      startTime: new Date(),
      steps: [],
      success: false,
      error: null
    };

    try {
      logger.info(`[SyncService] Starting quick sync for session ${sessionId}`);

      // isInitialSync: false = incremental sync (faster)
      // Sync only critical_block and regular (most important collections)
      // Skip regular_low due to known patch corruption issues
      await socket.resyncAppState(['critical_block', 'regular'], false);

      result.steps.push({
        collection: 'critical_block + regular',
        status: 'success',
        message: 'Quick sync completed (incremental)',
        error: null,
        retryCount: 0
      });

      result.success = true;
      result.endTime = new Date();

      logger.info(`[SyncService] Quick sync completed for session ${sessionId}`, {
        duration: `${(result.endTime.getTime() - result.startTime.getTime()) / 1000}s`
      });

      return result;
    } catch (error) {
      result.success = false;
      result.error = error instanceof Error ? error.message : String(error);
      result.endTime = new Date();

      logger.error(`[SyncService] Quick sync failed for session ${sessionId}:`, error);
      return result;
    }
  }
}

export interface SyncStep {
  collection: string;
  status: 'pending' | 'success' | 'failed' | 'skipped';
  message: string;
  error: string | null;
  retryCount: number;
}

export interface SyncResult {
  sessionId: string;
  startTime: Date;
  endTime?: Date;
  steps: SyncStep[];
  success: boolean;
  error: string | null;
}
