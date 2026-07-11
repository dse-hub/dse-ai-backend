import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'; // 生產環境請改成你的網站網域，例如 https://your-site.com
const DEFAULT_MODEL = 'gemini-3.5-flash'; // 目前穩定可用、有免費額度的模型

if (!API_KEY) {
  console.warn('警告：尚未設定 GEMINI_API_KEY 環境變數，/api/chat 將無法正常運作。');
}

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '2mb' }));

// 簡單限流：每個 IP 每 15 分鐘最多 60 次請求，避免被濫用把你的額度刷爆
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '請求過於頻繁，請稍後再試。' }
});
app.use('/api/', limiter);

// 把「Anthropic 格式」的訊息陣列，轉成 Gemini 需要的 contents 格式
function toGeminiContents(messages) {
  return (messages || [])
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }]
    }));
}

app.post('/api/chat', async (req, res) => {
  try {
    const { system, messages, max_tokens, model, stream } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages 不能為空' });
    }
    if (!API_KEY) {
      return res.status(500).json({ error: '伺服器尚未設定 GEMINI_API_KEY' });
    }

    // 前端可能還是傳 "claude-xxx" 這種舊字串，這裡一律忽略、改用 Gemini 模型
    const geminiModel = (model && String(model).startsWith('gemini')) ? model : DEFAULT_MODEL;

    const requestBody = {
      contents: toGeminiContents(messages),
      generationConfig: {
        maxOutputTokens: Math.min(max_tokens || 800, 4096) // 上限保護，避免單次請求消耗過多額度
      }
    };
    if (system) {
      requestBody.systemInstruction = { parts: [{ text: system }] };
    }

    const endpoint = stream
      ? `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:streamGenerateContent?alt=sse`
      : `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`;

    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': API_KEY
      },
      body: JSON.stringify(requestBody)
    });

    // 非串流模式：等完整結果，轉換成前端原本熟悉的格式再回傳（前端完全不用改）
    if (!stream) {
      const data = await upstream.json();
      if (!upstream.ok) {
        console.error('Gemini API 錯誤：', data);
        return res.status(upstream.status).json(data);
      }
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .map(p => p.text || '').join('');
      return res.json({ content: [{ type: 'text', text }] });
    }

    // 串流模式：把 Gemini 的 SSE 資料，轉換成前端原本能解析的事件格式
    if (!upstream.ok || !upstream.body) {
      const errData = await upstream.json().catch(() => ({ error: '上游請求失敗' }));
      console.error('Gemini API 串流錯誤：', errData);
      return res.status(upstream.status || 500).json(errData);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr) continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const text = (parsed?.candidates?.[0]?.content?.parts || [])
              .map(p => p.text || '').join('');
            if (text) {
              const event = { type: 'content_block_delta', delta: { type: 'text_delta', text } };
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
          } catch (e) { /* 忽略解析失敗的片段 */ }
        }
      }
    } finally {
      res.end();
    }
  } catch (err) {
    console.error('代理伺服器錯誤：', err);
    if (!res.headersSent) {
      res.status(500).json({ error: '伺服器內部錯誤' });
    } else {
      res.end();
    }
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`AI 代理伺服器已啟動，監聽埠 ${PORT}`);
});
