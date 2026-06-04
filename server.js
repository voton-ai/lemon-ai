/**
 * Voton Lemon AI - サーバー用起動プログラム (server.js)
 * * [特徴]
 * - フロントエンドの「index.html」を安全に配信します。
 * - バックエンドとして、Google Gemini API との通信を安全に中継(Proxy)します。
 * - 規約違反でBANされたGroqの代わりに、完全無料のGemini APIにシステムを移行。
 * - 随所に詳細なデバッグ用 console.log を仕込み、進捗がコンソールにリアルタイム表示されます。
 * - GROQ_API_KEY という名前のままGeminiのキーを貼り付けても自動認識する、超親切なハイブリッド設計。
 */

const express = require('express');
const path = require('path');
const { Readable } = require('stream');
const readline = require('readline');

const app = express();
const PORT = process.env.PORT || 3000;

// Gemini APIのキー（環境変数 GEMINI_API_KEY または既存の GROQ_API_KEY からハイブリッドで自動取得）
const API_KEY = process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY;

app.use(express.json());

// 静的ファイル（HTML, CSS, JSなど）を配信する設定
app.use(express.static(__dirname));

// 2026年最新・超高性能の「Gemini 2.5 シリーズ」をマッピングします
const MODEL_MAPPING = {
    'lemon-grandpro': 'gemini-2.5-pro',   // 最高性能 (Gemini 2.5 Pro)
    'lemon-sp': 'gemini-2.5-flash',       // 高性能・高バランス (Gemini 2.5 Flash)
    'lemon-normal': 'gemini-2.5-flash',   // 普通 (Gemini 2.5 Flash) - 非常に滑らかで爆速
    'lemon-lite': 'gemini-2.5-flash'      // 爆速 (Gemini 2.5 Flash)
};

app.post('/api/chat', async (req, res) => {
    console.log('\n===================================================');
    console.log('--- [📥 新規チャットリクエスト受信（Geminiエンジン起動）] ---');
    console.log('===================================================');
    
    const { modelKey, messages, temperature } = req.body;

    console.log(`[🔍 1. 受信確認] モデルキー: "${modelKey}" | 設定温度 (Temp): ${temperature}`);

    // APIキーの読み込み確認
    if (!API_KEY) {
        console.error('[❌ エラー] APIキーが未設定です。Renderの設定画面で環境変数(GROQ_API_KEY または GEMINI_API_KEY)を登録してください。');
        return res.status(500).json({ error: 'サーバー側にAPIキーが設定されていません。Renderの設定を確認してください。' });
    } else {
        console.log(`[🔑 2. キー確認] APIキーを正常検出。 (接頭辞: ${API_KEY.substring(0, 10)}...)`);
    }

    if (!messages || !Array.isArray(messages)) {
        console.error('[❌ エラー] messages の配列フォーマットが不正です。');
        return res.status(400).json({ error: 'メッセージデータが空、または不正です。' });
    }

    console.log(`[📁 3. 履歴解析] メッセージ総数: ${messages.length} 件`);
    
    // クライアント指定のキーからGeminiの実際のモデル名を取得
    const targetModel = MODEL_MAPPING[modelKey] || MODEL_MAPPING['lemon-normal'];
    console.log(`[🤖 4. モデル選定] 使用するGeminiモデル: "${targetModel}"`);

    // チャットメッセージを Google Gemini API (contents) の規格形式に変換する
    const contents = [];
    let systemInstructionText = "あなたは優秀なAIアシスタントです。";

    messages.forEach((msg, idx) => {
        if (msg.role === 'system') {
            systemInstructionText = msg.content;
        } else {
            contents.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: msg.content }]
            });
        }
    });

    console.log(`[📝 5. 変換完了] 変換後のメッセージ件数: ${contents.length} 件 | システムプロンプト文字数: ${systemInstructionText.length}文字`);

    // レスポンスヘッダーの設定 (ブラウザに逐次出力するSSE規格を宣言)
    console.log('[🌐 6. 通信準備] SSE（イベントストリーム）用ヘッダーをレスポンスに書き込みます...');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Gemini API 接続用URL (Beta APIのstreamGenerateContentを使用)
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:streamGenerateContent?key=${API_KEY}`;
    
    console.log(`[🚀 7. Gemini接続開始] エンドポイントに接続します...`);

    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                contents: contents,
                systemInstruction: {
                    parts: [{ text: systemInstructionText }]
                },
                generationConfig: {
                    temperature: parseFloat(temperature) || 0.7
                }
            })
        });

        console.log(`[📡 8. Gemini応答受信] レスポンス ステータスコード: ${response.status} (${response.statusText})`);

        if (!response.ok) {
            const errorDetails = await response.text();
            console.error(`[❌ APIエラー] Gemini側からエラーメッセージが返却されました:\n${errorDetails}`);
            res.write(`data: ${JSON.stringify({ error: `Gemini APIエラー: ${errorDetails}` })}\n\n`);
            return res.end();
        }

        console.log('[🔓 9. ストリーム解析] readline モジュールによる安全な1行処理を開始します...');

        const nodeStream = Readable.from(response.body);
        const rl = readline.createInterface({
            input: nodeStream,
            terminal: false
        });

        let chunkCount = 0;
        let charCount = 0;

        // Geminiのストリーミングは JSON 配列が少しずつ崩れて送られてくるため、カンマやブラケットを除去して綺麗にパースします
        for await (const line of rl) {
            let cleanedLine = line.trim();
            if (!cleanedLine) continue;

            // 配列の始まり、終わり、または要素の区切りカンマを除去
            if (cleanedLine.startsWith('[')) cleanedLine = cleanedLine.slice(1);
            if (cleanedLine.endsWith(']')) cleanedLine = cleanedLine.slice(0, -1);
            if (cleanedLine.startsWith(',')) cleanedLine = cleanedLine.slice(1);
            cleanedLine = cleanedLine.trim();

            if (!cleanedLine) continue;

            try {
                const parsed = JSON.parse(cleanedLine);
                const textChunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                
                if (textChunk) {
                    chunkCount++;
                    charCount += textChunk.length;

                    // クライアント（index.html）が求めている「data: {"text": "..."}\n\n」の規格に完全に揃えて中継送信
                    res.write(`data: ${JSON.stringify({ text: textChunk })}\n\n`);
                }
            } catch (e) {
                // 不完全なJSONの行（読み込み途中など）は安全にスキップ
            }
        }

        console.log(`[🎉 10. 中継完了] クライアントへの送信に成功しました！(チャンク回数: ${chunkCount}回, 総送信文字数: ${charCount}文字)`);
        res.write('data: [DONE]\n\n');
        res.end();

    } catch (error) {
        console.error('[❌ 致命的エラー] チャット処理中に予期せぬ例外が発生しました:', error);
        res.write(`data: ${JSON.stringify({ error: 'AIサーバーまたはGoogle Cloudへの接続でエラーが発生しました。インターネット接続やAPIキーの設定を確認してください。' })}\n\n`);
        res.end();
    }
});

app.get('/', (req, res) => {
    console.log('[📄 ページ配信] クライアントがアクセスしました。トップページをロードします。');
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(` Voton Lemon AI (Geminiエンジン) が起動しました。`);
    console.log(` 稼働中URL: http://localhost:${PORT}`);
    console.log(`===================================================`);
});
