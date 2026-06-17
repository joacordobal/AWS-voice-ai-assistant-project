// ========================================
// Voice AI Assistant - Frontend
// ========================================

const socket = io({ transports: ['polling', 'websocket'] });

let isRecording = false, isConnected = false, isSessionActive = false;
let audioContext = null, mediaStream = null, scriptProcessor = null;
let audioQueue = [], isPlaying = false, playbackContext = null;
let currentAssistantEl = null, assistantTextBuffer = '', currentRole = null;
let photoEnabled = false;

const $ = (id) => document.getElementById(id);
const menuBtn = $('menuBtn'), sidebarOverlay = $('sidebarOverlay'), sidebarPanel = $('sidebarPanel');
const newConvBtn = $('newConvBtn'), attachPhotoBtn = $('attachPhotoBtn'), photoNavBtn = $('photoNavBtn');
const fileInput = $('fileInput'), statusDot = $('statusDot'), chatArea = $('chatArea');
const welcome = $('welcome'), messagesEl = $('messages'), textInput = $('textInput');
const sendBtn = $('sendBtn'), micInlineBtn = $('micInlineBtn'), fabMic = $('fabMic'), fabLabel = $('fabLabel');

// ========================================
// LOAD BRANDING CONFIG
// ========================================
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    const b = cfg.branding || {};

    // Apply colors
    if (b.brandColor) document.documentElement.style.setProperty('--brand', b.brandColor);
    if (b.accentColor) document.documentElement.style.setProperty('--accent', b.accentColor);

    // Apply text
    $('brandIcon').textContent = b.brandShort || 'AI';
    $('sidebarBrandIcon').textContent = b.brandShort || 'AI';
    $('brandName').textContent = b.brandName || 'ACME';
    $('sidebarBrandName').textContent = b.brandName || 'ACME';
    $('brandSub').textContent = b.assistantName || 'Assistant';
    $('greeting').textContent = b.greeting || 'Hi there! 👋';
    $('greetingSub').textContent = b.greetingSubtitle || 'How can I help you today?';
    $('voiceLabel').textContent = b.voiceLabel || '—';
    document.title = (b.brandName ? b.brandName + ' ' : '') + (b.assistantName || 'Voice Assistant');

    photoEnabled = cfg.photoEnabled;
    if (!photoEnabled) {
      photoNavBtn.style.display = 'none';
      attachPhotoBtn.style.display = 'none';
    }

    // Render suggestions
    const sug = cfg.suggestions || [];
    $('suggestions').innerHTML = sug.map((s) =>
      `<button class="sugg-card" data-text="${escapeAttr(s.title)}">
        <div class="sugg-icon">${s.icon}</div>
        <div><div class="sugg-title">${escapeHtml(s.title)}</div><div class="sugg-desc">${escapeHtml(s.desc)}</div></div>
      </button>`
    ).join('');
    document.querySelectorAll('.sugg-card').forEach((card) => {
      card.addEventListener('click', () => {
        if (!isSessionActive) return;
        addUserMsg(card.dataset.text);
        socket.emit('textInput', card.dataset.text);
      });
    });
  } catch (err) {
    console.error('Config load error:', err);
  }
}
loadConfig();

// ========================================
// SIDEBAR
// ========================================
menuBtn.addEventListener('click', () => { sidebarOverlay.classList.remove('hidden'); sidebarPanel.classList.remove('hidden'); });
function closeSidebar() { sidebarOverlay.classList.add('hidden'); sidebarPanel.classList.add('hidden'); }
sidebarOverlay.addEventListener('click', closeSidebar);
newConvBtn.addEventListener('click', () => { closeSidebar(); resetConversation(); });
attachPhotoBtn.addEventListener('click', () => { closeSidebar(); fileInput.click(); });
photoNavBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  welcome.classList.add('hidden');
  const reader = new FileReader();
  reader.onload = (ev) => addImagePreview(ev.target.result);
  reader.readAsDataURL(file);
  addSystemMsg('📷 Uploading photo...');
  try {
    const res = await fetch('/api/upload-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileName: file.name, contentType: file.type }) });
    const { uploadUrl, fileKey } = await res.json();
    await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
    addSystemMsg('🔍 Analyzing image...');
    const analysisRes = await fetch('/api/analyze-photo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileKey, contentType: file.type }) });
    const { analysis } = await analysisRes.json();
    if (analysis) {
      addSystemMsg('✅ Image analyzed');
      socket.emit('textInput', 'The user just uploaded a photo. The image analysis shows: ' + analysis + '. Briefly respond about what you see and suggest what to do.');
    } else {
      addSystemMsg('⚠️ Could not analyze the image');
    }
  } catch (err) {
    console.error('Photo error:', err);
    addSystemMsg('❌ Error processing photo');
  }
  fileInput.value = '';
});

// ========================================
// TEXT INPUT
// ========================================
textInput.addEventListener('input', () => {
  const hasText = textInput.value.trim().length > 0;
  sendBtn.style.display = hasText ? 'flex' : 'none';
  micInlineBtn.style.display = hasText ? 'none' : 'flex';
});
textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && textInput.value.trim()) sendText(); });
sendBtn.addEventListener('click', sendText);

function sendText() {
  const text = textInput.value.trim();
  if (!text || !isSessionActive) return;
  addUserMsg(text);
  socket.emit('textInput', text);
  textInput.value = '';
  sendBtn.style.display = 'none';
  micInlineBtn.style.display = 'flex';
}

// ========================================
// SOCKET.IO
// ========================================
socket.on('connect', () => { isConnected = true; statusDot.classList.add('connected'); startSession(); });
socket.on('disconnect', () => { isConnected = false; isSessionActive = false; statusDot.classList.remove('connected'); });
socket.on('sessionReady', () => { isSessionActive = true; fabLabel.textContent = 'Talk'; });

socket.on('contentStart', (data) => {
  currentRole = data.role || null;
  let generationStage = null;
  if (data.additionalModelFields) {
    try {
      const fields = typeof data.additionalModelFields === 'string' ? JSON.parse(data.additionalModelFields) : data.additionalModelFields;
      generationStage = fields.generationStage || null;
    } catch {}
  }
  // Show SPECULATIVE (real-time) text from assistant; skip the FINAL duplicate
  if (generationStage === 'FINAL' && data.role === 'ASSISTANT') { currentRole = 'FINAL_SKIP'; return; }
  if (data.role === 'USER') { currentAssistantEl = null; assistantTextBuffer = ''; }
  if (data.role === 'ASSISTANT' && data.type === 'TEXT') {
    if (!currentAssistantEl) { currentAssistantEl = addAssistantMsg(); assistantTextBuffer = ''; }
  }
});

socket.on('textOutput', (data) => {
  const content = data.content || '';
  if (!content || content.trim() === '') return;
  const trimmed = content.trim();
  if (trimmed === '{ "interrupted" : true }' || trimmed === '{"interrupted":true}') return;
  if (currentRole === 'FINAL_SKIP') return;
  if (currentRole === 'USER') { addUserMsg(content); return; }
  if (!currentAssistantEl) { currentAssistantEl = addAssistantMsg(); assistantTextBuffer = ''; }
  assistantTextBuffer += content;
  typeText(currentAssistantEl, assistantTextBuffer);
});

socket.on('audioOutput', (data) => { if (data.content) { audioQueue.push(data.content); if (!isPlaying) playAudioQueue(); } });

socket.on('contentEnd', (data) => {
  if (data.stopReason === 'INTERRUPTED') { audioQueue = []; isPlaying = false; }
  if (data.type !== 'AUDIO') {
    if (currentAssistantEl) { const c = currentAssistantEl.querySelector('.msg-cursor'); if (c) c.remove(); }
    currentAssistantEl = null;
  }
  currentRole = null;
});

socket.on('toolUse', (data) => {
  const labels = {
    search_knowledge_base: '🔍 Searching knowledge base…',
    lookup_contact: '👤 Looking up contact…',
    create_ticket: '📝 Creating ticket…',
    escalate_call: '📞 Connecting with a supervisor…',
  };
  addToolPill(labels[data.toolName] || '⚙️ ' + data.toolName + '…');
});

socket.on('toolResult', () => {
  document.querySelectorAll('.tool-spinner').forEach((s) => { s.style.animation = 'none'; s.style.borderColor = 'rgba(245,158,11,.4)'; s.style.borderTopColor = 'rgba(245,158,11,.4)'; });
});

socket.on('error', (data) => { console.error('Session error:', data); addSystemMsg('⚠️ ' + (data.message || 'Connection error')); });
socket.on('streamComplete', () => { isSessionActive = false; });

// ========================================
// SESSION
// ========================================
function startSession() { socket.emit('sessionStart'); fabLabel.textContent = 'Connecting…'; }

function resetConversation() {
  if (isRecording) stopRecording();
  audioQueue = []; isPlaying = false;
  if (isSessionActive) { socket.emit('stopAudio'); isSessionActive = false; }
  messagesEl.innerHTML = '';
  welcome.classList.remove('hidden');
  currentAssistantEl = null; assistantTextBuffer = ''; currentRole = null;
  fabLabel.textContent = 'Connecting…';
  setTimeout(() => { if (isConnected) startSession(); }, 1000);
}

// ========================================
// RECORDING
// ========================================
fabMic.addEventListener('click', toggleRecording);
micInlineBtn.addEventListener('click', toggleRecording);
function toggleRecording() { if (!isSessionActive) return; if (isRecording) stopRecording(); else startRecording(); }

async function startRecording() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(mediaStream);
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    scriptProcessor.onaudioprocess = (e) => {
      if (!isRecording) return;
      const input = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) { const s = Math.max(-1, Math.min(1, input[i])); int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
      socket.emit('audioInput', arrayBufferToBase64(int16.buffer));
    };
    source.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);
    isRecording = true;
    welcome.classList.add('hidden');
    fabMic.classList.remove('idle'); fabMic.classList.add('recording');
    fabLabel.textContent = 'Listening…'; fabLabel.style.color = 'var(--accent)';
    micInlineBtn.classList.add('active');
  } catch (err) { console.error('Mic error:', err); addSystemMsg('⚠️ Could not access microphone'); }
}

function stopRecording() {
  isRecording = false;
  fabMic.classList.remove('recording'); fabMic.classList.add('idle');
  fabLabel.textContent = 'Talk'; fabLabel.style.color = '';
  micInlineBtn.classList.remove('active');
  if (scriptProcessor) { scriptProcessor.disconnect(); scriptProcessor = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
}

// ========================================
// AUDIO PLAYBACK
// ========================================
async function playAudioQueue() {
  if (isPlaying || audioQueue.length === 0) return;
  isPlaying = true;
  if (!playbackContext) playbackContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  while (audioQueue.length > 0) {
    const b64 = audioQueue.shift();
    try {
      const bytes = base64ToArrayBuffer(b64);
      const int16 = new Int16Array(bytes);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;
      const buf = playbackContext.createBuffer(1, float32.length, 24000);
      buf.getChannelData(0).set(float32);
      const src = playbackContext.createBufferSource();
      src.buffer = buf; src.connect(playbackContext.destination); src.start();
      await new Promise((r) => { src.onended = r; setTimeout(r, (float32.length / 24000) * 1000 + 50); });
    } catch (err) { console.error('Playback error:', err); }
  }
  isPlaying = false;
}

// ========================================
// UI HELPERS
// ========================================
function addUserMsg(text) {
  welcome.classList.add('hidden');
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = '<div class="msg-bubble">' + escapeHtml(text) + '</div>';
  messagesEl.appendChild(div); scrollToBottom();
}
function addAssistantMsg() {
  welcome.classList.add('hidden');
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.innerHTML = '<div class="msg-avatar">' + ($('brandIcon').textContent || 'AI') + '</div><div class="msg-bubble"><span class="msg-text"></span><span class="msg-cursor"></span></div>';
  messagesEl.appendChild(div); scrollToBottom();
  return div;
}
function typeText(el, fullText) {
  if (!el) return;
  const t = el.querySelector('.msg-text');
  if (t) t.innerHTML = escapeHtml(fullText).replace(/\n/g, '<br>');
  scrollToBottom();
}
function addToolPill(label) {
  const div = document.createElement('div');
  div.className = 'tool-pill';
  div.innerHTML = '<div class="tool-pill-inner"><div class="tool-spinner"></div>' + escapeHtml(label) + '</div>';
  messagesEl.appendChild(div); scrollToBottom();
}
function addSystemMsg(text) {
  welcome.classList.add('hidden');
  const div = document.createElement('div');
  div.style.cssText = 'text-align:center;padding:8px 16px;font-size:12px;color:var(--muted);animation:fadeIn .3s ease';
  div.textContent = text;
  messagesEl.appendChild(div); scrollToBottom();
}
function addImagePreview(dataUrl) {
  welcome.classList.add('hidden');
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = '<div class="msg-bubble" style="padding:6px;background:var(--brand)"><img src="' + dataUrl + '" style="max-width:200px;max-height:200px;border-radius:12px;display:block" /></div>';
  messagesEl.appendChild(div); scrollToBottom();
}
function scrollToBottom() { chatArea.scrollTop = chatArea.scrollHeight; }
function escapeHtml(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }
function escapeAttr(text) { return (text || '').replace(/"/g, '&quot;'); }
function arrayBufferToBase64(buffer) { const bytes = new Uint8Array(buffer); let b = ''; for (let i = 0; i < bytes.byteLength; i++) b += String.fromCharCode(bytes[i]); return btoa(b); }
function base64ToArrayBuffer(base64) { const bin = atob(base64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return bytes.buffer; }
