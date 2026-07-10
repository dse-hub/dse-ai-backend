import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'; // 生產環境請改成你的網站網域，例如 https://your-site.com

if (!API_KEY) {
  console.warn('警告：尚未設定 ANTHROPIC_API_KEY 環境變數，/api/chat 將無法正常運作。');
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

app.post('/api/chat', async (req, res) => {
  try {
    const { system, messages, max_tokens, model, stream } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages 不能為空' });
    }
    if (!API_KEY) {
      return res.status(500).json({ error: '伺服器尚未設定 ANTHROPIC_API_KEY' });
    }

    const upstreamBody = {
      model: model || 'claude-sonnet-4-6',
      max_tokens: Math.min(max_tokens || 800, 4096), // 上限保護，避免單次請求消耗過多額度
      system,
      messages,
      stream: !!stream
    };

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(upstreamBody)
    });

    // 非串流模式：等完整結果再回傳（維持舊行為，供不需要打字機效果的呼叫使用）
    if (!stream) {
      const data = await upstream.json();
      if (!upstream.ok) {
        console.error('Anthropic API 錯誤：', data);
        return res.status(upstream.status).json(data);
      }
      return res.json(data);
    }

    // 串流模式：把 Anthropic 的 SSE 事件即時轉發給前端，實現打字機效果
    if (!upstream.ok || !upstream.body) {
      const errData = await upstream.json().catch(() => ({ error: '上游請求失敗' }));
      console.error('Anthropic API 串流錯誤：', errData);
      return res.status(upstream.status || 500).json(errData);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
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
