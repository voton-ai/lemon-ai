/**
 * Voton Lemon AI - 画像読み込み(マルチモーダル)＆AI画像生成(Imagen4/SDXL/FLUX)対応サーバー (server.js)
 * * [主な改善機能]
 * - OpenRouterの無料枠モデルを最新の「google/gemini-2.5-flash:free」に修正。
 * - CohereやTogether等の認証ヘッダーエラーを自動補正。
 */

const express = require('express');
const path = require('path');
const { Readable } = require('stream');
const readline = require('readline');

const app = express();
const PORT = process.env.PORT || 10000; // Renderのデフォルトポートに対応

// 🛑 共通通信タイムアウト（30秒に統一してNode.js v26 / Renderのハングアップを徹底防御）
const TIMEOUT_MS = 30000;

// --- 7大プロバイダーのAPIキーの環境変数ロード ---
const KEYS = {
    openai: process.env.OPENAI_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    cohere: process.env.COHERE_API_KEY,
    mistral: process.env.MISTRAL_API_KEY,
    huggingface: process.env.HUGGING_FACE_API_KEY,
    together: process.env.TOGETHER_API_KEY,
    nhk: process.env.NHK_API_KEY // NHK番組表API Ver.3
};

// --- 🎯 【修正済み】究極のモデルマッピングマトリクス ---
const PROVIDER_MODELS = {
    openai: {
        'lemon-grandpro': 'gpt-4o',
        'lemon-sp': 'gpt-4o-mini',
        'lemon-normal': 'gpt-4o-mini',
        'lemon-lite': 'gpt-4o-mini'
    },
    gemini: {
        'lemon-grandpro': 'gemini-2.5-pro',
        'lemon-sp': 'gemini-2.5-flash',
        'lemon-normal': 'gemini-2.5-flash',
        'lemon-lite': 'gemini-2.5-flash-lite'
    },
    openrouter: {
        'lemon-grandpro': 'meta-llama/llama-3.3-70b-instruct:free',
        'lemon-sp': 'meta-llama/llama-3.1-8b-instant:free',
        'lemon-normal': 'google/gemini-2.5-flash:free',    // 💡 【修正】有料化されたqwenから、確実に動く無料のGemini 2.5に変更
        'lemon-lite': 'meta-llama/llama-3.1-8b-instant:free'
    },
    cohere: {
        'lemon-grandpro': 'command-r-plus-08-2024',
        'lemon-sp': 'command-r-08-2024',
        'lemon-normal': 'command-r-08-2024',
        'lemon-lite': 'command-r-08-2024'
    },
    huggingface: {
        'lemon-grandpro': 'Qwen/Qwen2.5-72B-Instruct',
        'lemon-sp': 'meta-llama/Llama-3.2-3B-Instruct',
        'lemon-normal': 'meta-llama/Llama-3.2-3B-Instruct',
        'lemon-lite': 'meta-llama/Llama-3.2-3B-Instruct'
    }
};

/**
 * HeartRails Express API
 */
async function fetchHeartRailsData(method, params = {}) {
    console.log(`[🚆 HeartRails Express API] メソッド: ${method}, パラメータ:`, params);
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const queryParams = new URLSearchParams({ method, ...params }).toString();
        const url = `http://express.heartrails.com/api/json?${queryParams}`;
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        if (!response.ok) return null;
        const data = await response.json();
        return data.response;
    } catch (e) {
        clearTimeout(id);
        console.error("[❌ HeartRails エラー]", e.message);
        return null;
    }
}

/**
 * NHK 番組表 API Ver.3 連携モジュール
 */
async function fetchNHKProgramGuide(intent) {
    if (!KEYS.nhk) return null;
    const area = intent.area || "130"; 
    const service = intent.service || "g1"; 
    const date = intent.date || new Date().toISOString().split('T')[0];
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        let url = intent.isRadio
            ? (intent.isNow ? `https://program-api.nhk.jp/v3/papiPgNowRadio?service=${service}&area=${area}&key=${KEYS.nhk}` : `https://program-api.nhk.jp/v3/papiPgDateRadio?service=${service}&area=${area}&date=${date}&key=${KEYS.nhk}`)
            : (intent.isNow ? `https://program-api.nhk.jp/v3/papiPgNowTv?service=${service}&area=${area}&key=${KEYS.nhk}` : `https://program-api.nhk.jp/v3/papiPgDateTv?service=${service}&area=${area}&date=${date}&key=${KEYS.nhk}`);

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        if (!response.ok) return null;
        return await response.json();
    } catch (e) {
        clearTimeout(id);
        return null;
    }
}

/**
 * Web検索スクレイパー
 */
async function performWebSearch(query) {
    console.log(`[🔍 検索実行] クエリ: "${query}"`);
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const response = await fetch(searchUrl, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        clearTimeout(id);
        if (!response.ok) return "Web情報を検索できませんでした。";
        const html = await response.text();
        const results = [];
        const regex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        let match;
        while ((match = regex.exec(html)) !== null && results.length < 8) {
            let snippet = match[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
            if (snippet) results.push(`[情報源 ${results.length + 1}]: ${snippet}`);
        }
        return results.length === 0 ? "該当する検索結果が見つかりませんでした。" : results.join("\n\n");
    } catch (e) {
        clearTimeout(id);
        return "検索中にタイムアウトまたは接続エラーが発生しました。";
    }
}

/**
 * AI画像生成エンジン
 */
async function generateAIImage(prompt) {
    console.log(`[🎨 AI画像生成開始] プロンプト: "${prompt}"`);
    if (KEYS.gemini) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${KEYS.gemini}`;
            const response = await fetch(url, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ instances: [{ prompt: prompt }], parameters: { sampleCount: 1, aspectRatio: "1:1", outputMimeType: "image/jpeg" } })
            });
            clearTimeout(id);
            if (response.ok) {
                const result = await response.json();
                const base64Data = result?.predictions?.[0]?.bytesBase64Encoded;
                if (base64Data) return `data:image/jpeg;base64,${base64Data}`;
            }
        } catch (e) { clearTimeout(id); }
    }
    const uniqueSeed = Math.floor(Math.random() * 1000000);
    return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&enhance=true&seed=${uniqueSeed}`;
}

/**
 * サーチグラウンディング
 */
async function processSearchGrounding(messages) {
    const userMessage = messages[messages.length - 1]?.content || "";
    const now = new Date();
    const jstTime = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long' }).format(now);

    let apiContext = `\n[システム情報・コンテキスト]\n- 現在日時 (日本時間/JST): ${jstTime}\n- 現在地: 東京都江東区、日本\n`;

    const hasTriggeredGeneralSearch = ["最新", "ニュース", "今日", "天気", "価格", "株価", "運行", "遅延"].some(kw => userMessage.includes(kw));
    if (hasTriggeredGeneralSearch) {
        const generalSearch = await performWebSearch(userMessage);
        apiContext += `\n- 【最新のリアルタイム検索結果】:\n"""\n${generalSearch}\n"""\n`;
    }

    const groundedMessages = [...messages];
    const systemInstructionIndex = groundedMessages.findIndex(m => m.role === 'system');
    if (systemInstructionIndex !== -1) {
        groundedMessages[systemInstructionIndex].content += "\n" + apiContext;
    } else {
        groundedMessages.unshift({ role: 'system', content: apiContext });
    }
    return groundedMessages;
}

// --- チャットストリーミング中継 ---
app.post('/api/chat', async (req, res) => {
    console.log('\n===================================================');
    console.log('--- [📥 新規チャットリクエスト受信] ---');
    console.log('===================================================');
    
    const { modelKey, messages, temperature, image } = req.body;
    let tempValue = parseFloat(temperature);
    tempValue = isNaN(tempValue) ? 0.7 : Math.max(0.1, Math.min(tempValue, 1.0));

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const userMessage = messages[messages.length - 1]?.content || "";

    // 画像生成インテント検知
    const isImageGen = ["画像を作って", "画像を生成", "イラストを描いて"].some(kw => userMessage.includes(kw));
    if (isImageGen) {
        try {
            const cleanedPrompt = userMessage.replace(/(の画像を生成して|の画像を作って|の絵を描いて|のイラストを作って|画像を生成して|画像を作って|絵を描いて|イラストを描いて)/g, "").trim();
            const imageUrl = await generateAIImage(cleanedPrompt || "A cute red panda");
            res.write(`data: ${JSON.stringify({ text: `🎨 イラストが完成しました！\n\n![Generated Image](${imageUrl})` })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
        } catch (err) {
            res.write(`data: ${JSON.stringify({ error: '画像の生成に失敗しました。' })}\n\n`);
            return res.end();
        }
    }

    // 有効なプロバイダーリストの構築
    const activeProviders = [];
    if (KEYS.openai) activeProviders.push({ name: 'ChatGPT (OpenAI)', type: 'openai', key: KEYS.openai });
    if (KEYS.gemini) activeProviders.push({ name: 'Google Gemini', type: 'gemini', key: KEYS.gemini });
    if (KEYS.openrouter) activeProviders.push({ name: 'OpenRouter (無料枠)', type: 'openrouter', key: KEYS.openrouter });
    if (KEYS.together) activeProviders.push({ name: 'Together AI', type: 'together', key: KEYS.together });
    if (KEYS.cohere) activeProviders.push({ name: 'Cohere AI', type: 'cohere', key: KEYS.cohere });
    if (KEYS.huggingface) activeProviders.push({ name: 'Hugging Face', type: 'huggingface', key: KEYS.huggingface });

    if (activeProviders.length === 0) {
        res.write(`data: ${JSON.stringify({ error: '有効なAPIキーが1つも登録されていません。' })}\n\n`);
        return res.end();
    }

    const groundedMessages = await processSearchGrounding(messages);
    let isSuccess = false;

    for (let i = 0; i < activeProviders.length; i++) {
        const prov = activeProviders[i];
        const targetModel = PROVIDER_MODELS[prov.type]?.[modelKey] || PROVIDER_MODELS[prov.type]?.['lemon-normal'];

        console.log(`\n--- [🔄 試行 ${i + 1}/${activeProviders.length}] プロバイダー: ${prov.name} ---`);
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
            let response;
            let headers = { 'Content-Type': 'application/json' };

            // 🛑 認証ヘッダーの付与漏れを鉄壁ガード
            if (prov.key) {
                if (prov.type === 'cohere') {
                    headers['Authorization'] = `Bearer ${prov.key.trim()}`; // Bearerを明示的に付与
                } else {
                    headers['Authorization'] = `Bearer ${prov.key.trim()}`;
                }
            }

            if (prov.type === 'openai') {
                let requestMessages = groundedMessages.map(m => {
                    if (m.role === 'user' && image && m.content === userMessage) {
                        return { role: 'user', content: [{ type: 'text', text: m.content }, { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } }] };
                    }
                    return m;
                });
                response = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    signal: controller.signal,
                    headers: headers,
                    body: JSON.stringify({ model: targetModel, messages: requestMessages, temperature: tempValue, stream: true })
                });

            } else if (prov.type === 'gemini') {
                const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:streamGenerateContent?key=${prov.key}`;
                const systemMsg = groundedMessages.find(m => m.role === 'system');
                const userAndModelMessages = groundedMessages.map(msg => {
                    const role = msg.role === 'assistant' ? 'model' : 'user';
                    const parts = [{ text: msg.content }];
                    if (msg.role === 'user' && image && msg.content === userMessage) {
                        parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
                    }
                    return { role, parts };
                }).filter(msg => msg.role !== 'system');

                const payload = { contents: userAndModelMessages, generationConfig: { temperature: tempValue } };
                if (systemMsg) payload.systemInstruction = { parts: [{ text: systemMsg.content }] };

                response = await fetch(geminiUrl, {
                    method: 'POST',
                    signal: controller.signal,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

            } else {
                let baseUrl = 'https://openrouter.ai/api/v1/chat/completions';
                if (prov.type === 'together') baseUrl = 'https://api.together.xyz/v1/chat/completions';
                if (prov.type === 'huggingface') baseUrl = 'https://api-inference.huggingface.co/v1/chat/completions';

                response = await fetch(baseUrl, {
                    method: 'POST',
                    signal: controller.signal,
                    headers: headers,
                    body: JSON.stringify({ model: targetModel, messages: groundedMessages, temperature: tempValue, stream: true })
                });
            }

            clearTimeout(id);

            if (!response.ok) {
                let errorDetails = '';
                try { errorDetails = await response.text(); } catch (_) { errorDetails = 'Cannot parse error body'; }
                console.warn(`[⚠️ 警告] ${prov.name} がエラーを返しました。次のプロバイダーに移行します。`);
                console.warn(`👉 [HTTP ${response.status}]: ${errorDetails}\n`);
                continue; 
            }

            const nodeStream = Readable.from(response.body);
            const rl = readline.createInterface({ input: nodeStream, terminal: false });

            for await (const line of rl) {
                const cleanedLine = line.trim();
                if (!cleanedLine) continue;

                if (prov.type === 'gemini') {
                    if (cleanedLine.startsWith('[') || cleanedLine.startsWith(',') || cleanedLine.startsWith(']')) continue;
                    try {
                        const parsed = JSON.parse(cleanedLine.replace(/^,/, ''));
                        const textChunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                        if (textChunk) res.write(`data: ${JSON.stringify({ text: textChunk })}\n\n`);
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
                            if (textChunk) res.write(`data: ${JSON.stringify({ text: textChunk })}\n\n`);
                        } catch (e) {}
                    }
                }
            }

            res.write('data: [DONE]\n\n');
            res.end();
            isSuccess = true;
            break;

        } catch (error) {
            clearTimeout(id);
            console.error(`[❌ 接続失敗] ${prov.name} 例外発生:`, error);
        }
    }

    if (!isSuccess) {
        res.write(`data: ${JSON.stringify({ error: 'すべてのプロバイダーが制限に達したか通信エラーが発生したため、一時的に応答を生成できません。' })}\n\n`);
        res.end();
    }
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// Renderの仕様に100%最適化させた起動設定
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`===================================================`);
    console.log(` Voton Lemon AI (高精細・不死身画像生成版) が起動しました。`);
    console.log(` ポート: ${PORT}`);
    console.log(`===================================================`);
});

// Renderのシグナル終了（デプロイ時の入れ替え）をエレガントにハンドリングしてエラー終了を防ぐ
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});
