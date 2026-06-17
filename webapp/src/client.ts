import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { Subject } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { MODEL_ID, SYSTEM_PROMPT, TOOL_SPECS, DEFAULT_INFERENCE_CONFIG, DEFAULT_AUDIO_CONFIG, INPUT_AUDIO_CONFIG } from './consts';
import { runTool } from './tools';

interface SessionData {
  queue: any[];
  queueSignal: Subject<void>;
  closeSignal: Subject<void>;
  responseSubject: Subject<any>;
  toolUseContent: any;
  toolUseId: string;
  toolName: string;
  responseHandlers: Map<string, (data: any) => void>;
  promptName: string;
  isActive: boolean;
  isPromptStartSent: boolean;
  isAudioContentStartSent: boolean;
  audioContentId: string;
}

export class StreamSession {
  constructor(
    private sessionId: string,
    private client: NovaSonicClient
  ) {}

  public onEvent(eventName: string, handler: (data: any) => void): void {
    this.client.registerHandler(this.sessionId, eventName, handler);
  }

  public async streamAudio(audioData: Buffer): Promise<void> {
    await this.client.streamAudioChunk(this.sessionId, audioData);
  }

  public async sendTextInput(text: string): Promise<void> {
    await this.client.sendTextInput(this.sessionId, text);
  }

  public async setupSystemPrompt(): Promise<void> {
    await this.client.sendSystemPrompt(this.sessionId, SYSTEM_PROMPT);
  }

  public async setupPromptStart(voiceId?: string): Promise<void> {
    await this.client.sendPromptStart(this.sessionId, voiceId);
  }

  public async setupStartAudio(): Promise<void> {
    await this.client.sendAudioContentStart(this.sessionId);
  }

  public async endAudioContent(): Promise<void> {
    await this.client.sendContentEnd(this.sessionId);
  }

  public async endPrompt(): Promise<void> {
    await this.client.sendPromptEnd(this.sessionId);
  }

  public async close(): Promise<void> {
    await this.client.closeSession(this.sessionId);
  }
}

export class NovaSonicClient {
  private bedrockClient: BedrockRuntimeClient;
  private activeSessions: Map<string, SessionData> = new Map();

  constructor() {
    const http2Handler = new NodeHttp2Handler({
      requestTimeout: 300000,
      sessionTimeout: 300000,
      disableConcurrentStreams: false,
      maxConcurrentStreams: 20,
    });

    this.bedrockClient = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: fromNodeProviderChain(),
      requestHandler: http2Handler,
    });
  }

  public createStreamSession(sessionId: string = uuidv4()): StreamSession {
    if (this.activeSessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const session: SessionData = {
      queue: [],
      queueSignal: new Subject<void>(),
      closeSignal: new Subject<void>(),
      responseSubject: new Subject<any>(),
      toolUseContent: null,
      toolUseId: '',
      toolName: '',
      responseHandlers: new Map(),
      promptName: uuidv4(),
      isActive: true,
      isPromptStartSent: false,
      isAudioContentStartSent: false,
      audioContentId: uuidv4(),
    };

    this.activeSessions.set(sessionId, session);
    return new StreamSession(sessionId, this);
  }

  public registerHandler(sessionId: string, eventName: string, handler: (data: any) => void): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.responseHandlers.set(eventName, handler);
    }
  }

  private dispatchEvent(sessionId: string, eventName: string, data: any): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      const handler = session.responseHandlers.get(eventName);
      if (handler) handler(data);
    }
  }

  private addEventToQueue(sessionId: string, event: any): void {
    const session = this.activeSessions.get(sessionId);
    if (session && session.isActive) {
      session.queue.push(event);
      session.queueSignal.next();
    }
  }

  private setupSessionStartEvent(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    this.addEventToQueue(sessionId, {
      event: {
        sessionStart: {
          inferenceConfiguration: DEFAULT_INFERENCE_CONFIG,
        },
      },
    });
  }

  public async sendSystemPrompt(sessionId: string, prompt: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const contentId = uuidv4();

    this.addEventToQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: contentId,
          type: 'TEXT',
          interactive: true,
          role: 'SYSTEM',
          textInputConfiguration: { mediaType: 'text/plain' },
        },
      },
    });

    this.addEventToQueue(sessionId, {
      event: {
        textInput: {
          promptName: session.promptName,
          contentName: contentId,
          content: prompt,
        },
      },
    });

    this.addEventToQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: contentId,
        },
      },
    });
  }

  public async sendPromptStart(sessionId: string, voiceId?: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || session.isPromptStartSent) return;

    const audioConfig = { ...DEFAULT_AUDIO_CONFIG };
    if (voiceId) audioConfig.voiceId = voiceId;

    this.addEventToQueue(sessionId, {
      event: {
        promptStart: {
          promptName: session.promptName,
          textOutputConfiguration: { mediaType: 'text/plain' },
          audioOutputConfiguration: audioConfig,
          toolUseOutputConfiguration: { mediaType: 'application/json' },
          toolConfiguration: {
            tools: TOOL_SPECS,
            toolChoice: { auto: {} },
          },
        },
      },
    });

    session.isPromptStartSent = true;
  }

  public async sendAudioContentStart(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || session.isAudioContentStartSent) return;

    this.addEventToQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: session.audioContentId,
          type: 'AUDIO',
          interactive: true,
          role: 'USER',
          audioInputConfiguration: INPUT_AUDIO_CONFIG,
        },
      },
    });

    session.isAudioContentStartSent = true;
  }

  public async streamAudioChunk(sessionId: string, audioData: Buffer): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive) return;

    this.addEventToQueue(sessionId, {
      event: {
        audioInput: {
          promptName: session.promptName,
          contentName: session.audioContentId,
          content: audioData.toString('base64'),
        },
      },
    });
  }

  public async sendTextInput(sessionId: string, text: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive) return;

    const contentId = uuidv4();

    this.addEventToQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: contentId,
          type: 'TEXT',
          interactive: true,
          role: 'USER',
          textInputConfiguration: { mediaType: 'text/plain' },
        },
      },
    });

    this.addEventToQueue(sessionId, {
      event: {
        textInput: {
          promptName: session.promptName,
          contentName: contentId,
          content: text,
        },
      },
    });

    this.addEventToQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: contentId,
        },
      },
    });
  }

  public async sendContentEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    this.addEventToQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: session.audioContentId,
        },
      },
    });
  }

  public async sendPromptEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    this.addEventToQueue(sessionId, {
      event: {
        promptEnd: {
          promptName: session.promptName,
        },
      },
    });
  }

  private async sendToolResult(sessionId: string, toolUseId: string, result: any): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive) return;

    const contentId = uuidv4();

    this.addEventToQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: contentId,
          interactive: false,
          type: 'TOOL',
          role: 'TOOL',
          toolResultInputConfiguration: {
            toolUseId: toolUseId,
            type: 'TEXT',
            textInputConfiguration: { mediaType: 'text/plain' },
          },
        },
      },
    });

    this.addEventToQueue(sessionId, {
      event: {
        textInput: {
          promptName: session.promptName,
          contentName: contentId,
          content: JSON.stringify(result),
        },
      },
    });

    this.addEventToQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: contentId,
        },
      },
    });
  }

  public async closeSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    session.isActive = false;
    session.queue = [];

    this.addEventToQueue(sessionId, {
      event: { sessionEnd: {} },
    });

    session.closeSignal.next();
    session.closeSignal.complete();

    setTimeout(() => {
      this.activeSessions.delete(sessionId);
    }, 1000);
  }

  public forceCloseSession(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.isActive = false;
      session.closeSignal.next();
      session.closeSignal.complete();
      this.activeSessions.delete(sessionId);
    }
  }

  public isSessionActive(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    return !!session && session.isActive;
  }

  public getActiveSessions(): string[] {
    return Array.from(this.activeSessions.keys());
  }

  private createSessionAsyncIterable(sessionId: string): AsyncIterable<any> {
    const session = this.activeSessions.get(sessionId)!;

    return {
      [Symbol.asyncIterator]: () => {
        return {
          next: async (): Promise<IteratorResult<any>> => {
            if (!session.isActive || !this.activeSessions.has(sessionId)) {
              return { value: undefined, done: true };
            }

            if (session.queue.length === 0) {
              try {
                await new Promise<void>((resolve, reject) => {
                  const queueSub = session.queueSignal.subscribe(() => {
                    queueSub.unsubscribe();
                    closeSub.unsubscribe();
                    resolve();
                  });
                  const closeSub = session.closeSignal.subscribe(() => {
                    queueSub.unsubscribe();
                    closeSub.unsubscribe();
                    reject(new Error('Stream closed'));
                  });
                });
              } catch {
                return { value: undefined, done: true };
              }
            }

            if (session.queue.length === 0 || !session.isActive) {
              return { value: undefined, done: true };
            }

            const nextEvent = session.queue.shift();

            if (!nextEvent.event?.audioInput) {
              console.log(`[Nova Sonic] Sending event: ${JSON.stringify(nextEvent).substring(0, 120)}...`);
            }

            return {
              value: {
                chunk: {
                  bytes: new TextEncoder().encode(JSON.stringify(nextEvent)),
                },
              },
              done: false,
            };
          },
          return: async (): Promise<IteratorResult<any>> => {
            session.isActive = false;
            return { value: undefined, done: true };
          },
          throw: async (error: any): Promise<IteratorResult<any>> => {
            session.isActive = false;
            throw error;
          },
        };
      },
    };
  }

  public queueSessionStart(sessionId: string): void {
    this.setupSessionStartEvent(sessionId);
  }

  public async initiateSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const asyncIterable = this.createSessionAsyncIterable(sessionId);

    try {
      console.log(`[Nova Sonic] Starting bidirectional stream for session ${sessionId}`);

      const response = await this.bedrockClient.send(
        new InvokeModelWithBidirectionalStreamCommand({
          modelId: MODEL_ID,
          body: asyncIterable as any,
        })
      );

      if (!response.body) {
        throw new Error('No response body from Bedrock');
      }

      for await (const event of response.body) {
        if (!session.isActive) break;

        if (event.chunk?.bytes) {
          try {
            const textResponse = new TextDecoder().decode(event.chunk.bytes);
            const jsonResponse = JSON.parse(textResponse);

            if (jsonResponse.event?.contentStart) {
              this.dispatchEvent(sessionId, 'contentStart', jsonResponse.event.contentStart);
            } else if (jsonResponse.event?.textOutput) {
              this.dispatchEvent(sessionId, 'textOutput', jsonResponse.event.textOutput);
            } else if (jsonResponse.event?.audioOutput) {
              this.dispatchEvent(sessionId, 'audioOutput', jsonResponse.event.audioOutput);
            } else if (jsonResponse.event?.toolUse) {
              console.log(`[Nova Sonic] Tool use: ${jsonResponse.event.toolUse.toolName}`);
              this.dispatchEvent(sessionId, 'toolUse', jsonResponse.event.toolUse);
              session.toolUseContent = jsonResponse.event.toolUse;
              session.toolUseId = jsonResponse.event.toolUse.toolUseId;
              session.toolName = jsonResponse.event.toolUse.toolName;
            } else if (
              jsonResponse.event?.contentEnd &&
              jsonResponse.event?.contentEnd?.type === 'TOOL'
            ) {
              console.log(`[Nova Sonic] Processing tool: ${session.toolName}`);
              this.dispatchEvent(sessionId, 'toolEnd', {
                toolName: session.toolName,
                toolUseId: session.toolUseId,
              });

              const toolResult = await runTool(session.toolName, session.toolUseContent.content);

              await this.sendToolResult(sessionId, session.toolUseId, toolResult);

              this.dispatchEvent(sessionId, 'toolResult', {
                toolUseId: session.toolUseId,
                toolName: session.toolName,
                result: toolResult,
              });
            } else if (jsonResponse.event?.contentEnd) {
              this.dispatchEvent(sessionId, 'contentEnd', jsonResponse.event.contentEnd);
            } else if (jsonResponse.event?.completionEnd) {
              this.dispatchEvent(sessionId, 'completionEnd', jsonResponse.event.completionEnd);
            }
          } catch (parseErr) {
            // Ignore parse errors for non-JSON chunks
          }
        }
      }

      console.log(`[Nova Sonic] Stream completed for session ${sessionId}`);
      this.dispatchEvent(sessionId, 'streamComplete', {});
    } catch (err: any) {
      console.error(`[Nova Sonic] Stream error for session ${sessionId}:`, err.message);
      this.dispatchEvent(sessionId, 'error', { message: err.message });
    }
  }
}
