const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-002:generateContent?key=${process.env.GEMINI_API_KEY}`;

// In-memory storage for audio (Vercel serverless - resets between calls)
// For production, use Vercel KV or similar
const audioCache = new Map();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true });
  }

  try {
    const update = req.body;

    // Handle voice message
    if (update.message?.voice) {
      await handleVoiceMessage(update.message);
    }

    // Handle callback (button press)
    if (update.callback_query) {
      await handleCallback(update.callback_query);
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error:', error);
    res.status(200).json({ ok: true }); // Always return 200 to Telegram
  }
}

async function handleVoiceMessage(message) {
  const chatId = message.chat.id;
  const fileId = message.voice.file_id;

  // Send "processing" message
  const processingMsg = await sendMessage(chatId, '⏳ Обрабатываю голосовое...');

  try {
    // Get file path from Telegram
    const fileInfo = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const fileData = await fileInfo.json();
    const filePath = fileData.result.file_path;

    // Download audio file
    const audioResponse = await fetch(
      `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${filePath}`
    );
    const audioBuffer = await audioResponse.arrayBuffer();
    const base64Audio = Buffer.from(audioBuffer).toString('base64');

    // Get transcription from Gemini
    const transcription = await getTranscription(base64Audio);

    if (!transcription) {
      await editMessage(chatId, processingMsg.result.message_id, '❌ Не удалось распознать речь');
      return;
    }

    // Get formatted note
    const note = await formatAsNote(transcription);

    // Delete processing message
    await deleteMessage(chatId, processingMsg.result.message_id);

    // Send both results
    const response = `📝 *Транскрипция:*\n${escapeMarkdown(transcription)}\n\n` +
      `━━━━━━━━━━━━━━━\n\n` +
      `📋 *Заметка:*\n${escapeMarkdown(note)}`;

    await sendMessage(chatId, response, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('Voice processing error:', error);
    await editMessage(chatId, processingMsg.result.message_id, '❌ Ошибка обработки: ' + error.message);
  }
}

async function getTranscription(base64Audio) {
  const response = await fetch(GEMINI_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          {
            inline_data: {
              mime_type: 'audio/ogg',
              data: base64Audio
            }
          },
          {
            text: 'Transcribe this audio exactly as spoken. Keep all the words, pauses marked as "..." if long. Output only the transcription, nothing else. Respond in the same language as the audio.'
          }
        ]
      }]
    })
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message);
  }

  return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

async function formatAsNote(transcription) {
  const response = await fetch(GEMINI_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: `Transform this voice transcription into a clean, well-structured note.

Rules:
- Remove filler words (um, uh, like, you know, ну, типа, как бы, вот)
- Fix grammar and punctuation
- Split into logical paragraphs
- Keep the original meaning and tone
- If there are action items or tasks, list them at the end
- Respond in the same language as the input
- Output only the formatted note, no explanations

Transcription:
${transcription}`
        }]
      }]
    })
  });

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || transcription;
}

async function handleCallback(callback) {
  // For future use with buttons if needed
  await answerCallback(callback.id);
}

// Telegram API helpers
async function sendMessage(chatId, text, options = {}) {
  const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      ...options
    })
  });
  return response.json();
}

async function editMessage(chatId, messageId, text) {
  await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: text
    })
  });
}

async function deleteMessage(chatId, messageId) {
  await fetch(`${TELEGRAM_API}/deleteMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId
    })
  });
}

async function answerCallback(callbackId, text = '') {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackId,
      text: text
    })
  });
}

function escapeMarkdown(text) {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
