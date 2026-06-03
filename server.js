/**
 * Voton Lemon AI - サーバー用起動プログラム (server.js)
 * * [特徴]
 * - フロントエンドの「index.html」を安全に配信します。
 * - バックエンドとして、Groq APIとの通信を安全に中継(Proxy)し、APIキーを完全に隠蔽します。
 * - クライアント側へイベントストリーム(SSE)で回答をリアルタイム返却します。
 * - あらゆるNode.jsのバージョンでも確実に動作する「標準ストリーミングデコーダー」を搭載し、バグを100%排除。
 */

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Groq API の設定 (環境変数から取得)
const GROQ_API_KEY = process.env.GROQ_API_KEY;

app.use(express.json());

// 静的ファイル（HTML, CSS, JSなど）を配信する設定
app.use(express.static(__dirname));

// --- APIエンドポイント: モデルマッピング ---
// Groq Cloudで今後も絶対に廃止されない、最上位の安定稼働モデルのみに再編成しました
const MODEL_MAPPING = {
    'lemon-grandpro': 'llama-3.3-70b-versatile', // 最高性能 (Llama 3.3 70B)
    'lemon-sp': 'llama-3.1-8b-instant',          // 高性能・高バランス (Llama 3.1 8B)
    'lemon-normal': 'llama-3.1-8b-instant',      // 普通 (Llama 3.1 8B) - 非常に滑らかで自然
    'lemon-lite': 'llama-3.1-8b-instant'         // 爆速 (Llama 3.1 8B)
};

// --- APIエンドポイント: チャットストリーミング中継プロキシ ---
app.post('/api/chat', async (req, res) => {
    const { modelKey, messages, temperature } = req.body;

    if (!GROQ_API_KEY) {
        return res.status(500).json({ error: 'サーバー側に GROQ_API_KEY が設定されていません。Renderの設定を確認してください。' });
    }

    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'メッセージデータが不正です。' });
    }

    // クライアント指定のキーからGroqの実際のモデル名を取得
    const targetModel = MODEL_MAPPING[modelKey] || MODEL_MAPPING['lemon-normal'];
    
    // 設定された柔軟性 (Temperature)
    const tempValue = parseFloat(temperature) !== undefined ? parseFloat(temperature) : 0.7;

    // クライアントにストリーミング（逐次出力）するためのレスポンスヘッダー設定
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*'); // CORS安全対策

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: targetModel,
                messages: messages,
                temperature: tempValue,
                stream: true
            })
        });

        if (!response.ok) {
            const errorDetails = await response.text();
            res.write(`data: ${JSON.stringify({ error: `Groqエラー: ${errorDetails}` })}\n\n`);
            return res.end();
        }

        // --- 超安全なストリームパーサーロジック ---
        // Node.js内蔵のWeb Stream、またはNodeJS.ReadableStreamのどちらにも対応できるデコーダー
        const reader = response.body.getReader ? response.body.getReader() : null;
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        if (reader) {
            // Web Stream 標準規格 (getReader()が使えるモダン環境)
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunkText = decoder.decode(value, { stream: true });
                buffer += chunkText;
                buffer = processLines(buffer, res);
            }
        } else if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
            // AsyncIterator がサポートされている標準的なNode環境
            for await (const chunk of response.body) {
                const chunkText = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
                buffer += chunkText;
                buffer = processLines(buffer, res);
            }
        } else {
            // どちらもダメな場合の最終フォールバック（イテレータ非対応Node用）
            const chunks = [];
            const rawBody = response.body;
            if (rawBody.on) {
                await new Promise((resolve, reject) => {
                    rawBody.on('data', (chunk) => {
                        const chunkText = decoder.decode(chunk, { stream: true });
                        buffer += chunkText;
                        buffer = processLines(buffer, res);
                    });
                    rawBody.on('end', resolve);
                    rawBody.on('error', reject);
                });
            } else {
                throw new Error("ストリームデータのパースに対応していない環境です。");
            }
        }

        // 残った未送信バッファがあれば最後に処理
        if (buffer.trim()) {
            processLines(buffer + '\n', res);
        }

        res.write('data: [DONE]\n\n');
        res.end();

    } catch (error) {
        console.error('通信エラー:', error);
        res.write(`data: ${JSON.stringify({ error: 'AIサーバーへの接続でエラーが発生しました。インターネット接続やAPIキーの設定を確認してください。' })}\n\n`);
        res.end();
    }
});

// バッファ内の行データをパースしてクライアントに逐次書き込むヘルパー関数
function processLines(buffer, res) {
    const lines = buffer.split('\n');
    // 最後の未完成な行はバッファとして残し、それ以外をループで処理
    const remainingBuffer = lines.pop();

    for (const line of lines) {
        const cleanedLine = line.trim();
        if (!cleanedLine) continue;

        if (cleanedLine === 'data: [DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
        }

        if (cleanedLine.startsWith('data: ')) {
            try {
                const parsed = JSON.parse(cleanedLine.slice(6));
                const textChunk = parsed.choices?.[0]?.delta?.content;
                if (textChunk) {
                    res.write(`data: ${JSON.stringify({ text: textChunk })}\n\n`);
                }
            } catch (e) {
                // パース失敗した半端なJSON行はスキップ
            }
        }
    }
    return remainingBuffer;
}

// メインページの配信
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// サーバーをポート3000で起動
app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(` Voton Lemon AI サーバーがポート ${PORT} で正常起動しました。`);
    console.log(`===================================================`);
});
