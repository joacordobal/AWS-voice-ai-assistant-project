import { ToolSpec } from './types';
import { SYSTEM_PROMPT, BRANDING } from './config';

export { SYSTEM_PROMPT };

// Nova 2 Sonic model ID for speech-to-speech
export const MODEL_ID = process.env.SONIC_MODEL_ID || 'amazon.nova-2-sonic-v1:0';

// Multimodal model used for image analysis
export const IMAGE_MODEL_ID = process.env.IMAGE_MODEL_ID || 'amazon.nova-lite-v1:0';

// ── Tool input schemas (Nova Sonic requires stringified JSON, not objects) ──

const searchKnowledgeBaseSchema = JSON.stringify({
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'The search query based on the problem the user described',
    },
  },
  required: ['query'],
});

const lookupContactSchema = JSON.stringify({
  type: 'object',
  properties: {
    phone: {
      type: 'string',
      description: 'The user phone number on file, including country code. Example: +15551234567',
    },
  },
  required: ['phone'],
});

const createTicketSchema = JSON.stringify({
  type: 'object',
  properties: {
    subject: { type: 'string', description: 'Brief ticket title' },
    description: {
      type: 'string',
      description: 'Detailed description of the issue including conversation context',
    },
    category: {
      type: 'string',
      description: 'Ticket category (e.g. equipment, returns, inventory, safety, other)',
    },
    priority: {
      type: 'string',
      enum: ['low', 'medium', 'high', 'critical'],
      description: 'Ticket priority',
    },
    contactId: {
      type: 'string',
      description: 'The CRM contact ID obtained from lookup_contact. REQUIRED before creating the ticket.',
    },
  },
  required: ['subject', 'description', 'category', 'priority', 'contactId'],
});

const escalateCallSchema = JSON.stringify({
  type: 'object',
  properties: {
    reason: { type: 'string', description: 'Reason for the escalation with problem context' },
    urgency: {
      type: 'string',
      enum: ['normal', 'urgent'],
      description: 'Escalation urgency level',
    },
    destinationPhone: {
      type: 'string',
      description: 'Phone number to call to connect the user with a supervisor. Ask the user which number to call. Format with country code, e.g. +15551234567',
    },
  },
  required: ['reason', 'urgency', 'destinationPhone'],
});

export const TOOL_SPECS: ToolSpec[] = [
  {
    toolSpec: {
      name: 'search_knowledge_base',
      description:
        'Searches the knowledge base for procedures, operating manuals, policies, and troubleshooting guides. Use this whenever the user describes a problem or needs instructions on how to proceed.',
      inputSchema: { json: searchKnowledgeBaseSchema },
    },
  },
  {
    toolSpec: {
      name: 'create_ticket',
      description:
        'Creates a support ticket/case in the CRM. BEFORE using this, you MUST use lookup_contact to get the contactId. If you do not have the contactId, ask the user for their phone number on file and use lookup_contact first.',
      inputSchema: { json: createTicketSchema },
    },
  },
  {
    toolSpec: {
      name: 'lookup_contact',
      description:
        'Looks up a contact in the CRM by phone number. Use this BEFORE creating a ticket to obtain the contactId. Ask the user for the phone number on file.',
      inputSchema: { json: lookupContactSchema },
    },
  },
  {
    toolSpec: {
      name: 'escalate_call',
      description:
        'Triggers a PHONE CALL to connect the user with a supervisor via Amazon Connect. Use this when the user wants to talk to someone, needs a supervisor, asks to be called, or the problem cannot be resolved with procedures. ALWAYS ask which number to call before using this. This is NOT a CRM ticket — it is a real phone call.',
      inputSchema: { json: escalateCallSchema },
    },
  },
];

export const DEFAULT_INFERENCE_CONFIG = {
  maxTokens: 1024,
  topP: 0.9,
  temperature: 0.7,
};

export const DEFAULT_AUDIO_CONFIG = {
  mediaType: 'audio/lpcm',
  sampleRateHertz: 24000,
  sampleSizeBits: 16,
  channelCount: 1,
  voiceId: BRANDING.voiceId,
  encoding: 'base64',
  audioType: 'SPEECH',
};

export const INPUT_AUDIO_CONFIG = {
  mediaType: 'audio/lpcm',
  sampleRateHertz: 16000,
  sampleSizeBits: 16,
  channelCount: 1,
  encoding: 'base64',
  audioType: 'SPEECH',
};
