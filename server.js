/**
 * Voton Lemon AI - サーバー用起動プログラム (server.js)
 * * [特徴]
 * - フロントエンドの「index.html」を安全に配信します。
 * - バックエンドとして、Groq APIとの通信を安全に中継(Proxy)し、APIキーを完全に隠蔽します。
 * - クライアント側へイベントストリーム(SSE)で回答をリアルタイム返却します。
 * - Node.js環境下でgetReader()がクラッシュするバグを非同期イテレータ(for await)で完全解決。
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

        // Node.js 18以降の標準fetchストリームを安全に処理する正しい方法 (getReaderの廃止)
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            
            // 最後の未完成な行をバッファに残す
            buffer = lines.pop();

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
        }
        res.end();

    } catch (error) {
        console.error('通信エラー:', error);
        res.write(`data: ${JSON.stringify({ error: 'AIサーバーへの接続でエラーが発生しました。インターネット接続やAPIキーの設定を確認してください。' })}\n\n`);
        res.end();
    }
});

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
