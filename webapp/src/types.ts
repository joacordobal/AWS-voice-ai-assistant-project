export interface InferenceConfig {
  maxTokens: number;
  topP: number;
  temperature: number;
}

export interface AudioConfig {
  mediaType: string;
  sampleRateHertz: number;
  sampleSizeBits: number;
  channelCount: number;
  voiceId: string;
  encoding: string;
  audioType: string;
}

export interface ToolSpec {
  toolSpec: {
    name: string;
    description: string;
    inputSchema: {
      json: string | object;
    };
  };
}
