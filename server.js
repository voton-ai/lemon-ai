/**
 * Voton Lemon AI - 7大プロバイダー対応・全AIリアルタイム検索フェイルオーバーサーバー (server.js)
 * * [特徴]
 * - フロントエンドの「index.html」を安全に配信します。
 * - すべてのAIプロバイダーで「現在日時」「リアルタイムWeb検索」を利用可能。
 * - Web検索エンジン（DuckDuckGo）からより多くのテキストスニペットを抽出し、AIへの指示プロンプトを徹底強化。
 * - AIに対して「検索結果の断片情報をそのまま繰り返すのではなく、背景知識や関連情報を交えて、深く、構造化された丁寧な長文回答を作成せよ」と制限。
 */

const express = require('express');
const path = require('path');
const { Readable } = require('stream');
const readline = require('readline');

const app = express();
const PORT = process.env.PORT || 3000;

// --- 7大プロバイダーのAPIキーの環境変数ロード ---
const KEYS = {
    gemini: process.env.GEMINI_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    cohere: process.env.COHERE_API_KEY,
    mistral: process.env.MISTRAL_API_KEY,
    huggingface: process.env.HUGGING_FACE_API_KEY,
    together: process.env.TOGETHER_API_KEY,
    cloudflare: {
        token: process.env.CLOUDFLARE_API_KEY,
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID
    }
};

app.use(express.json());
app.use(express.static(__dirname));

// --- 究極のモデルマッピングマトリクス (2026年最新モデル) ---
const PROVIDER_MODELS = {
    gemini: {
        'lemon-grandpro': 'gemini-2.5-pro',
        'lemon-sp': 'gemini-2.5-flash',
        'lemon-normal': 'gemini-2.5-flash',
        'lemon-lite': 'gemini-2.5-flash-lite'
    },
    openrouter: {
        'lemon-grandpro': 'meta-llama/llama-3.3-70b-instruct:free',
        'lemon-sp': 'meta-llama/llama-3.1-8b-instant:free',
        'lemon-normal': 'qwen/qwen-2.5-7b-instruct:free',
        'lemon-lite': 'meta-llama/llama-3.1-8b-instant:free'
    },
    cohere: {
        'lemon-grandpro': 'command-r-plus-08-2024',
        'lemon-sp': 'command-r-08-2024',
        'lemon-normal': 'command-r-08-2024',
        'lemon-lite': 'command-r-08-2024'
    },
    mistral: {
        'lemon-grandpro': 'mistral-large-latest',
        'lemon-sp': 'mistral-small-latest',
        'lemon-normal': 'open-mistral-7b',
        'lemon-lite': 'open-mistral-7b'
    },
    huggingface: {
        'lemon-grandpro': 'Qwen/Qwen2.5-72B-Instruct',
        'lemon-sp': 'meta-llama/Llama-3.2-3B-Instruct',
        'lemon-normal': 'meta-llama/Llama-3.2-3B-Instruct',
        'lemon-lite': 'meta-llama/Llama-3.2-3B-Instruct'
    },
    together: {
        'lemon-grandpro': 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        'lemon-sp': 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
        'lemon-normal': 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
        'lemon-lite': 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'
    },
    cloudflare: {
        'lemon-grandpro': '@cf/meta/llama-3.1-70b-instruct',
        'lemon-sp': '@cf/meta/llama-3.1-8b-instruct',
        'lemon-normal': '@cf/meta/llama-3-8b-instruct',
        'lemon-lite': '@cf/meta/llama-3-8b-instruct'
    }
};

/**
 * 完全無料・キー不要のWeb検索(DuckDuckGo HTML)スクレイパー
 * AIに最新情報を提供するための詳細なテキストスニペットを最大10件取得します
 */
async function performWebSearch(query) {
    console.log(`[🔍 検索実行] クエリ: "${query}"`);
    try {
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const response = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        if (!response.ok) return "検索結果を取得できませんでした。";

        const html = await response.text();
        
        const results = [];
        // タイトル、URL、スニペットを極力広く収集
        const regex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        let match;
        
        while ((match = regex.exec(html)) !== null && results.length < 8) {
            let snippet = match[1]
                .replace(/<[^>]*>/g, '') // タグ除去
                .replace(/\s+/g, ' ')    // 余白の統一
                .trim();
            if (snippet) {
                results.push(`[情報源 ${results.length + 1}]: ${snippet}`);
            }
        }

        if (results.length === 0) {
            return "該当する検索結果が見つかりませんでした。";
        }

        return results.join("\n\n");
    } catch (e) {
        console.error("[❌ 検索エラー] 検索処理中に例外が発生しました:", e);
        return "検索に失敗しました。";
    }
}

/**
 * ユーザーが検索を求めているキーワード（インテント）を解析し
 * 必要であれば検索結果を格納したプロンプトに拡張します
 */
async function processSearchGrounding(messages) {
    const userMessage = messages[messages.length - 1]?.content || "";
    
    // 検索が必要な質問かどうかのパターンマッチング
    const searchKeywords = [
        "最新", "ニュース", "今日", "いま", "天気", "誰", "どこ", "何時", 
        "2025", "2026", "検索", "調べて", "とは", "について", "価格", "株価", "出来事", "トレンド"
    ];

    const needsSearch = searchKeywords.some(keyword => userMessage.includes(keyword));

    // 取得した現在日時
    const now = new Date();
    const jstTime = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'long'
    }).format(now);

    let groundingContext = `
[システム情報・コンテキスト]
- 現在日時 (日本時間/JST): ${jstTime}
- 現在地: 東京都江東区、日本
`;

    if (needsSearch) {
        console.log(`[💡 検索インテント検知] Web検索バックグラウンド処理を開始します...`);
        const searchResults = await performWebSearch(userMessage);
        
        groundingContext += `
- 最新のWeb検索結果 (DuckDuckGo調べ):
"""
${searchResults}
"""

【最重要指示】
ユーザーは最新のリアルタイム情報を求めています。
1. 上記の検索結果スニペット（事実情報）をベースにして、不足しているコンテキストや背景知識をあなたの高い思考力で補い、知的で丁寧なボリュームのある「詳細な解説」を作成してください。
2. 決して一言や二言の簡素な回答で済ませてはいけません。要点を整理し、見出しや箇条書きなどを使って読みやすく充実したドキュメント風の回答を生成してください。
3. 検索結果にない不確かな事柄を事実として断言することは避けつつ、事実に基づく論理的な解説を行ってください。
`;
    } else {
        // 通常の会話であっても日時情報を認識させる
        groundingContext += `\n現在時刻や日付に関する質問がある場合は、上記のシステム時間に基づいて正確に回答してください。`;
    }

    const groundedMessages = [...messages];
    const systemInstructionIndex = groundedMessages.findIndex(m => m.role === 'system');

    if (systemInstructionIndex !== -1) {
        // システムプロンプトが存在する場合はそこにブレンド
        groundedMessages[systemInstructionIndex].content += "\n" + groundingContext;
    } else {
        // 存在しない場合は新規に作成
        groundedMessages.unshift({ role: 'system', content: groundingContext });
    }

    return groundedMessages;
}

// --- チャットストリーミング中継（フェイルオーバーコア） ---
app.post('/api/chat', async (req, res) => {
    console.log('\n===================================================');
    console.log('--- [📥 新規チャットリクエスト受信] ---');
    console.log('===================================================');
    const { modelKey, messages, temperature } = req.body;

    console.log(`[基本データ] クライアント指定モデルキー: "${modelKey}"`);
    console.log(`[基本データ] 設定温度 (Temperature): ${temperature}`);
    
    // クライアントに先にストリーミング接続ヘッダーを返却
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // 優先順位リストを動的に構築
    const activeProviders = [];

    if (KEYS.gemini) activeProviders.push({ name: 'Google Gemini', type: 'gemini', key: KEYS.gemini });
    if (KEYS.openrouter) activeProviders.push({ name: 'OpenRouter (無料枠)', type: 'openrouter', key: KEYS.openrouter });
    if (KEYS.together) activeProviders.push({ name: 'Together AI', type: 'together', key: KEYS.together });
    if (KEYS.cohere) activeProviders.push({ name: 'Cohere AI', type: 'cohere', key: KEYS.cohere });
    if (KEYS.huggingface) activeProviders.push({ name: 'Hugging Face (サーバーレス)', type: 'huggingface', key: KEYS.huggingface });
    if (KEYS.mistral) activeProviders.push({ name: 'Mistral AI', type: 'mistral', key: KEYS.mistral });
    if (KEYS.cloudflare.token && KEYS.cloudflare.accountId) {
        activeProviders.push({ name: 'Cloudflare Workers AI', type: 'cloudflare', key: KEYS.cloudflare.token, extra: KEYS.cloudflare.accountId });
    }

    console.log(`[プロバイダー解析] 動的に稼働可能なプロバイダー数: ${activeProviders.length} 件`);

    if (activeProviders.length === 0) {
        console.error('[❌ エラー] 利用可能なAPIキーが環境変数に1つも設定されていません！');
        res.write(`data: ${JSON.stringify({ error: 'サーバーに有効なAPIキーが1つも登録されていません。Renderの環境変数を確認してください。' })}\n\n`);
        return res.end();
    }

    // すべてのモデルでWeb検索＆最新日時情報グラウンディングを適用
    const groundedMessages = await processSearchGrounding(messages);

    let isSuccess = false;

    // 稼働可能なプロバイダーを順番に試行
    for (let i = 0; i < activeProviders.length; i++) {
        const prov = activeProviders[i];
        const targetModel = PROVIDER_MODELS[prov.type][modelKey] || PROVIDER_MODELS[prov.type]['lemon-normal'];
        const tempValue = parseFloat(temperature) !== undefined ? parseFloat(temperature) : 0.7;

        console.log(`\n--- [🔄 試行 ${i + 1}/${activeProviders.length}] プロバイダー: ${prov.name} ---`);
        console.log(`[中継詳細] 送信先モデル名: "${targetModel}"`);

        try {
            let response;

            if (prov.type === 'gemini') {
                // --- Google Gemini API 接続処理 ---
                const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:streamGenerateContent?key=${prov.key}`;
                
                const systemMsg = groundedMessages.find(m => m.role === 'system');
                const userAndModelMessages = groundedMessages.map(msg => ({
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: msg.content }]
                })).filter(msg => msg.role !== 'system');

                const payload = {
                    contents: userAndModelMessages,
                    generationConfig: { temperature: tempValue }
                };

                if (systemMsg) {
                    payload.systemInstruction = {
                        parts: [{ text: systemMsg.content }]
                    };
                }

                response = await fetch(geminiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

            } else if (prov.type === 'openrouter') {
                // --- OpenRouter API 接続処理 ---
                response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${prov.key}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': 'https://lemon-ai.onrender.com',
                        'X-Title': 'Voton Lemon AI'
                    },
                    body: JSON.stringify({
                        model: targetModel,
                        messages: groundedMessages,
                        temperature: tempValue,
                        stream: true
                    })
                });

            } else if (prov.type === 'together') {
                // --- Together AI API 接続処理 (OpenAI互換) ---
                response = await fetch('https://api.together.xyz/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${prov.key}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: targetModel,
                        messages: groundedMessages,
                        temperature: tempValue,
                        stream: true
                    })
                });

            } else if (prov.type === 'cohere') {
                // --- Cohere API 接続処理 ---
                response = await fetch('https://api.cohere.ai/v1/chat', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${prov.key}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: targetModel,
                        message: groundedMessages[groundedMessages.length - 1]?.content,
                        chat_history: groundedMessages.slice(0, -1).map(m => ({
                            role: m.role === 'assistant' ? 'CHATBOT' : 'USER',
                            message: m.content
                        })),
                        temperature: tempValue,
                        stream: true
                    })
                });

            } else if (prov.type === 'huggingface') {
                // --- Hugging Face Serverless API 接続処理 ---
                const hfUrl = `https://api-inference.huggingface.co/v1/chat/completions`;
                response = await fetch(hfUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${prov.key}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: targetModel,
                        messages: groundedMessages,
                        temperature: tempValue,
                        stream: true
                    })
                });

            } else if (prov.type === 'mistral') {
                // --- Mistral AI API 接続処理 ---
                response = await fetch('https://api.mistral.ai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${prov.key}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: targetModel,
                        messages: groundedMessages,
                        temperature: tempValue,
                        stream: true
                    })
                });

            } else if (prov.type === 'cloudflare') {
                // --- Cloudflare Workers AI 接続処理 ---
                const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${prov.extra}/ai/run/${targetModel}`;
                response = await fetch(cfUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${prov.key}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        messages: groundedMessages,
                        stream: true
                    })
                });
            }

            console.log(`[${prov.name}] APIからの応答コード: ${response.status} (${response.statusText})`);

            if (!response.ok) {
                const errText = await response.text();
                console.warn(`[⚠️ 警告] ${prov.name} がエラーを返しました。次の代替プロバイダーへ移行します。エラー詳細:\n${errText}`);
                continue; 
            }

            // ストリームのリアルタイム解析・送信
            console.log(`[🎉 成功] ${prov.name} への接続に成功！中継を開始します。`);
            const nodeStream = Readable.from(response.body);
            const rl = readline.createInterface({ input: nodeStream, terminal: false });

            let charCount = 0;

            for await (const line of rl) {
                const cleanedLine = line.trim();
                if (!cleanedLine) continue;

                if (prov.type === 'gemini') {
                    if (cleanedLine.startsWith('[') || cleanedLine.startsWith(',') || cleanedLine.startsWith(']')) continue;
                    try {
                        const parsed = JSON.parse(cleanedLine.replace(/^,/, ''));
                        const textChunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                        if (textChunk) {
                            charCount += textChunk.length;
                            res.write(`data: ${JSON.stringify({ text: textChunk })}\n\n`);
                        }
                    } catch (e) {}

                } else if (prov.type === 'cohere') {
                    try {
                        const parsed = JSON.parse(cleanedLine);
                        if (parsed.event_type === 'text-generation' && parsed.text) {
                            charCount += parsed.text.length;
                            res.write(`data: ${JSON.stringify({ text: parsed.text })}\n\n`);
                        }
                    } catch (e) {}

                } else {
                    if (cleanedLine === 'data: [DONE]') {
                        res.write('data: [DONE]\n\n');
                        continue;
                    }
                    if (cleanedLine.startsWith('data: ')) {
                        try {
                            const parsed = JSON.parse(cleanedLine.slice(6));
                            const textChunk = parsed.choices?.[0]?.delta?.content;
                            if (textChunk) {
                                charCount += textChunk.length;
                                res.write(`data: ${JSON.stringify({ text: textChunk })}\n\n`);
                            }
                        } catch (e) {}
                    }
                }
            }

            console.log(`[🏁 送信完了] ${prov.name} による中継が正常に終了しました。(出力文字数: ${charCount}文字)`);
            res.write('data: [DONE]\n\n');
            res.end();
            isSuccess = true;
            break;

        } catch (error) {
            console.error(`[❌ 接続失敗] ${prov.name} の通信中に例外が発生しました。エラー内容:`, error);
        }
    }

    if (!isSuccess) {
        console.error('[❌ 致命的] 登録されているすべてのプロバイダーで通信エラー、または制限により失敗しました。');
        res.write(`data: ${JSON.stringify({ error: '現在すべての無料AI枠の制限に達してしまいました。お手数ですが、時間をおいて再度送信してください。' })}\n\n`);
        res.end();
    }
});

// メインページの配信
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// サーバー起動
app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(` Voton Lemon AI (マルチプロバイダー) が正常起動しました。`);
    console.log(` 待機ポート: ${PORT}`);
    console.log(`===================================================`);
});
