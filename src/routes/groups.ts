import { Router } from 'express';
import { param, body } from 'express-validator';
import { handleValidationErrors, asyncHandler } from '../middleware/errorHandler';
import { sessionMiddleware } from '../middleware/auth';
import { whatsAppService } from '../app';
import { DatabaseService } from '../services/DatabaseService';
import { ApiResponse } from '../Types/api';
import { isValidSessionId, isValidGroupName, isValidGroupDescription, isValidParticipants } from '../Utils/validation';

const router = Router();
const dbService = new DatabaseService();

/**
 * @swagger
 * /api/groups/{sessionId}:
 *   get:
 *     summary: Get all groups for a session (from database)
 *     tags: [Groups]
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
 *         description: Groups retrieved successfully
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

  try {
    // Get groups from database (auto-synced by WhatsApp events)
    const groups = await dbService.getGroups(sessionId);

    // Format response with explicit groupId field for clarity
    const formattedGroups = groups.map(group => ({
      id: group.id,                    // Internal database ID
      groupId: group.jid,               // WhatsApp Group ID (explicit)
      jid: group.jid,                   // WhatsApp Group ID (alias)
      subject: group.subject,           // Group name
      description: group.description,   // Group description  
      owner: group.owner,               // Group owner JID
      participantCount: Array.isArray(group.participants) ? group.participants.length : 0,
      participants: group.participants, // Full participant list
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      metadata: group.metadata          // Additional metadata from WhatsApp
    }));

    res.json({
      success: true,
      data: formattedGroups,
      count: formattedGroups.length,
      message: 'Groups retrieved successfully from database',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Handle session not found
    if (errorMessage.includes('Session not found')) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
        timestamp: new Date().toISOString()
      } as ApiResponse);
    }

    res.status(400).json({
      success: false,
      error: errorMessage,
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }
}));

/**
 * @swagger
 * /api/groups/{sessionId}/create:
 *   post:
 *     summary: Create a new group
 *     tags: [Groups]
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
 *               - subject
 *               - participants
 *             properties:
 *               subject:
 *                 type: string
 *               participants:
 *                 type: array
 *                 items:
 *                   type: string
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Group created successfully
 */
router.post('/:sessionId/create', [
  param('sessionId').notEmpty().custom((value) => {
    if (!isValidSessionId(value)) throw new Error('Invalid session ID format');
    return true;
  }),
  body('subject').notEmpty().trim().custom((value) => {
    if (!isValidGroupName(value)) throw new Error('Group name must be 1-100 characters');
    return true;
  }),
  body('participants').isArray({ min: 1 }).withMessage('Participants must be a non-empty array').custom((value) => {
    if (!isValidParticipants(value)) throw new Error('Invalid participant JID or phone number format');
    return true;
  }),
  body('description').optional().trim().custom((value) => {
    if (value && !isValidGroupDescription(value)) throw new Error('Group description must not exceed 500 characters');
    return true;
  })
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { subject, participants, description } = req.body;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    const group = await session.socket.groupCreate(subject, participants);
    
    // Set description if provided
    if (description) {
      await session.socket.groupUpdateDescription(group.id, description);
    }

    res.json({
      success: true,
      data: group,
      message: 'Group created successfully',
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
 * /api/groups/{sessionId}/{groupId}/metadata:
 *   get:
 *     summary: Get group metadata
 *     tags: [Groups]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Group metadata retrieved successfully
 */
router.get('/:sessionId/:groupId/metadata', [
  param('sessionId').notEmpty(),
  param('groupId').notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, groupId } = req.params;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    const metadata = await session.socket.groupMetadata(groupId);

    res.json({
      success: true,
      data: metadata,
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
 * /api/groups/{sessionId}/{groupId}/participants/add:
 *   post:
 *     summary: Add participants to group
 *     tags: [Groups]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: groupId
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
 *               - participants
 *             properties:
 *               participants:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Participants added successfully
 */
router.post('/:sessionId/:groupId/participants/add', [
  param('sessionId').notEmpty(),
  param('groupId').notEmpty(),
  body('participants').isArray({ min: 1 }),
  body('participants.*').isString().notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, groupId } = req.params;
  const { participants } = req.body;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    const result = await session.socket.groupParticipantsUpdate(groupId, participants, 'add');

    res.json({
      success: true,
      data: result,
      message: 'Participants added successfully',
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
 * /api/groups/{sessionId}/{groupId}/participants/remove:
 *   post:
 *     summary: Remove participants from group
 *     tags: [Groups]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: groupId
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
 *               - participants
 *             properties:
 *               participants:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Participants removed successfully
 */
router.post('/:sessionId/:groupId/participants/remove', [
  param('sessionId').notEmpty(),
  param('groupId').notEmpty(),
  body('participants').isArray({ min: 1 }),
  body('participants.*').isString().notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, groupId } = req.params;
  const { participants } = req.body;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    const result = await session.socket.groupParticipantsUpdate(groupId, participants, 'remove');

    res.json({
      success: true,
      data: result,
      message: 'Participants removed successfully',
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
 * /api/groups/{sessionId}/{groupId}/participants/promote:
 *   post:
 *     summary: Promote participants to admin
 *     tags: [Groups]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: groupId
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
 *               - participants
 *             properties:
 *               participants:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Participants promoted successfully
 */
router.post('/:sessionId/:groupId/participants/promote', [
  param('sessionId').notEmpty(),
  param('groupId').notEmpty(),
  body('participants').isArray({ min: 1 }),
  body('participants.*').isString().notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, groupId } = req.params;
  const { participants } = req.body;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    const result = await session.socket.groupParticipantsUpdate(groupId, participants, 'promote');

    res.json({
      success: true,
      data: result,
      message: 'Participants promoted successfully',
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
 * /api/groups/{sessionId}/{groupId}/participants/demote:
 *   post:
 *     summary: Demote participants from admin
 *     tags: [Groups]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: groupId
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
 *               - participants
 *             properties:
 *               participants:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Participants demoted successfully
 */
router.post('/:sessionId/:groupId/participants/demote', [
  param('sessionId').notEmpty(),
  param('groupId').notEmpty(),
  body('participants').isArray({ min: 1 }),
  body('participants.*').isString().notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, groupId } = req.params;
  const { participants } = req.body;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    const result = await session.socket.groupParticipantsUpdate(groupId, participants, 'demote');

    res.json({
      success: true,
      data: result,
      message: 'Participants demoted successfully',
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
 * /api/groups/{sessionId}/{groupId}/subject:
 *   put:
 *     summary: Update group subject
 *     tags: [Groups]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: groupId
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
 *               - subject
 *             properties:
 *               subject:
 *                 type: string
 *     responses:
 *       200:
 *         description: Group subject updated successfully
 */
router.put('/:sessionId/:groupId/subject', [
  param('sessionId').notEmpty(),
  param('groupId').notEmpty(),
  body('subject').notEmpty().trim().isLength({ min: 1, max: 100 })
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, groupId } = req.params;
  const { subject } = req.body;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    await session.socket.groupUpdateSubject(groupId, subject);

    res.json({
      success: true,
      message: 'Group subject updated successfully',
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
 * /api/groups/{sessionId}/{groupId}/description:
 *   put:
 *     summary: Update group description
 *     tags: [Groups]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Group description updated successfully
 */
router.put('/:sessionId/:groupId/description', [
  param('sessionId').notEmpty(),
  param('groupId').notEmpty(),
  body('description').optional().trim().isLength({ max: 500 })
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, groupId } = req.params;
  const { description } = req.body;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    await session.socket.groupUpdateDescription(groupId, description);

    res.json({
      success: true,
      message: 'Group description updated successfully',
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
 * /api/groups/{sessionId}/{groupId}/leave:
 *   post:
 *     summary: Leave a group
 *     tags: [Groups]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Left group successfully
 */
router.post('/:sessionId/:groupId/leave', [
  param('sessionId').notEmpty(),
  param('groupId').notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, groupId } = req.params;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    await session.socket.groupLeave(groupId);

    res.json({
      success: true,
      message: 'Left group successfully',
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
