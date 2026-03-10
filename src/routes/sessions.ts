import { Router } from 'express';
import { body, param } from 'express-validator';
import { handleValidationErrors, asyncHandler } from '../middleware/errorHandler';
import { sessionMiddleware } from '../middleware/auth';
import { whatsAppService } from '../app';
import { DatabaseService } from '../services/DatabaseService';
import { SyncService } from '../services/SyncService';
import { logger } from '../Utils/apiLogger';
import { ApiResponse, SessionStatus } from '../Types/api';
import { isValidSessionId, isValidPhoneNumber } from '../Utils/validation';

const router = Router();
const dbService = new DatabaseService();

/**
 * @swagger
 * /api/sessions:
 *   get:
 *     summary: Get all user sessions
 *     tags: [Sessions]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Sessions retrieved successfully
 */
router.get('/', asyncHandler(async (req, res) => {
  const sessions = await dbService.getUserSessions(req.user!.id);
  
  // Enhance with real-time status from WhatsApp service
  const enhancedSessions = await Promise.all(sessions.map(async session => {
    const liveSession = await whatsAppService.getSession(session.sessionId);
    return {
      id: session.id,
      sessionId: session.sessionId,
      phoneNumber: session.phoneNumber,
      name: session.name,
      status: session.status,
      isActive: session.isActive,
      metadata: session.metadata,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      liveStatus: liveSession?.status || SessionStatus.DISCONNECTED,
      qrCode: liveSession?.qrCode,
      pairingCode: liveSession?.pairingCode
    };
  }));

  res.json({
    success: true,
    data: enhancedSessions,
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

/**
 * @swagger
 * /api/sessions:
 *   post:
 *     summary: Create a new WhatsApp session
 *     tags: [Sessions]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               sessionId:
 *                 type: string
 *                 description: Unique session identifier
 *               usePairingCode:
 *                 type: boolean
 *                 default: false
 *                 description: Use pairing code instead of QR code
 *     responses:
 *       201:
 *         description: Session created successfully
 *       400:
 *         description: Session already exists
 */
router.post('/', [
  body('sessionId').notEmpty().trim().custom((value) => {
    if (!isValidSessionId(value)) throw new Error('Invalid session ID format (3-100 alphanumeric characters)');
    return true;
  }),
  body('usePairingCode').optional().isBoolean().withMessage('usePairingCode must be a boolean')
], handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, usePairingCode = false } = req.body;

  // Check if session already exists
  const existingSession = await dbService.getSession(sessionId);
  if (existingSession) {
    return res.status(400).json({
      success: false,
      error: 'Session already exists',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  // Create session
  const session = await whatsAppService.createSession(sessionId, req.user!.id, usePairingCode);

  // Fetch the created session from database to get complete data
  const dbSession = await dbService.getSession(sessionId);
  const liveSession = await whatsAppService.getSession(sessionId);

  // Combine database data with live status
  const sessionData = {
    id: dbSession?.id,
    sessionId: dbSession?.sessionId,
    phoneNumber: dbSession?.phoneNumber,
    name: dbSession?.name,
    status: dbSession?.status,
    isActive: dbSession?.isActive,
    metadata: dbSession?.metadata,
    createdAt: dbSession?.createdAt,
    updatedAt: dbSession?.updatedAt,
    liveStatus: liveSession?.status || SessionStatus.DISCONNECTED,
    qrCode: liveSession?.qrCode,
    pairingCode: liveSession?.pairingCode
  };

  res.status(201).json({
    success: true,
    data: sessionData,
    message: 'Session created successfully',
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

/**
 * @swagger
 * /api/sessions/{sessionId}:
 *   get:
 *     summary: Get session details
 *     tags: [Sessions]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Session details retrieved successfully
 *       404:
 *         description: Session not found
 */
router.get('/:sessionId', [
  param('sessionId').notEmpty().custom((value) => {
    if (!isValidSessionId(value)) throw new Error('Invalid session ID format');
    return true;
  })
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  
  const dbSession = await dbService.getSession(sessionId);
  const liveSession = await whatsAppService.getSession(sessionId);

  if (!dbSession) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  // Sanitize session data (exclude socket which has circular references)
  const sessionData = {
    id: dbSession.id,
    sessionId: dbSession.sessionId,
    phoneNumber: dbSession.phoneNumber,
    name: dbSession.name,
    status: dbSession.status,
    isActive: dbSession.isActive,
    metadata: dbSession.metadata,
    createdAt: dbSession.createdAt,
    updatedAt: dbSession.updatedAt,
    liveStatus: liveSession?.status || SessionStatus.DISCONNECTED,
    qrCode: liveSession?.qrCode,
    pairingCode: liveSession?.pairingCode
  };

  res.json({
    success: true,
    data: sessionData,
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

/**
 * @swagger
 * /api/sessions/{sessionId}:
 *   delete:
 *     summary: Delete a session
 *     tags: [Sessions]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Session deleted successfully
 *       404:
 *         description: Session not found
 */
router.delete('/:sessionId', [
  param('sessionId').notEmpty().custom((value) => {
    if (!isValidSessionId(value)) throw new Error('Invalid session ID format');
    return true;
  })
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;

  await whatsAppService.deleteSession(sessionId);

  res.json({
    success: true,
    message: 'Session deleted successfully',
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

/**
 * @swagger
 * /api/sessions/{sessionId}/qr:
 *   get:
 *     summary: Get QR code for session
 *     tags: [Sessions]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: QR code retrieved successfully
 *       404:
 *         description: Session not found or QR code not available
 */
router.get('/:sessionId/qr', [
  param('sessionId').notEmpty().custom((value) => {
    if (!isValidSessionId(value)) throw new Error('Invalid session ID format');
    return true;
  })
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  
  const session = await whatsAppService.getSession(sessionId);
  
  if (!session || !session.qrCode) {
    return res.status(404).json({
      success: false,
      error: 'QR code not available',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  res.json({
    success: true,
    data: {
      qrCode: session.qrCode,
      status: session.status
    },
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

/**
 * @swagger
 * /api/sessions/{sessionId}/refresh-qr:
 *   post:
 *     summary: Refresh QR code (after logout from phone)
 *     description: Request a new QR code for re-authentication (useful after user logs out from phone)
 *     tags: [Sessions]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: QR code refresh initiated
 *       404:
 *         description: Session not found
 */
router.post('/:sessionId/refresh-qr', [
  param('sessionId').notEmpty().custom((value) => {
    if (!isValidSessionId(value)) throw new Error('Invalid session ID format');
    return true;
  })
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;

  const session = await whatsAppService.getSession(sessionId);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  // Re-initialize connection to get new QR code
  await whatsAppService.refreshSessionQR(sessionId);

  res.json({
    success: true,
    message: 'QR code refresh initiated. Check /qr endpoint for new QR code',
    sessionId,
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));


/**
 * @swagger
 * /api/sessions/{sessionId}/pairing-code:
 *   post:
 *     summary: Request pairing code for session
 *     tags: [Sessions]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phoneNumber
 *             properties:
 *               phoneNumber:
 *                 type: string
 *                 description: Phone number in international format
 *     responses:
 *       200:
 *         description: Pairing code generated successfully
 *       400:
 *         description: Invalid phone number or session not ready
 */
router.post('/:sessionId/pairing-code', [
  param('sessionId').notEmpty().custom((value) => {
    if (!isValidSessionId(value)) throw new Error('Invalid session ID format');
    return true;
  }),
  body('phoneNumber').notEmpty().trim().custom((value) => {
    if (!isValidPhoneNumber(value)) throw new Error('Invalid international phone number format (7-15 digits)');
    return true;
  })
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { phoneNumber } = req.body;

  try {
    const pairingCode = await whatsAppService.requestPairingCode(sessionId, phoneNumber);

    res.json({
      success: true,
      data: {
        pairingCode,
        phoneNumber,
        sessionId
      },
      message: 'Pairing code generated successfully',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }
}));

/**
 * @swagger
 * /api/sessions/{sessionId}/status:
 *   get:
 *     summary: Get session connection status
 *     tags: [Sessions]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Session status retrieved successfully
 */
router.get('/:sessionId/status', [
  param('sessionId').notEmpty().custom((value) => {
    if (!isValidSessionId(value)) throw new Error('Invalid session ID format');
    return true;
  })
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  
  const session = await whatsAppService.getSession(sessionId);
  const dbSession = await dbService.getSession(sessionId);

  res.json({
    success: true,
    data: {
      sessionId,
      status: session?.status || SessionStatus.DISCONNECTED,
      phoneNumber: session?.phoneNumber || dbSession?.phoneNumber,
      name: session?.name || dbSession?.name,
      lastSeen: session?.lastSeen || dbSession?.lastSeen,
      isConnected: session?.status === SessionStatus.CONNECTED
    },
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

/**
 * @swagger
 * /api/sessions/{sessionId}/restart:
 *   post:
 *     summary: Restart a session
 *     tags: [Sessions]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Session restart initiated
 */
router.post('/:sessionId/restart', [
  param('sessionId').notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;

  // For restart scenario: permanently delete old session then create new one
  // This is intentional - only used when user explicitly requests restart
  try {
    await dbService.deleteSessionPermanently(sessionId);
    logger.info(`Permanently deleted session during restart: ${sessionId}`);
  } catch (error) {
    logger.warn(`Could not delete old session (may not exist): ${sessionId}`, error);
  }

  // Delete from memory as well
  await whatsAppService.deleteSession(sessionId);

  // Create fresh session
  const newSession = await whatsAppService.createSession(sessionId, req.user!.id);

  res.json({
    success: true,
    data: newSession,
    message: 'Session restart initiated',
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

/**
 * @swagger
 * /api/sessions/{sessionId}/sync:
 *   post:
 *     summary: Trigger comprehensive app state and message history sync
 *     description: Manually trigger full sync for a session (chat list, contacts, groups, message history)
 *     tags: [Sessions]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Session ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type:
 *                 type: string
 *                 enum: ['full', 'quick']
 *                 default: 'full'
 *                 description: Type of sync (full includes message history)
 *     responses:
 *       200:
 *         description: Sync initiated successfully
 */
router.post('/:sessionId/sync',
  param('sessionId').custom((value) => {
    if (!isValidSessionId(value)) throw new Error('Invalid session ID format');
    return true;
  }),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const { type = 'full' } = req.body;

    // Verify session exists and is connected
    const session = await whatsAppService.getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
        timestamp: new Date().toISOString()
      } as ApiResponse);
    }

    if (!session.socket) {
      return res.status(409).json({
        success: false,
        error: 'Session is not connected',
        timestamp: new Date().toISOString()
      } as ApiResponse);
    }

    // Trigger sync based on type
    let syncResult;
    if (type === 'quick') {
      syncResult = await SyncService.quickSync(session.socket, sessionId);
    } else {
      syncResult = await SyncService.fullySync(session.socket, sessionId);
    }

    res.json({
      success: syncResult.success,
      data: {
        sessionId: syncResult.sessionId,
        syncType: type,
        startTime: syncResult.startTime,
        endTime: syncResult.endTime,
        duration: syncResult.endTime 
          ? `${(syncResult.endTime.getTime() - syncResult.startTime.getTime()) / 1000}s`
          : null,
        steps: syncResult.steps.map(step => ({
          collection: step.collection,
          status: step.status,
          message: step.message,
          error: step.error,
          retryCount: step.retryCount
        }))
      },
      message: syncResult.success 
        ? `${type} sync completed successfully`
        : `${type} sync completed with errors`,
      error: syncResult.error,
      timestamp: new Date().toISOString()
    } as ApiResponse);
  })
);

/**
 * @swagger
 * /api/sessions/{sessionId}/sync/status:
 *   get:
 *     summary: Get last sync status
 *     tags: [Sessions]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Sync status retrieved
 */
router.get('/:sessionId/sync/status',
  param('sessionId').custom((value) => {
    if (!isValidSessionId(value)) throw new Error('Invalid session ID format');
    return true;
  }),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { sessionId } = req.params;

    const session = await whatsAppService.getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
        timestamp: new Date().toISOString()
      } as ApiResponse);
    }

    res.json({
      success: true,
      data: {
        sessionId,
        isConnected: !!session.socket,
        lastSeen: session.lastSeen,
        status: session.status
      },
      message: 'Sync status retrieved. Full sync automatically starts on connection.',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  })
);

export default router;
