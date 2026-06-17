const { ConnectClient, StartOutboundVoiceContactCommand } = require('@aws-sdk/client-connect');

const connect = new ConnectClient({ region: process.env.AWS_REGION || 'us-east-1' });

/**
 * Amazon Connect outbound-call Lambda.
 *
 * Triggered by the voice assistant's `escalate_call` tool to place an
 * outbound call that connects a frontline worker with a supervisor.
 *
 * Configure your Connect instance details via environment variables:
 *   CONTACT_FLOW_ID, INSTANCE_ID, QUEUE_ID, SOURCE_PHONE_NUMBER
 *
 * The destination phone number is passed dynamically from the assistant.
 */
exports.handler = async (event) => {
  console.log('Event received:', JSON.stringify(event));

  const data = event.data || event;

  const params = {
    ContactFlowId: data.contactFlowId || process.env.CONTACT_FLOW_ID,
    DestinationPhoneNumber: data.destinationPhone || process.env.DEFAULT_DESTINATION_PHONE,
    InstanceId: data.instanceId || process.env.INSTANCE_ID,
    QueueId: data.queueId || process.env.QUEUE_ID,
    SourcePhoneNumber: data.sourcePhone || process.env.SOURCE_PHONE_NUMBER,
    Attributes: {
      escalationReason: data.reason || 'Escalation from Voice Assistant',
      urgency: data.urgency || 'normal',
      escalationId: data.escalationId || 'N/A',
    },
  };

  console.log('Initiating outbound call with params:', JSON.stringify(params));

  try {
    const result = await connect.send(new StartOutboundVoiceContactCommand(params));
    console.log('Call initiated successfully:', JSON.stringify(result));
    return { statusCode: 200, contactId: result.ContactId, message: 'Escalation call initiated successfully' };
  } catch (err) {
    console.error('Error initiating call:', err);
    return { statusCode: 500, error: err.message, message: 'Error initiating the escalation call' };
  }
};
