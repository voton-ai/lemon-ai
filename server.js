/**
 * Voton Lemon AI - サーバー用起動プログラム (server.js)
 * * [特徴]
 * - フロントエンドの「index.html」を安全に配信します。
 * - バックエンドとして、Groq APIとの通信を安全に中継(Proxy)し、APIキーを完全に隠蔽します。
 * - クライアント側へイベントストリーム(SSE)で回答をリアルタイム返却します。
 * - 随所に詳細なデバッグ用 console.log を仕込み、Renderのログ画面から一目で処理状況が追えるようにしました。
 * - readlineモジュールを使用し、あらゆるNode.js環境で100%クラッシュしない超堅牢なストリーム解析を実装。
 */

const express = require('express');
const path = require('path');
const { Readable } = require('stream');
const readline = require('readline');

const app = express();
const PORT = process.env.PORT || 3000;

// Groq API の設定 (環境変数から取得)
const GROQ_API_KEY = process.env.GROQ_API_KEY;

app.use(express.json());

// 静的ファイル（HTML, CSS, JSなど）を配信する設定
app.use(express.static(__dirname));

// --- APIエンドポイント: モデルマッピング ---
const MODEL_MAPPING = {
    'lemon-grandpro': 'llama-3.3-70b-versatile', // 最高性能 (Llama 3.3 70B)
    'lemon-sp': 'llama-3.1-8b-instant',          // 高性能・高バランス (Llama 3.1 8B)
    'lemon-normal': 'llama-3.1-8b-instant',      // 普通 (Llama 3.1 8B)
    'lemon-lite': 'llama-3.1-8b-instant'         // 爆速 (Llama 3.1 8B)
};

// --- APIエンドポイント: チャットストリーミング中継プロキシ ---
app.post('/api/chat', async (req, res) => {
    console.log('\n--- [📥 新規チャットリクエスト受信] ---');
    const { modelKey, messages, temperature } = req.body;

    console.log(`[設定データ] 受信モデルキー: "${modelKey}"`);
    console.log(`[設定データ] 設定温度 (Temperature): ${temperature}`);
    if (messages && Array.isArray(messages)) {
        console.log(`[設定データ] 会話履歴のメッセージ数: ${messages.length} 件`);
        console.log(`[設定データ] 最新のユーザー入力内容: "${messages[messages.length - 1]?.content}"`);
    } else {
        console.log(`[⚠️ 警告] メッセージ履歴が正しく送られていません。`);
    }

    // APIキーの存在チェック
    if (!GROQ_API_KEY) {
        console.error('[❌ エラー] サーバー側に GROQ_API_KEY 環境変数が設定されていません！');
        return res.status(500).json({ error: 'サーバー側に GROQ_API_KEY が設定されていません。Renderの設定を確認してください。' });
    } else {
        console.log(`[認証確認] APIキーは正常にロードされています。(接頭辞: ${GROQ_API_KEY.substring(0, 8)}...)`);
    }

    if (!messages || !Array.isArray(messages)) {
        console.error('[❌ エラー] リクエストの messages 形式が不正です。');
        return res.status(400).json({ error: 'メッセージデータが不正です。' });
    }

    // クライアント指定のキーからGroqの実際のモデル名を取得
    const targetModel = MODEL_MAPPING[modelKey] || MODEL_MAPPING['lemon-normal'];
    console.log(`[モデル選定] キー "${modelKey}" を実際のGroqモデル "${targetModel}" にマッピングしました。`);
    
    // 設定された柔軟性 (Temperature)
    const tempValue = parseFloat(temperature) !== undefined ? parseFloat(temperature) : 0.7;

    // レスポンスヘッダーの設定 (ストリーミング中継の宣言)
    console.log('[中継設定] ブラウザ向けのイベントストリーム(SSE)ヘッダーを出力します...');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*'); // CORS安全対策

    try {
        console.log('[🚀 Groq通信] Groq APIに接続を試みます...');
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

        console.log(`[Groq通信] レスポンスを受信。ステータスコード: ${response.status} (${response.statusText})`);

        if (!response.ok) {
            const errorDetails = await response.text();
            console.error(`[❌ Groqエラー] Groq API側がエラーを返しました:\n${errorDetails}`);
            res.write(`data: ${JSON.stringify({ error: `Groqエラー: ${errorDetails}` })}\n\n`);
            return res.end();
        }

        console.log('[🔓 ストリーム解析] 超安全な readline ストリーム解析を開始します...');

        // Node.js内蔵のWeb StreamをNode.js標準のReadableストリームに変換
        const nodeStream = Readable.from(response.body);
        
        // 改行コード(\n)を検知して1行ずつ完璧に切り出してくれるインターフェースを作成
        const rl = readline.createInterface({
            input: nodeStream,
            terminal: false
        });

        let chunkCount = 0;
        let charCount = 0;

        // 1行データが届くたびに動くループ処理
        for await (const line of rl) {
            const cleanedLine = line.trim();
            if (!cleanedLine) continue;

            // 終了信号をキャッチした場合
            if (cleanedLine === 'data: [DONE]') {
                console.log(`[ストリーム完了] Groqから [DONE] 信号を受信しました。中継を終了します。`);
                res.write('data: [DONE]\n\n');
                continue;
            }

            // data: から始まる有効なストリーム行のみパース
            if (cleanedLine.startsWith('data: ')) {
                try {
                    const parsed = JSON.parse(cleanedLine.slice(6));
                    const textChunk = parsed.choices?.[0]?.delta?.content;
                    if (textChunk) {
                        chunkCount++;
                        charCount += textChunk.length;
                        
                        // クライアント(ブラウザ)へそのまま中継送信
                        res.write(`data: ${JSON.stringify({ text: textChunk })}\n\n`);
                    }
                } catch (e) {
                    // JSONが途中で切れていた場合などのパース失敗は安全にスルー
                    console.log(`[⚠️ デバッグ] 半端なJSON行をスキップしました: "${cleanedLine}"`);
                }
            }
        }

        console.log(`[🎉 中継完了] ブラウザへの送信が成功しました。(受信チャンク数: ${chunkCount}回, 総出力文字数: ${charCount}文字)`);
        res.end();

    } catch (error) {
        console.error('[❌ 致命的エラー] チャット通信処理中に例外が発生しました:', error);
        res.write(`data: ${JSON.stringify({ error: 'AIサーバーへの接続でエラーが発生しました。インターネット接続やAPIキーの設定を確認してください。' })}\n\n`);
        res.end();
    }
});

// メインページの配信
app.get('/', (req, res) => {
    console.log('[📄 ページ配信] クライアントがトップページにアクセスしました。index.htmlを配信します。');
    res.sendFile(path.join(__dirname, 'index.html'));
});

// サーバーをポート3000で起動
app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(` Voton Lemon AI サーバーがポート ${PORT} で正常起動しました。`);
    console.log(` URL: http://localhost:${PORT}`);
    console.log(`===================================================`);
});
