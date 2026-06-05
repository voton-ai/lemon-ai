/**
 * Voton Lemon AI - 画像読み込み(マルチモーダル)＆AI画像生成(Imagen4/SDXL/FLUX)対応サーバー (server.js)
 * * [主な改善機能]
 * - ユーザーの「画像を作って」「〇〇を描いて」という指示を自動判別し、極めて親切で暖かみのある言葉遣いで返答。
 * - 万が一、Google/HuggingFace/OpenAIのAPIキーが無い・エラーになった場合でも、
 *   世界最高クラスの完全無料・キー不要の画像生成エンジン「Pollinations AI (FLUX.1ベース)」を稼働。
 *   これにより、いつでも・誰でも・キーなしで最高に美しい画像がその場で確実に生成されます！
 */

const express = require('express');
const path = require('path');
const { Readable } = require('stream');
const readline = require('readline');

const app = express();
const PORT = process.env.PORT || 3000;

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

// JSONのペイロードサイズ制限を画像アップロード用に50MBに緩和
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

// --- 究極のモデルマッピングマトリクス ---
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
        'lemon-normal': 'qwen/qwen-2.5-7b-instruct:free',
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
 * HeartRails Express API (公共交通オープンデータに代わる、キー不要の完全無料鉄道API)
 */
async function fetchHeartRailsData(method, params = {}) {
    console.log(`[🚆 HeartRails Express API] メソッド: ${method}, パラメータ:`, params);
    try {
        const queryParams = new URLSearchParams({ method, ...params }).toString();
        const url = `http://express.heartrails.com/api/json?${queryParams}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        return data.response;
    } catch (e) {
        console.error("[❌ HeartRails エラー]", e);
        return null;
    }
}

/**
 * NHK 番組表 API Ver.3 連携モジュール
 */
async function fetchNHKProgramGuide(intent) {
    if (!KEYS.nhk) {
        console.log("[📺 NHK API] キーが設定されていないため、Web検索によるスケジュール取得にフォールバックします。");
        return null;
    }

    const area = intent.area || "130"; // デフォルト: 東京
    const service = intent.service || "g1"; // デフォルト: NHK総合1
    const date = intent.date || new Date().toISOString().split('T')[0];

    try {
        let url = "";
        if (intent.isRadio) {
            if (intent.isNow) {
                url = `https://program-api.nhk.jp/v3/papiPgNowRadio?service=${service}&area=${area}&key=${KEYS.nhk}`;
            } else {
                url = `https://program-api.nhk.jp/v3/papiPgDateRadio?service=${service}&area=${area}&date=${date}&key=${KEYS.nhk}`;
            }
        } else {
            if (intent.isNow) {
                url = `https://program-api.nhk.jp/v3/papiPgNowTv?service=${service}&area=${area}&key=${KEYS.nhk}`;
            } else {
                url = `https://program-api.nhk.jp/v3/papiPgDateTv?service=${service}&area=${area}&date=${date}&key=${KEYS.nhk}`;
            }
        }

        console.log(`[📺 NHK Ver.3 APIリクエスト] URL: ${url}`);
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`[⚠️ NHK API応答エラー] ステータス: ${response.status}`);
            return null;
        }

        const data = await response.json();
        return data;
    } catch (e) {
        console.error("[❌ NHK API 接続失敗]", e);
        return null;
    }
}

/**
 * Web検索スクレイパー（DuckDuckGo HTML版）
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

        if (!response.ok) return "Web情報を検索できませんでした。";

        const html = await response.text();
        const results = [];
        const regex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        let match;
        
        while ((match = regex.exec(html)) !== null && results.length < 8) {
            let snippet = match[1]
                .replace(/<[^>]*>/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            if (snippet) {
                results.push(`[情報源 ${results.length + 1}]: ${snippet}`);
            }
        }

        return results.length === 0 ? "該当する検索結果が見つかりませんでした。" : results.join("\n\n");
    } catch (e) {
        console.error("[❌ 検索エラー] 検索処理中に例外が発生しました:", e);
        return "検索に失敗しました。";
    }
}

/**
 * AI画像生成エンジン (Google Imagen 4 / Hugging Face SDXL / Pollinations AI 超高度なフェイルオーバー)
 */
async function generateAIImage(prompt) {
    console.log(`[🎨 AI画像生成開始] プロンプト: "${prompt}"`);
    
    // 1. Google Gemini (Imagen 4)
    if (KEYS.gemini) {
        console.log(`[🎨 Imagen 4] Google Cloud Image Generation APIを呼び出します...`);
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${KEYS.gemini}`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    instances: [{ prompt: prompt }],
                    parameters: {
                        sampleCount: 1,
                        aspectRatio: "1:1",
                        outputMimeType: "image/jpeg"
                    }
                })
            });

            if (response.ok) {
                const result = await response.json();
                const base64Data = result?.predictions?.[0]?.bytesBase64Encoded;
                if (base64Data) {
                    console.log(`[🎉 Imagen 4] 画像生成に成功しました。`);
                    return `data:image/jpeg;base64,${base64Data}`;
                }
            } else {
                console.warn(`[⚠️ Imagen 4 失敗] ステータス: ${response.status}. 代替エンジンへ移行します。`);
            }
        } catch (e) {
            console.error(`[❌ Imagen 4 エラー]`, e);
        }
    }

    // 2. Hugging Face (Stable Diffusion XL)
    if (KEYS.huggingface) {
        console.log(`[🎨 SDXL] Hugging Face Inference APIを呼び出します...`);
        try {
            const url = "https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0";
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${KEYS.huggingface}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ inputs: prompt })
            });

            if (response.ok) {
                const buffer = await response.arrayBuffer();
                const base64Data = Buffer.from(buffer).toString('base64');
                console.log(`[🎉 SDXL] 画像生成に成功しました。`);
                return `data:image/jpeg;base64,${base64Data}`;
            } else {
                console.warn(`[⚠️ SDXL 失敗] ステータス: ${response.status}`);
            }
        } catch (e) {
            console.error(`[❌ SDXL エラー]`, e);
        }
    }

    // 3. OpenAI DALL-E-3
    if (KEYS.openai) {
        console.log(`[🎨 DALL-E-3] OpenAI Image Generation APIを呼び出します...`);
        try {
            const response = await fetch('https://api.openai.com/v1/images/generations', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${KEYS.openai}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: "dall-e-3",
                    prompt: prompt,
                    n: 1,
                    size: "1024x1024",
                    response_format: "b64_json"
                })
            });

            if (response.ok) {
                const result = await response.json();
                const base64Data = result?.data?.[0]?.b64_json;
                if (base64Data) {
                    console.log(`[🎉 DALL-E-3] 画像生成に成功しました。`);
                    return `data:image/png;base64,${base64Data}`;
                }
            }
        } catch (e) {
            console.error(`[❌ DALL-E-3 エラー]`, e);
        }
    }

    // 4. 【最強の不死身フェイルオーバー】完全無料・キーレス・高画質な Pollinations AI (FLUX.1)
    console.log(`[🎨 Pollinations AI] 完全無料で最高画質なキーレスエンジン(FLUX)を呼び出します...`);
    const uniqueSeed = Math.floor(Math.random() * 1000000);
    return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&enhance=true&seed=${uniqueSeed}`;
}

/**
 * ユーザーのメッセージを解析し、最適なAPIへディスパッチ（状況データ合体）
 */
async function processSearchGrounding(messages) {
    const userMessage = messages[messages.length - 1]?.content || "";
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

    let apiContext = `
[システム情報・コンテキスト]
- 現在日時 (日本時間/JST): ${jstTime}
- 現在地: 東京都江東区、日本
`;

    // 1. NHK 番組表インテントの解析
    if (userMessage.includes("NHK") || userMessage.includes("番組表") || userMessage.includes("テレビ")) {
        console.log("[💡 NHK番組表インテントを検出]");
        const intent = {
            isRadio: userMessage.includes("ラジオ") || userMessage.includes("AM") || userMessage.includes("FM"),
            isNow: userMessage.includes("今") || userMessage.includes("現在") || userMessage.includes("やってる"),
            service: userMessage.includes("Eテレ") ? "e1" : (userMessage.includes("BS") ? "s1" : "g1"),
            area: "130",
            date: now.toISOString().split('T')[0]
        };

        if (userMessage.includes("横浜") || userMessage.includes("神奈川")) intent.area = "140";
        if (userMessage.includes("大阪")) intent.area = "270";
        if (userMessage.includes("名古屋") || userMessage.includes("愛知")) intent.area = "230";

        const nhkData = await fetchNHKProgramGuide(intent);
        if (nhkData) {
            apiContext += `
- 【NHK公式 番組表API Ver.3 リアルタイム取得データ】:
"""
${JSON.stringify(nhkData, null, 2)}
"""
※上記の公式データに基づいて、放送中の番組名、概要、時間をユーザーに分かりやすく紹介してください。
`;
        } else {
            const searchResults = await performWebSearch(`${intent.service === 'e1' ? 'Eテレ' : 'NHK'} ${intent.isNow ? '今やってる番組 放送中' : '今日の番組表 テレビ番組スケジュール'}`);
            apiContext += `
- 【最新のNHK番組スケジュール (Web検索による補完情報)】:
"""
${searchResults}
"""
`;
        }
    }

    // 2. 路線・駅名インテントの解析（HeartRails Express API 連携）
    if (userMessage.includes("駅") || userMessage.includes("路線") || userMessage.includes("地下鉄") || userMessage.includes("何線")) {
        console.log("[💡 鉄道・駅名インテントを検出]");
        let heartRailsResult = null;
        if (userMessage.includes("線") && !userMessage.includes("近くの駅")) {
            const lineMatch = userMessage.match(/([A-Zァ-ヶ一-龠]+線)/);
            if (lineMatch) {
                const lineName = lineMatch[1];
                heartRailsResult = await fetchHeartRailsData("getStations", { line: lineName });
            }
        } else if (userMessage.includes("近く") || userMessage.includes("最寄")) {
            heartRailsResult = await fetchHeartRailsData("getStations", { x: "139.7961", y: "35.6548" }); // 豊洲駅付近
        }

        if (heartRailsResult) {
            apiContext += `
- 【HeartRails Express 鉄道APIによる正確な駅・路線マッピング】:
"""
${JSON.stringify(heartRailsResult.station || heartRailsResult, null, 2)}
"""
`;
        }
    }

    // 3. 電車の遅延・運行状況インテント
    if (userMessage.includes("遅延") || userMessage.includes("運行情報") || userMessage.includes("遅れてる") || userMessage.includes("見合わせ") || userMessage.includes("電車")) {
        console.log("[💡 電車運行情報インテントを検出]");
        const delaySearch = await performWebSearch(userMessage + " 運行情報 遅延 運転見合わせ Yahoo路線情報");
        apiContext += `
- 【現在のリアルタイム電車運行・遅延情報 (Yahoo!路線・SNS調べ)】:
"""
${delaySearch}
"""
`;
    }

    // 4. 地図インテント
    if (userMessage.includes("地図") || userMessage.includes("マップ") || userMessage.includes("場所") || userMessage.includes("どこ")) {
        console.log("[💡 地図インテントを検出]");
        const placeMatch = userMessage.replace(/(の地図|のマップ|を見せて|はどこ|地図|マップ)/g, "").trim();
        if (placeMatch.length > 1) {
            try {
                const mapResponse = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(placeMatch)}&format=json&limit=1`, {
                    headers: { 'User-Agent': 'VotonLemonAI/1.2.0' }
                });
                if (mapResponse.ok) {
                    const mapData = await mapResponse.json();
                    if (mapData && mapData[0]) {
                        const lat = mapData[0].lat;
                        const lon = mapData[0].lon;
                        apiContext += `
- 【OpenStreetMap 地図情報】:
- 対象地名: ${placeMatch}
- 緯度: ${lat}
- 経度: ${lon}

回答に以下の埋め込みマップを必ず含めてください:
<iframe src="https://maps.google.com/maps?q=${lat},${lon}&z=15&output=embed" width="100%" height="320" style="border:0; border-radius: 12px; margin: 12px 0;" allowfullscreen="" loading="lazy"></iframe>
`;
                    }
                }
            } catch (e) {
                console.error("[❌ 地図検索失敗]", e);
            }
        }
    }

    // 5. 郵便番号・住所検索
    if (userMessage.includes("郵便番号") || userMessage.match(/\d{3}-\d{4}/) || userMessage.match(/\d{7}/)) {
        console.log("[💡 郵便番号インテントを検出]");
        const zipMatch = userMessage.match(/\d{3}-\d{4}/) || userMessage.match(/\d{7}/) || [null];
        const zipCode = zipMatch[0] ? zipMatch[0].replace("-", "") : null;
        if (zipCode) {
            try {
                const zipResponse = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${zipCode}`);
                if (zipResponse.ok) {
                    const zipData = await zipResponse.json();
                    apiContext += `
- 【Zipcloud 郵便番号住所データ】:
"""
${JSON.stringify(zipData, null, 2)}
"""
`;
                }
            } catch (e) {
                console.error("[❌ 郵便番号検索失敗]", e);
            }
        }
    }

    // 通常のリアルタイム検索フォールバック
    const hasTriggeredGeneralSearch = ["最新", "ニュース", "今日", "天気", "価格", "株価", "Qiita", "書籍", "本", "トレンド"].some(kw => userMessage.includes(kw));
    if (hasTriggeredGeneralSearch && !apiContext.includes("最新の")) {
        const generalSearch = await performWebSearch(userMessage);
        apiContext += `
- 【最新のリアルタイム検索結果（事実・状況データ）】:
"""
${generalSearch}
"""
`;
    }

    apiContext += `
【最重要ノイズ排除＆書き換え指示】
提供された生データを「そのままコピペ」してはいけません。
1. 宣伝や余計な自己紹介などのノイズは完全に消去してください。
2. 機械的な「情報源によると」といったお役所表現を廃止し、あなた自身が優しく丁寧に解説するように一つの極めてなめらかな日本語に翻訳・リライトして回答してください。
`;

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

    // 💡 A. 画像生成インテントを検出した場合の特別処理
    const isImageGenerationIntent = ["画像を作って", "画像を生成", "イラストを描いて", "の絵を描いて", "のイラストを作って", "の画像を描いて", "draw a picture of", "generate an image of"].some(kw => userMessage.includes(kw));
    if (isImageGenerationIntent) {
        console.log("[💡 画像生成インテントを検知しました]");
        try {
            // プロンプトの抽出（末尾トリガーを削除）
            const cleanedPrompt = userMessage.replace(/(の画像を生成して|の画像を作って|の絵を描いて|のイラストを作って|画像を生成して|画像を作って|絵を描いて|イラストを描いて)/g, "").trim();
            const imageUrl = await generateAIImage(cleanedPrompt || "A cute red panda in a forest, high quality");
            
            // ユーザーに寄り添った、あたたかみのある親切なメッセージを動的に作成
            const chatReplies = [
                `🎨 リクエストいただいた「${cleanedPrompt || "レッサーパンダ"}」のイメージを描いてみました！いかがでしょうか？ふんわりと愛らしく仕上げました。お気に召すと嬉しいです！✨\n\n![Generated Image](${imageUrl})`,
                `🍀 お待たせしました！「${cleanedPrompt || "レッサーパンダ"}」の素敵なイラストが完成しました。細部まで丁寧に仕上げています。どうぞお楽しみくださいね！🖌️\n\n![Generated Image](${imageUrl})`,
                `✨ ご要望の「${cleanedPrompt || "レッサーパンダ"}」を表現したアートです！あなたの頭の中のイメージ通りに描けていますでしょうか？ぜひ可愛がってあげてください！🎀\n\n![Generated Image](${imageUrl})`
            ];
            const textResponse = chatReplies[Math.floor(Math.random() * chatReplies.length)];

            res.write(`data: ${JSON.stringify({ text: textResponse })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
        } catch (err) {
            console.error("[❌ 画像生成エラー]", err);
            res.write(`data: ${JSON.stringify({ error: '画像の生成に失敗しました。' })}\n\n`);
            return res.end();
        }
    }

    // B. 通常のテキスト（およびマルチモーダル画像理解）チャット処理
    const activeProviders = [];
    if (KEYS.openai) activeProviders.push({ name: 'ChatGPT (OpenAI)', type: 'openai', key: KEYS.openai });
    if (KEYS.gemini) activeProviders.push({ name: 'Google Gemini', type: 'gemini', key: KEYS.gemini });
    if (KEYS.openrouter) activeProviders.push({ name: 'OpenRouter (無料枠)', type: 'openrouter', key: KEYS.openrouter });
    if (KEYS.together) activeProviders.push({ name: 'Together AI', type: 'together', key: KEYS.together });
    if (KEYS.cohere) activeProviders.push({ name: 'Cohere AI', type: 'cohere', key: KEYS.cohere });
    if (KEYS.huggingface) activeProviders.push({ name: 'Hugging Face', type: 'huggingface', key: KEYS.huggingface });

    if (activeProviders.length === 0) {
        res.write(`data: ${JSON.stringify({ error: 'サーバーに有効なAPIキーが1つも登録されていません。' })}\n\n`);
        return res.end();
    }

    const groundedMessages = await processSearchGrounding(messages);
    let isSuccess = false;

    for (let i = 0; i < activeProviders.length; i++) {
        const prov = activeProviders[i];
        const targetModel = PROVIDER_MODELS[prov.type]?.[modelKey] || PROVIDER_MODELS[prov.type]?.['lemon-normal'] || 'gpt-4o-mini';

        console.log(`\n--- [🔄 試行 ${i + 1}/${activeProviders.length}] プロバイダー: ${prov.name} ---`);
        try {
            let response;

            if (prov.type === 'openai') {
                let requestMessages = groundedMessages.map(m => {
                    if (m.role === 'user' && image && m.content === userMessage) {
                        return {
                            role: 'user',
                            content: [
                                { type: 'text', text: m.content },
                                { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } }
                            ]
                        };
                    }
                    return m;
                });

                response = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${prov.key}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: targetModel,
                        messages: requestMessages,
                        temperature: tempValue,
                        stream: true
                    })
                });

            } else if (prov.type === 'gemini') {
                const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:streamGenerateContent?key=${prov.key}`;
                const systemMsg = groundedMessages.find(m => m.role === 'system');
                
                const userAndModelMessages = groundedMessages.map(msg => {
                    const role = msg.role === 'assistant' ? 'model' : 'user';
                    const parts = [{ text: msg.content }];
                    
                    if (msg.role === 'user' && image && msg.content === userMessage) {
                        parts.push({
                            inlineData: {
                                mimeType: image.mimeType,
                                data: image.data
                            }
                        });
                    }

                    return { role, parts };
                }).filter(msg => msg.role !== 'system');

                const payload = {
                    contents: userAndModelMessages,
                    generationConfig: { temperature: tempValue }
                };

                if (systemMsg) {
                    payload.systemInstruction = { parts: [{ text: systemMsg.content }] };
                }

                response = await fetch(geminiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

            } else {
                let baseUrl = 'https://openrouter.ai/api/v1/chat/completions';
                if (prov.type === 'together') baseUrl = 'https://api.together.xyz/v1/chat/completions';
                if (prov.type === 'huggingface') baseUrl = 'https://api-inference.huggingface.co/v1/chat/completions';

                response = await fetch(baseUrl, {
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
            }

            if (!response.ok) {
                console.warn(`[⚠️ 警告] ${prov.name} がエラーを返しました。次のプロバイダーに移行します。`);
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
                        if (textChunk) {
                            res.write(`data: ${JSON.stringify({ text: textChunk })}\n\n`);
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
                                res.write(`data: ${JSON.stringify({ text: textChunk })}\n\n`);
                            }
                        } catch (e) {}
                    }
                }
            }

            res.write('data: [DONE]\n\n');
            res.end();
            isSuccess = true;
            break;

        } catch (error) {
            console.error(`[❌ 接続失敗] ${prov.name} 例外発生:`, error);
        }
    }

    if (!isSuccess) {
        res.write(`data: ${JSON.stringify({ error: 'すべてのプロバイダーが制限に達したため、一時的に通信できません。' })}\n\n`);
        res.end();
    }
});

// メインページの配信
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(` Voton Lemon AI (高精細・不死身画像生成版) が起動しました。`);
    console.log(` ポート: ${PORT}`);
    console.log(`===================================================`);
});
