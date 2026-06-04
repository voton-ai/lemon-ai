/**
 * Voton Lemon AI - 究極マルチプロバイダー・フェイルオーバーサーバー (server.js)
 * * [特徴]
 * - フロントエンドの「index.html」を安全に配信します。
 * - バックエンドとして、6つの主要AIプロバイダーを安全に中継。
 * - 優先順位に基づき、あるAPIキーが上限（レートリミット/BAN）に達したら、次のAPIに自動で1秒未満で切り替えます（フェイルオーバー）。
 * - 4つのモデル位置づけ（Lemon AI Lite〜GrandPro）を各プロバイダーの最適なモデルへと自動で翻訳マッピング。
 * - 随所に詳細なデバッグ用 console.log を仕込み、Renderのログ画面から切り替え状況を100%追跡可能。
 */

const express = require('express');
const path = require('path');
const { Readable } = require('stream');
const readline = require('readline');

const app = express();
const PORT = process.env.PORT || 3000;

// --- 6大プロバイダーのAPIキーの環境変数ロード ---
const KEYS = {
    gemini: process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY, // 互換性のために両方をサポート
    openrouter: process.env.OPENROUTER_API_KEY,
    groq: process.env.GROQ_API_KEY,
    mistral: process.env.MISTRAL_API_KEY,
    cohere: process.env.COHERE_API_KEY,
    cloudflare: {
        token: process.env.CLOUDFLARE_API_KEY,
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID
    }
};

app.use(express.json());
app.use(express.static(__dirname));

// --- 究極のモデルマッピングマトリクス ---
// 各プロバイダーの中で、4つのLemon AIモデルの位置づけ（Lite / Normal / SP / GrandPro）に最も合致するモデルを厳選
const PROVIDER_MODELS = {
    gemini: {
        'lemon-grandpro': 'gemini-2.5-pro',
        'lemon-sp': 'gemini-2.5-flash',
        'lemon-normal': 'gemini-2.5-flash',
        'lemon-lite': 'gemini-2.5-flash-lite' // Liteには回数上限の多いFlash-Liteを割り当て
    },
    openrouter: {
        'lemon-grandpro': 'meta-llama/llama-3.3-70b-instruct:free',
        'lemon-sp': 'meta-llama/llama-3.1-8b-instant:free',
        'lemon-normal': 'google/gemma-2-9b-it:free', // 復活！OpenRouter経由ならGemma2無料枠が安全に使えます
        'lemon-lite': 'meta-llama/llama-3.1-8b-instant:free'
    },
    groq: {
        'lemon-grandpro': 'llama-3.3-70b-versatile',
        'lemon-sp': 'llama-3.1-8b-instant',
        'lemon-normal': 'llama-3.1-8b-instant',
        'lemon-lite': 'llama-3.1-8b-instant'
    },
    mistral: {
        'lemon-grandpro': 'mistral-large-latest', // 最上位モデル
        'lemon-sp': 'mistral-small-latest',
        'lemon-normal': 'open-mistral-7b',
        'lemon-lite': 'open-mistral-7b'
    },
    cohere: {
        'lemon-grandpro': 'command-r-plus', // 128kトークン・超優秀ビジネスモデル
        'lemon-sp': 'command-r',
        'lemon-normal': 'command-r',
        'lemon-lite': 'command-r'
    },
    cloudflare: {
        'lemon-grandpro': '@cf/meta/llama-3.1-70b-instruct',
        'lemon-sp': '@cf/meta/llama-3.1-8b-instruct',
        'lemon-normal': '@cf/meta/llama-3-8b-instruct',
        'lemon-lite': '@cf/meta/llama-3-8b-instruct'
    }
};

// --- チャットストリーミング中継（フェイルオーバーコア） ---
app.post('/api/chat', async (req, res) => {
    console.log('\n===================================================');
    console.log('--- [📥 チャットリクエスト受信] ---');
    console.log('===================================================');
    const { modelKey, messages, temperature } = req.body;

    console.log(`[基本データ] クライアント指定モデルキー: "${modelKey}"`);
    console.log(`[基本データ] 設定温度 (Temperature): ${temperature}`);
    if (messages && messages.length > 0) {
        console.log(`[基本データ] ユーザー入力メッセージ: "${messages[messages.length - 1]?.content}"`);
    }

    // クライアントに先にストリーミング接続ヘッダーを返却
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // 1. 環境変数にAPIキーが設定されているプロバイダーを抽出し、優先順リストを動的構築
    const activeProviders = [];

    if (KEYS.gemini) {
        // キーの接頭辞をデバッグログに出力
        const prefix = KEYS.gemini.substring(0, 7);
        console.log(`[キーチェック] Gemini用キーを検出しました。 接頭辞: "${prefix}..."`);
        if (!prefix.startsWith('AIzaSy')) {
            console.log(`[⚠️ 警告] Gemini用キーの頭文字が "AIzaSy" ではありません。キーの選択に間違いがないか確認してください！`);
        }
        activeProviders.push({ name: 'Google Gemini', type: 'gemini', key: KEYS.gemini });
    }
    if (KEYS.openrouter) activeProviders.push({ name: 'OpenRouter (無料枠)', type: 'openrouter', key: KEYS.openrouter });
    if (KEYS.cohere) activeProviders.push({ name: 'Cohere AI', type: 'cohere', key: KEYS.cohere });
    if (KEYS.mistral) activeProviders.push({ name: 'Mistral AI', type: 'mistral', key: KEYS.mistral });
    if (KEYS.groq) activeProviders.push({ name: 'Groq (代替・回復時用)', type: 'groq', key: KEYS.groq });
    if (KEYS.cloudflare.token && KEYS.cloudflare.accountId) {
        activeProviders.push({ name: 'Cloudflare Workers AI', type: 'cloudflare', key: KEYS.cloudflare.token, extra: KEYS.cloudflare.accountId });
    }

    console.log(`[プロバイダー解析] 動的に稼働可能なプロバイダー数: ${activeProviders.length} 件`);
    activeProviders.forEach((p, idx) => {
        console.log(`  -> 優先順位 ${idx + 1}: ${p.name}`);
    });

    if (activeProviders.length === 0) {
        console.error('[❌ エラー] 利用可能なAPIキーが環境変数に1つも設定されていません！');
        res.write(`data: ${JSON.stringify({ error: 'サーバーにAPIキーが1つも登録されていません。Renderの環境変数（Environment Variables）を確認してください。' })}\n\n`);
        return res.end();
    }

    let isSuccess = false;

    // 2. 稼働可能なプロバイダーを順番にフェイルオーバー試行
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
                const isOAuthToken = prov.key.startsWith('AQ.');
                let geminiUrl = '';
                const headers = { 'Content-Type': 'application/json' };

                if (isOAuthToken) {
                    console.log('[🔑 Gemini認証] AQ.で始まるキーを検出しました。OAuthトークン認証（Authorizationヘッダー）を適用します。');
                    geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:streamGenerateContent`;
                    headers['Authorization'] = `Bearer ${prov.key}`;
                } else {
                    console.log('[🔑 Gemini認証] 標準キー（AIzaSy）のクエリパラメータ認証を適用します。');
                    geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:streamGenerateContent?key=${prov.key}`;
                }

                const geminiMessages = messages.map(msg => ({
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: msg.content }]
                })).filter(msg => msg.role !== 'system');

                response = await fetch(geminiUrl, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({
                        contents: geminiMessages,
                        generationConfig: { temperature: tempValue }
                    })
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
                        messages: messages,
                        temperature: tempValue,
                        stream: true
                    })
                });

            } else if (prov.type === 'groq') {
                // --- Groq API 接続処理 ---
                response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${prov.key}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: targetModel,
                        messages: messages,
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
                        messages: messages,
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
                        message: messages[messages.length - 1]?.content,
                        chat_history: messages.slice(0, -1).map(m => ({
                            role: m.role === 'assistant' ? 'CHATBOT' : 'USER',
                            message: m.content
                        })),
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
                        messages: messages,
                        stream: true
                    })
                });
            }

            console.log(`[${prov.name}] APIからの応答コード: ${response.status} (${response.statusText})`);

            if (!response.ok) {
                const errText = await response.text();
                console.warn(`[⚠️ 警告] ${prov.name} がエラーを返しました。次の代替プロバイダーへ移行します。エラー詳細:\n${errText}`);
                continue; // ループを継続し、次のプロバイダーを試行
            }

            // ストリームのリアルタイム解析・送信処理
            console.log(`[🎉 成功] ${prov.name} への接続に成功！ブラウザへリアルタイム中継を開始します。`);
            const nodeStream = Readable.from(response.body);
            const rl = readline.createInterface({ input: nodeStream, terminal: false });

            let charCount = 0;

            for await (const line of rl) {
                const cleanedLine = line.trim();
                if (!cleanedLine) continue;

                if (prov.type === 'gemini') {
                    // --- Gemini用ストリームパーサー ---
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
                    // --- Cohere用ストリームパーサー ---
                    try {
                        const parsed = JSON.parse(cleanedLine);
                        if (parsed.event_type === 'text-generation' && parsed.text) {
                            charCount += parsed.text.length;
                            res.write(`data: ${JSON.stringify({ text: parsed.text })}\n\n`);
                        }
                    } catch (e) {}

                } else {
                    // --- OpenAI互換 (OpenRouter, Groq, Mistral, Cloudflare) 用パーサー ---
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
            break; // 成功したため、プロバイダーループを完全に抜ける

        } catch (error) {
            console.error(`[❌ 接続失敗] ${prov.name} の通信中に例外が発生しました。次をテストします。エラー内容:`, error);
        }
    }

    if (!isSuccess) {
        console.error('[❌ 致命的] 環境変数に登録されたすべてのプロバイダーが制限に達したか、エラーで全滅しました。');
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
