/**
 * Input validation utilities for WhatsApp API
 * Validates JID formats, phone numbers, and message content
 */

// JID format validation patterns
// User JID: 6285196101059@s.whatsapp.net or 6285196101059@c.us
// Group JID: 120363082025326771@g.us
// Broadcast JID: 120363082025326771@broadcast  
// LID (new format): 132109570154604@lid
const JID_PATTERNS = {
  user: /^(\d+)@s\.whatsapp\.net$|^(\d+)@c\.us$/,
  group: /^(\d+)@g\.us$/,
  broadcast: /^(\d+)@broadcast$/,
  lid: /^(\d+)@lid$/,
  any: /^(\d+)@(s\.whatsapp\.net|c\.us|g\.us|broadcast|lid)$/
};

/**
 * Validate JID format
 * @param jid The JID to validate
 * @param type Optional: specific type to validate against (user, group, broadcast, lid, any)
 * @returns true if valid, false otherwise
 */
export function isValidJid(jid: string, type: 'user' | 'group' | 'broadcast' | 'lid' | 'any' = 'any'): boolean {
  if (!jid || typeof jid !== 'string') {
    return false;
  }

  const pattern = JID_PATTERNS[type];
  if (!pattern) {
    return false;
  }

  return pattern.test(jid);
}

/**
 * Validate phone number format (international format, digits only)
 * @param phone Phone number to validate (e.g., 6285196101059)
 * @returns true if valid, false otherwise
 */
export function isValidPhoneNumber(phone: string): boolean {
  if (!phone || typeof phone !== 'string') {
    return false;
  }

  // Remove common formatting characters
  const cleaned = phone.replace(/[\s\-\+\(\)]/g, '');

  // Must be 7-15 digits (ITU-T E.164)
  return /^\d{7,15}$/.test(cleaned);
}

/**
 * Convert phone number to user JID
 * @param phone Phone number (e.g., 6285196101059)
 * @returns User JID (e.g., 6285196101059@s.whatsapp.net)
 */
export function phoneToJid(phone: string): string {
  const cleaned = phone.replace(/[\s\-\+\(\)]/g, '');
  if (!isValidPhoneNumber(cleaned)) {
    throw new Error(`Invalid phone number: ${phone}`);
  }
  return `${cleaned}@s.whatsapp.net`;
}

/**
 * Extract phone number from user JID
 * @param jid JID to extract from (e.g., 6285196101059@s.whatsapp.net)
 * @returns Phone number or null if not a user JID
 */
export function jidToPhone(jid: string): string | null {
  const match = jid.match(/^(\d+)@(s\.whatsapp\.net|c\.us)$/);
  return match ? match[1] : null;
}

/**
 * Validate message text content
 * @param text Text to validate
 * @param maxLength Maximum allowed length (default: 4096)
 * @returns true if valid, false otherwise
 */
export function isValidMessageText(text: string, maxLength: number = 4096): boolean {
  if (typeof text !== 'string') {
    return false;
  }

  const trimmed = text.trim();

  // Must not be empty and not exceed max length
  return trimmed.length > 0 && trimmed.length <= maxLength;
}

/**
 * Validate group name/subject
 * @param subject Group subject to validate
 * @param maxLength Maximum allowed length (default: 100)
 * @returns true if valid, false otherwise
 */
export function isValidGroupName(subject: string, maxLength: number = 100): boolean {
  if (typeof subject !== 'string') {
    return false;
  }

  const trimmed = subject.trim();

  // Must not be empty and not exceed max length
  return trimmed.length > 0 && trimmed.length <= maxLength;
}

/**
 * Validate group description
 * @param description Group description to validate
 * @param maxLength Maximum allowed length (default: 500)
 * @returns true if valid, false otherwise
 */
export function isValidGroupDescription(description: string, maxLength: number = 500): boolean {
  if (typeof description !== 'string') {
    return false;
  }

  const trimmed = description.trim();

  // Can be empty but not exceed max length
  return trimmed.length <= maxLength;
}

/**
 * Validate session ID format (CUID or custom string)
 * @param sessionId Session ID to validate
 * @returns true if valid, false otherwise
 */
export function isValidSessionId(sessionId: string): boolean {
  if (!sessionId || typeof sessionId !== 'string') {
    return false;
  }

  // Session IDs should be alphanumeric and reasonable length
  // Allow CUID format (25+ chars) and custom session names (3-50 chars)
  return /^[a-zA-Z0-9_-]{3,100}$/.test(sessionId);
}

/**
 * Validate array of JIDs
 * @param jids Array of JIDs to validate
 * @param type Optional: specific JID type to validate
 * @returns true if all JIDs are valid, false otherwise
 */
export function isValidJidArray(jids: any, type: 'user' | 'group' | 'broadcast' | 'lid' | 'any' = 'any'): boolean {
  if (!Array.isArray(jids) || jids.length === 0) {
    return false;
  }

  return jids.every(jid => isValidJid(jid, type));
}

/**
 * Validate array of participants for group creation
 * A participant should be a valid JID
 * @param participants Array of participant JIDs
 * @returns true if all participants are valid, false otherwise
 */
export function isValidParticipants(participants: any): boolean {
  if (!Array.isArray(participants) || participants.length === 0) {
    return false;
  }

  // Participants must be valid user JIDs
  return participants.every(p => {
    // Accept both JID format and phone number format
    return isValidJid(p, 'user') || isValidPhoneNumber(p);
  });
}

/**
 * Validate mention array (should be JIDs)
 * @param mentions Array of mention JIDs
 * @returns true if all mentions are valid or array is empty, false otherwise
 */
export function isValidMentions(mentions: any): boolean {
  if (!mentions) {
    return true;
  }

  if (!Array.isArray(mentions)) {
    return false;
  }

  return mentions.every(mention => isValidJid(mention));
}

/**
 * Sanitize text input (remove potentially harmful characters)
 * @param text Text to sanitize
 * @returns Sanitized text
 */
export function sanitizeText(text: string): string {
  if (typeof text !== 'string') {
    return '';
  }

  return text
    .replace(/\0/g, '') // Remove null bytes
    .trim();
}

/**
 * Validate webhook URL
 * @param url URL to validate
 * @returns true if valid, false otherwise
 */
export function isValidWebhookUrl(url: string): boolean {
  if (!url || typeof url !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(url);
    // Only allow http and https
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate API key format
 * @param key API key to validate
 * @returns true if valid, false otherwise
 */
export function isValidApiKey(key: string): boolean {
  if (!key || typeof key !== 'string') {
    return false;
  }

  // API keys should be alphanumeric and at least 20 chars
  return /^[a-zA-Z0-9_-]{20,}$/.test(key);
}
