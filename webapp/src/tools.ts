import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { v4 as uuidv4 } from 'uuid';
import { BRANDING } from './config';

const region = process.env.AWS_REGION || 'us-east-1';
const kbClient = new BedrockAgentRuntimeClient({ region });
const lambdaClient = new LambdaClient({ region });
const snsClient = new SNSClient({ region });

const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID || '';
// Optional CRM integration Lambda (e.g. Salesforce CTI Adapter). Leave empty to run in demo mode.
const CRM_LAMBDA_ARN = process.env.CRM_LAMBDA_ARN || '';
// Optional Amazon Connect outbound-call Lambda. Leave empty to run in demo mode.
const CONNECT_CALLBACK_LAMBDA_ARN = process.env.CONNECT_CALLBACK_LAMBDA_ARN || '';
const ESCALATION_TOPIC_ARN = process.env.ESCALATION_TOPIC_ARN || '';

const isConfigured = (arn: string) => arn && !arn.includes('PLACEHOLDER');

// ========================================
// TOOL: search_knowledge_base  (Bedrock Knowledge Base RAG)
// ========================================
async function searchKnowledgeBase(params: { query: string }): Promise<object> {
  console.log(`[Tool] search_knowledge_base: "${params.query}"`);

  if (!KNOWLEDGE_BASE_ID) {
    return { status: 'error', message: 'Knowledge Base not configured', results: [] };
  }

  try {
    const response = await kbClient.send(
      new RetrieveCommand({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        retrievalQuery: { text: params.query },
        retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 3 } },
      })
    );

    const results = (response.retrievalResults || []).map((r) => ({
      content: r.content?.text || '',
      source: r.location?.s3Location?.uri || 'N/A',
    }));

    console.log(`[Tool] search_knowledge_base: ${results.length} results found`);
    return { status: 'success', query: params.query, results, resultCount: results.length };
  } catch (err: any) {
    console.error('[Tool] search_knowledge_base error:', err.message);
    return { status: 'error', message: err.message, results: [] };
  }
}

// ========================================
// TOOL: lookup_contact  (CRM contact lookup by phone)
// ========================================
async function lookupContact(params: { phone: string }): Promise<object> {
  console.log(`[Tool] lookup_contact: "${params.phone}"`);

  // Demo mode — returns a fake contact when no CRM is wired up
  if (!isConfigured(CRM_LAMBDA_ARN)) {
    return {
      status: 'success',
      contactId: 'DEMO_CONTACT_001',
      name: 'Demo User',
      phone: params.phone,
      message: 'Contact found (demo mode)',
    };
  }

  try {
    // Example payload format for a Salesforce CTI Adapter Lambda.
    // Adapt this to match your own CRM integration.
    const payload = {
      Details: {
        Parameters: {
          sf_operation: 'phoneLookup',
          sf_phone: params.phone,
          sf_fields: 'Id, Name, Phone, MobilePhone',
        },
      },
    };

    const response = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: CRM_LAMBDA_ARN,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(payload)),
      })
    );

    const result = JSON.parse(new TextDecoder().decode(response.Payload));
    console.log('[Tool] lookup_contact result:', JSON.stringify(result));

    if (result.sf_count && result.sf_count > 0) {
      return {
        status: 'success',
        contactId: result.Id,
        name: result.Name || 'N/A',
        phone: params.phone,
        message: `Contact found: ${result.Name || 'N/A'}`,
      };
    }
    return {
      status: 'not_found',
      contactId: null,
      phone: params.phone,
      message: 'No contact found with that phone number.',
    };
  } catch (err: any) {
    console.error('[Tool] lookup_contact error:', err.message);
    return { status: 'error', message: `Error looking up contact: ${err.message}` };
  }
}

// ========================================
// TOOL: create_ticket  (CRM case creation)
// ========================================
async function createTicket(params: {
  subject: string;
  description: string;
  category: string;
  priority: string;
  contactId: string;
}): Promise<object> {
  const ticketId = `TKT-${uuidv4().substring(0, 8).toUpperCase()}`;
  console.log(`[Tool] create_ticket: ${ticketId} - ${params.subject}`);

  if (!isConfigured(CRM_LAMBDA_ARN)) {
    return {
      status: 'success',
      ticketId,
      message: `Ticket ${ticketId} created successfully (demo mode)`,
      details: { subject: params.subject, category: params.category, priority: params.priority },
    };
  }

  try {
    const priorityMap: Record<string, string> = {
      critical: 'High',
      high: 'High',
      medium: 'Medium',
      low: 'Low',
    };

    // Example payload for a Salesforce CTI Adapter Lambda. Adapt to your CRM.
    const payload = {
      Details: {
        Parameters: {
          sf_operation: 'create',
          sf_object: 'Case',
          Subject: params.subject,
          Description: params.description,
          Priority: priorityMap[params.priority] || 'Medium',
          Status: 'New',
          Origin: `${BRANDING.assistantName} (Voice AI)`,
          Type: params.category,
          ContactId: params.contactId,
        },
      },
    };

    const response = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: CRM_LAMBDA_ARN,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(payload)),
      })
    );

    const result = JSON.parse(new TextDecoder().decode(response.Payload));
    return {
      status: 'success',
      ticketId: result.Id || ticketId,
      message: 'Ticket created successfully in CRM',
      crmId: result.Id,
    };
  } catch (err: any) {
    console.error('[Tool] create_ticket error:', err.message);
    return { status: 'error', ticketId, message: `Error creating ticket: ${err.message}` };
  }
}

// ========================================
// TOOL: escalate_call  (Amazon Connect outbound call)
// ========================================
async function escalateCall(params: {
  reason: string;
  urgency: string;
  destinationPhone: string;
}): Promise<object> {
  const escalationId = `ESC-${uuidv4().substring(0, 8).toUpperCase()}`;
  console.log(`[Tool] escalate_call: ${escalationId} - ${params.urgency}`);

  // Optional SNS notification to supervisors
  if (isConfigured(ESCALATION_TOPIC_ARN)) {
    try {
      await snsClient.send(
        new PublishCommand({
          TopicArn: ESCALATION_TOPIC_ARN,
          Subject: `${BRANDING.assistantName} - Escalation ${params.urgency.toUpperCase()}`,
          Message: JSON.stringify(
            { escalationId, reason: params.reason, urgency: params.urgency, timestamp: new Date().toISOString() },
            null,
            2
          ),
        })
      );
    } catch (err: any) {
      console.error('[Tool] escalate_call SNS error:', err.message);
    }
  }

  if (!isConfigured(CONNECT_CALLBACK_LAMBDA_ARN)) {
    return {
      status: 'success',
      escalationId,
      message: 'Escalation registered. A supervisor will be in contact (demo mode)',
      estimatedWait: '5-10 minutes',
    };
  }

  try {
    const payload = {
      data: {
        escalationId,
        reason: params.reason,
        urgency: params.urgency,
        destinationPhone: params.destinationPhone,
      },
    };

    const response = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: CONNECT_CALLBACK_LAMBDA_ARN,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(payload)),
      })
    );

    const result = JSON.parse(new TextDecoder().decode(response.Payload));
    return {
      status: 'success',
      escalationId,
      message: 'Escalation initiated. Connecting with a supervisor via Amazon Connect',
      details: result,
    };
  } catch (err: any) {
    console.error('[Tool] escalate_call error:', err.message);
    return { status: 'error', escalationId, message: `Escalation error: ${err.message}` };
  }
}

// ========================================
// TOOL DISPATCHER
// ========================================
const TOOL_HANDLERS: Record<string, (params: any) => Promise<object>> = {
  search_knowledge_base: searchKnowledgeBase,
  lookup_contact: lookupContact,
  create_ticket: createTicket,
  escalate_call: escalateCall,
};

export async function runTool(toolName: string, input: string): Promise<object> {
  const handler = TOOL_HANDLERS[toolName.toLowerCase()];
  if (!handler) {
    console.error(`[Tool] Unknown tool: ${toolName}`);
    return { error: `Tool ${toolName} not found` };
  }

  try {
    const params = JSON.parse(input);
    return await handler(params);
  } catch (err: any) {
    console.error(`[Tool] Error running ${toolName}:`, err.message);
    return { error: `Error executing tool: ${err.message}` };
  }
}
