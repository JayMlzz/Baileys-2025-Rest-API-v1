import { Router } from 'express';
import { param, query } from 'express-validator';
import { handleValidationErrors, asyncHandler } from '../middleware/errorHandler';
import { sessionMiddleware } from '../middleware/auth';
import { whatsAppService } from '../app';
import { DatabaseService } from '../services/DatabaseService';
import { ApiResponse } from '../Types/api';
import { downloadContentFromMessage } from '../Utils/messages-media';

const router = Router();
const dbService = new DatabaseService();

/**
 * @swagger
 * /api/media/{sessionId}/download/{messageId}:
 *   get:
 *     summary: Download media from a message
 *     tags: [Media]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Media downloaded successfully
 *         content:
 *           application/octet-stream:
 *             schema:
 *               type: string
 *               format: binary
 */
router.get('/:sessionId/download/:messageId', [
  param('sessionId').notEmpty(),
  param('messageId').notEmpty(),
  query('type').optional().isIn(['image', 'video', 'audio', 'document'])
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, messageId } = req.params;
  const { type } = req.query;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    // Get message from database
    const message = await dbService.getMessageByMessageId(messageId, sessionId);
    
    if (!message) {
      return res.status(404).json({
        success: false,
        error: 'Message not found',
        timestamp: new Date().toISOString()
      } as ApiResponse);
    }

    // Extract media from message content
    const content = (message.content as any) || {};
    let mediaMessage: any = null;
    let mediaType: any = type || message.messageType;

    // Find media in the message
    if (content.imageMessage) {
      mediaMessage = content.imageMessage;
      mediaType = 'image';
    } else if (content.videoMessage) {
      mediaMessage = content.videoMessage;
      mediaType = 'video';
    } else if (content.audioMessage) {
      mediaMessage = content.audioMessage;
      mediaType = 'audio';
    } else if (content.documentMessage) {
      mediaMessage = content.documentMessage;
      mediaType = 'document';
    }

    if (!mediaMessage) {
      return res.status(404).json({
        success: false,
        error: 'No media found in this message',
        timestamp: new Date().toISOString()
      } as ApiResponse);
    }

    // Download media using Baileys utility
    const buffer = await downloadContentFromMessage(mediaMessage, mediaType);
    
    // Set appropriate headers
    const fileName = mediaMessage.fileName || `media_${messageId}`;
    const mimeType = mediaMessage.mimetype || 'application/octet-stream';
    
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    
    // Handle both Buffer and Stream responses
    if (buffer && typeof buffer === 'object') {
      if ('pipe' in buffer) {
        // It's a stream, pipe it to response
        (buffer as any).pipe(res);
      } else if (Buffer.isBuffer(buffer)) {
        // It's a Buffer
        res.setHeader('Content-Length', (buffer as Buffer).length);
        res.send(buffer);
      } else {
        // Unknown type, try to send it directly
        res.send(buffer);
      }
    } else {
      res.send(buffer);
    }
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
 * /api/media/{sessionId}/upload-status:
 *   post:
 *     summary: Upload status/story to WhatsApp
 *     tags: [Media]
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
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               caption:
 *                 type: string
 *     responses:
 *       200:
 *         description: Status uploaded successfully
 */
router.post('/:sessionId/upload-status', asyncHandler(async (req, res) => {
  return res.status(501).json({
    success: false,
    error: 'Status upload not yet implemented',
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

export default router;
