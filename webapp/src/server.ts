import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { v4 as uuidv4 } from 'uuid';
import { NovaSonicClient } from './client';
import { BRANDING, SUGGESTIONS, IMAGE_ANALYSIS_PROMPT } from './config';
import { IMAGE_MODEL_ID } from './consts';

const app = express();
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e7,
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const PHOTOS_BUCKET = process.env.PHOTOS_BUCKET || '';
const region = process.env.AWS_REGION || 'us-east-1';
const s3Client = new S3Client({ region });
const bedrockClient = new BedrockRuntimeClient({ region });

const novaSonicClient = new NovaSonicClient();

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', activeSessions: novaSonicClient.getActiveSessions().length });
});

// Branding config — lets the frontend render without hardcoded values
app.get('/api/config', (_req, res) => {
  res.json({
    branding: BRANDING,
    suggestions: SUGGESTIONS,
    photoEnabled: !!PHOTOS_BUCKET,
  });
});

// Presigned URL for photo upload (only if a bucket is configured)
app.post('/api/upload-url', async (req, res) => {
  if (!PHOTOS_BUCKET) {
    res.status(400).json({ error: 'Photo upload not configured' });
    return;
  }
  try {
    const { fileName, contentType } = req.body;
    const key = `uploads/${uuidv4()}/${fileName || 'photo.jpg'}`;
    const putCmd = new PutObjectCommand({
      Bucket: PHOTOS_BUCKET,
      Key: key,
      ContentType: contentType || 'image/jpeg',
    });
    const uploadUrl = await getSignedUrl(s3Client, putCmd, { expiresIn: 300 });
    res.json({ uploadUrl, fileKey: key });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Analyze an uploaded photo with a multimodal model
app.post('/api/analyze-photo', async (req, res) => {
  if (!PHOTOS_BUCKET) {
    res.status(400).json({ error: 'Photo analysis not configured' });
    return;
  }
  try {
    const { fileKey, contentType } = req.body;
    console.log(`[Server] Analyzing photo: ${fileKey}`);

    const getCmd = new GetObjectCommand({ Bucket: PHOTOS_BUCKET, Key: fileKey });
    const s3Response = await s3Client.send(getCmd);
    const imageBytes = await s3Response.Body?.transformToByteArray();

    if (!imageBytes) {
      res.status(400).json({ error: 'Could not read image from S3' });
      return;
    }

    const base64Image = Buffer.from(imageBytes).toString('base64');
    const mediaType = contentType || 'image/jpeg';

    const invokeCmd = new InvokeModelCommand({
      modelId: IMAGE_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              { image: { format: mediaType.split('/')[1] || 'jpeg', source: { bytes: base64Image } } },
              { text: IMAGE_ANALYSIS_PROMPT },
            ],
          },
        ],
        inferenceConfig: { maxTokens: 300, temperature: 0.7 },
      }),
    });

    const response = await bedrockClient.send(invokeCmd);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const analysis =
      responseBody.output?.message?.content?.[0]?.text ||
      responseBody.content?.[0]?.text ||
      'Could not analyze the image.';

    console.log(`[Server] Photo analysis: ${analysis}`);
    res.json({ analysis, fileKey });
  } catch (err: any) {
    console.error('[Server] Photo analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

io.on('connection', (socket) => {
  console.log(`[Server] Client connected: ${socket.id}`);
  const sessionId = socket.id;

  socket.on('sessionStart', async () => {
    console.log(`[Server] Session start: ${sessionId}`);

    try {
      const session = novaSonicClient.createStreamSession(sessionId);

      session.onEvent('contentStart', (data) => socket.emit('contentStart', data));
      session.onEvent('textOutput', (data) => socket.emit('textOutput', data));
      session.onEvent('audioOutput', (data) => socket.emit('audioOutput', data));
      session.onEvent('toolUse', (data) => {
        console.log(`[Server] Tool use: ${data.toolName}`);
        socket.emit('toolUse', data);
      });
      session.onEvent('toolResult', (data) => socket.emit('toolResult', data));
      session.onEvent('toolEnd', (data) => socket.emit('toolEnd', data));
      session.onEvent('contentEnd', (data) => socket.emit('contentEnd', data));
      session.onEvent('completionEnd', (data) => socket.emit('completionEnd', data));
      session.onEvent('error', (data) => {
        console.error('[Server] Session error:', data);
        socket.emit('error', data);
      });
      session.onEvent('streamComplete', () => socket.emit('streamComplete'));

      // Setup events in exact order BEFORE starting the stream
      novaSonicClient.queueSessionStart(sessionId);
      await session.setupPromptStart();
      await session.setupSystemPrompt();
      await session.setupStartAudio();

      novaSonicClient.initiateSession(sessionId);

      socket.emit('sessionReady');

      // Keep the stream alive with silence frames (Nova times out after 55s)
      const SILENCE_FRAME = Buffer.alloc(320, 0);
      const silenceInterval = setInterval(async () => {
        if (novaSonicClient.isSessionActive(sessionId)) {
          try {
            await session.streamAudio(SILENCE_FRAME);
          } catch {
            // session may have closed
          }
        } else {
          clearInterval(silenceInterval);
        }
      }, 200);

      socket.on('audioInput', async (audioData: string) => {
        try {
          const audioBuffer = typeof audioData === 'string' ? Buffer.from(audioData, 'base64') : Buffer.from(audioData);
          await session.streamAudio(audioBuffer);
        } catch (err: any) {
          console.error('[Server] Audio input error:', err.message);
        }
      });

      socket.on('textInput', async (text: string) => {
        try {
          console.log(`[Server] Text input: ${text}`);
          await session.sendTextInput(text);
        } catch (err: any) {
          console.error('[Server] Text input error:', err.message);
        }
      });

      socket.on('stopAudio', async () => {
        try {
          clearInterval(silenceInterval);
          await session.endAudioContent();
          await session.endPrompt();
          await session.close();
        } catch (err: any) {
          console.error('[Server] Stop audio error:', err.message);
        }
      });

      socket.on('disconnect', async () => {
        console.log(`[Server] Client disconnected: ${socket.id}`);
        clearInterval(silenceInterval);
        if (novaSonicClient.isSessionActive(sessionId)) {
          try {
            await Promise.race([
              (async () => {
                await session.endAudioContent();
                await session.endPrompt();
                await session.close();
              })(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Cleanup timeout')), 3000)),
            ]);
          } catch {
            novaSonicClient.forceCloseSession(sessionId);
          }
        }
      });
    } catch (err: any) {
      console.error('[Server] Session start error:', err.message);
      socket.emit('error', { message: err.message });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ============================================
   ${BRANDING.assistantName} — Voice AI Assistant
   Powered by Amazon Nova 2 Sonic
  --------------------------------------------
   Server running on http://localhost:${PORT}
  ============================================
  `);
});

const shutdown = async () => {
  console.log('[Server] Shutting down...');
  const sessions = novaSonicClient.getActiveSessions();
  await Promise.all(sessions.map((id) => novaSonicClient.closeSession(id).catch(() => {})));
  io.close();
  server.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
