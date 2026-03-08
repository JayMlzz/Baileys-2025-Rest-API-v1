import { Router } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import multer from 'multer';
import { handleValidationErrors, asyncHandler } from '../middleware/errorHandler';
import { sessionMiddleware } from '../middleware/auth';
import { whatsAppService } from '../app';
import { DatabaseService } from '../services/DatabaseService';
import { ApiResponse, SendMessageRequest, MessageType } from '../Types/api';
import { downloadContentFromMessage } from '../Utils/messages-media';
import { isValidJid, isValidSessionId, isValidMessageText, isValidMentions } from '../Utils/validation';

const router = Router();
const dbService = new DatabaseService();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || '50') * 1024 * 1024, // 50MB default
    files: 1
  },
  fileFilter: (req, file, cb) => {
    // Allow common media types
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/mpeg', 'video/quicktime',
      'audio/mpeg', 'audio/wav', 'audio/ogg',
      'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('File type not supported'));
    }
  }
});

/**
 * @swagger
 * /api/messages/{sessionId}:
 *   get:
 *     summary: Get messages for a session
 *     tags: [Messages]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: chatId
 *         schema:
 *           type: string
 *         description: Filter by specific chat
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: Messages retrieved successfully
 */
router.get('/:sessionId', [
  param('sessionId').notEmpty(),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('offset').optional().isInt({ min: 0 })
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { chatId, limit = 50, offset = 0 } = req.query;

  const messages = await dbService.getMessages(
    sessionId,
    chatId as string,
    parseInt(limit as string),
    parseInt(offset as string)
  );

  res.json({
    success: true,
    data: messages,
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

/**
 * @swagger
 * /api/messages/{sessionId}/send:
 *   post:
 *     summary: Send a text message
 *     tags: [Messages]
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
 *               - to
 *               - content
 *             properties:
 *               to:
 *                 type: string
 *                 description: Recipient JID
 *               content:
 *                 type: object
 *                 properties:
 *                   text:
 *                     type: string
 *               options:
 *                 type: object
 *                 properties:
 *                   quoted:
 *                     type: string
 *                   mentions:
 *                     type: array
 *                     items:
 *                       type: string
 *     responses:
 *       200:
 *         description: Message sent successfully
 */
router.post('/:sessionId/send', [
  param('sessionId').notEmpty().custom((value) => {
    if (!isValidSessionId(value)) throw new Error('Invalid session ID format');
    return true;
  }),
  body('to').notEmpty().trim().custom((value) => {
    if (!isValidJid(value)) throw new Error('Invalid recipient JID format');
    return true;
  }),
  body('content.text').notEmpty().trim().custom((value) => {
    if (!isValidMessageText(value)) throw new Error('Message text must not exceed 4096 characters');
    return true;
  }),
  body('options.quoted').optional().isString(),
  body('options.mentions').optional().custom((value) => {
    if (value && !isValidMentions(value)) throw new Error('Invalid mention JID format');
    return true;
  })
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { to, content, options = {} } = req.body;

  try {
    const messageContent: any = { text: content.text };
    
    if (options.quoted) {
      messageContent.quoted = options.quoted;
    }
    
    if (options.mentions && options.mentions.length > 0) {
      messageContent.mentions = options.mentions;
    }

    const result = await whatsAppService.sendMessage(sessionId, to, messageContent);

    res.json({
      success: true,
      data: result,
      message: 'Message sent successfully',
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
 * /api/messages/{sessionId}/send-media:
 *   post:
 *     summary: Send a media message
 *     tags: [Messages]
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
 *               - to
 *               - file
 *             properties:
 *               to:
 *                 type: string
 *               file:
 *                 type: string
 *                 format: binary
 *               caption:
 *                 type: string
 *               fileName:
 *                 type: string
 *     responses:
 *       200:
 *         description: Media message sent successfully
 */
router.post('/:sessionId/send-media', upload.single('file'), [
  param('sessionId').notEmpty().custom((value) => {
    if (!isValidSessionId(value)) throw new Error('Invalid session ID format');
    return true;
  }),
  body('to').notEmpty().trim().custom((value) => {
    if (!isValidJid(value)) throw new Error('Invalid recipient JID format');
    return true;
  }),
  body('caption').optional().trim().custom((value) => {
    if (value && !isValidMessageText(value, 1024)) throw new Error('Caption must not exceed 1024 characters');
    return true;
  }),
  body('fileName').optional().trim()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { to, caption, fileName } = req.body;
  const file = req.file;

  if (!file) {
    return res.status(400).json({
      success: false,
      error: 'No file uploaded',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    let messageContent: any;
    const mediaBuffer = file.buffer;
    const mimetype = file.mimetype;

    if (mimetype.startsWith('image/')) {
      messageContent = {
        image: mediaBuffer,
        caption,
        fileName: fileName || file.originalname
      };
    } else if (mimetype.startsWith('video/')) {
      messageContent = {
        video: mediaBuffer,
        caption,
        fileName: fileName || file.originalname
      };
    } else if (mimetype.startsWith('audio/')) {
      messageContent = {
        audio: mediaBuffer,
        fileName: fileName || file.originalname,
        mimetype
      };
    } else {
      messageContent = {
        document: mediaBuffer,
        fileName: fileName || file.originalname,
        mimetype
      };
    }

    const result = await whatsAppService.sendMessage(sessionId, to, messageContent);

    res.json({
      success: true,
      data: result,
      message: 'Media message sent successfully',
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
 * /api/messages/{sessionId}/send-location:
 *   post:
 *     summary: Send a location message
 *     tags: [Messages]
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
 *               - to
 *               - latitude
 *               - longitude
 *             properties:
 *               to:
 *                 type: string
 *               latitude:
 *                 type: number
 *               longitude:
 *                 type: number
 *               name:
 *                 type: string
 *               address:
 *                 type: string
 *     responses:
 *       200:
 *         description: Location message sent successfully
 */
router.post('/:sessionId/send-location', [
  param('sessionId').notEmpty().custom((value) => {
    if (!isValidSessionId(value)) throw new Error('Invalid session ID format');
    return true;
  }),
  body('to').notEmpty().trim().custom((value) => {
    if (!isValidJid(value)) throw new Error('Invalid recipient JID format');
    return true;
  }),
  body('latitude').isFloat({ min: -90, max: 90 }).withMessage('Latitude must be between -90 and 90'),
  body('longitude').isFloat({ min: -180, max: 180 }).withMessage('Longitude must be between -180 and 180'),
  body('name').optional().trim().isLength({ max: 100 }).withMessage('Location name must not exceed 100 characters'),
  body('address').optional().trim().isLength({ max: 256 }).withMessage('Location address must not exceed 256 characters')
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { to, latitude, longitude, name, address } = req.body;

  try {
    const messageContent = {
      location: {
        degreesLatitude: latitude,
        degreesLongitude: longitude,
        name,
        address
      }
    };

    const result = await whatsAppService.sendMessage(sessionId, to, messageContent);

    res.json({
      success: true,
      data: result,
      message: 'Location message sent successfully',
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
 * /api/messages/{sessionId}/send-reaction:
 *   post:
 *     summary: Send a reaction to a message
 *     tags: [Messages]
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
 *               - to
 *               - messageId
 *               - emoji
 *             properties:
 *               to:
 *                 type: string
 *               messageId:
 *                 type: string
 *               emoji:
 *                 type: string
 *     responses:
 *       200:
 *         description: Reaction sent successfully
 */
router.post('/:sessionId/send-reaction', [
  param('sessionId').notEmpty().custom((value) => {
    if (!isValidSessionId(value)) throw new Error('Invalid session ID format');
    return true;
  }),
  body('to').notEmpty().trim().custom((value) => {
    if (!isValidJid(value)) throw new Error('Invalid recipient JID format');
    return true;
  }),
  body('messageId').notEmpty().trim().isLength({ min: 1, max: 100 }).withMessage('Invalid message ID'),
  body('emoji').notEmpty().trim().isLength({ min: 1, max: 10 }).withMessage('Emoji must be 1-10 characters')
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { to, messageId, emoji } = req.body;

  try {
    const messageContent = {
      react: {
        text: emoji,
        key: {
          remoteJid: to,
          id: messageId
        }
      }
    };

    const result = await whatsAppService.sendMessage(sessionId, to, messageContent);

    res.json({
      success: true,
      data: result,
      message: 'Reaction sent successfully',
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
 * /api/messages/{sessionId}/typing:
 *   post:
 *     summary: Send typing indicator
 *     tags: [Messages]
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
 *               - chatId
 *               - isTyping
 *             properties:
 *               chatId:
 *                 type: string
 *               isTyping:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       200:
 *         description: Typing indicator sent successfully
 */
router.post('/:sessionId/typing', [
  param('sessionId').notEmpty().custom((value) => {
    if (!isValidSessionId(value)) throw new Error('Invalid session ID format');
    return true;
  }),
  body('chatId').notEmpty().trim().custom((value) => {
    if (!isValidJid(value)) throw new Error('Invalid chat JID format');
    return true;
  }),
  body('isTyping').optional().isBoolean().withMessage('isTyping must be a boolean')
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { chatId, isTyping = true } = req.body;

  try {
    await whatsAppService.sendTypingIndicator(sessionId, chatId, isTyping);

    res.json({
      success: true,
      message: isTyping ? 'Typing indicator started' : 'Typing indicator stopped',
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
 * /api/messages/{sessionId}/mark-read:
 *   post:
 *     summary: Mark chat as read
 *     tags: [Messages]
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
 *               - chatId
 *             properties:
 *               chatId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Chat marked as read
 */
router.post('/:sessionId/mark-read', [
  param('sessionId').notEmpty().custom((value) => {
    if (!isValidSessionId(value)) throw new Error('Invalid session ID format');
    return true;
  }),
  body('chatId').notEmpty().trim().custom((value) => {
    if (!isValidJid(value)) throw new Error('Invalid chat JID format');
    return true;
  })
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { chatId } = req.body;

  try {
    await whatsAppService.markChatAsRead(sessionId, chatId);

    res.json({
      success: true,
      message: 'Chat marked as read',
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
 * /api/messages/{sessionId}/delete:
 *   post:
 *     summary: Delete a message
 *     tags: [Messages]
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
 *               - chatId
 *               - messageId
 *             properties:
 *               chatId:
 *                 type: string
 *               messageId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Message deleted successfully
 */
router.post('/:sessionId/delete', [
  param('sessionId').notEmpty().custom((value) => {
    if (!isValidSessionId(value)) throw new Error('Invalid session ID format');
    return true;
  }),
  body('chatId').notEmpty().trim().custom((value) => {
    if (!isValidJid(value)) throw new Error('Invalid chat JID format');
    return true;
  }),
  body('messageId').notEmpty().trim().isLength({ min: 1, max: 100 }).withMessage('Invalid message ID')
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { chatId, messageId } = req.body;

  try {
    // Create message key for deletion
    const key = {
      remoteJid: chatId,
      id: messageId,
      fromMe: true
    };

    await whatsAppService.deleteMessage(sessionId, chatId, key);
    
    // Also delete from database
    await dbService.deleteMessage(messageId, sessionId);

    res.json({
      success: true,
      message: 'Message deleted successfully',
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
 * /api/messages/{sessionId}/edit:
 *   post:
 *     summary: Edit a message
 *     tags: [Messages]
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
 *               - chatId
 *               - messageId
 *               - newText
 *             properties:
 *               chatId:
 *                 type: string
 *               messageId:
 *                 type: string
 *               newText:
 *                 type: string
 *     responses:
 *       200:
 *         description: Message edited successfully
 */
router.post('/:sessionId/edit', [
  param('sessionId').notEmpty().custom((value) => {
    if (!isValidSessionId(value)) throw new Error('Invalid session ID format');
    return true;
  }),
  body('chatId').notEmpty().trim().custom((value) => {
    if (!isValidJid(value)) throw new Error('Invalid chat JID format');
    return true;
  }),
  body('messageId').notEmpty().trim().isLength({ min: 1, max: 100 }).withMessage('Invalid message ID'),
  body('newText').notEmpty().trim().isLength({ min: 1, max: 4096 }).withMessage('Message text must be 1-4096 characters')
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { chatId, messageId, newText } = req.body;

  try {
    // Create message key for editing
    const key = {
      remoteJid: chatId,
      id: messageId,
      fromMe: true
    };

    await whatsAppService.editMessage(sessionId, chatId, key, newText);

    res.json({
      success: true,
      message: 'Message edited successfully',
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

export default router;
