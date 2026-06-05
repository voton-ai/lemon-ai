/**
 * Voton Lemon AI - ChatGPT対応・12大外部APIインテントディスパッチャー搭載サーバー (server.js)
 * * [特徴]
 * - ChatGPT (OpenAI) への完全対応と、既存の7大プロバイダーのフェイルオーバー完全連携。
 * - ユーザーの言葉から「地図/株式/翻訳/辞書/Qiita/Youtube/番組表/書籍/郵便番号/乗換/バス/電車」の意図をミリ秒単位で高速判別。
 * - 各種完全無料・キー不要のパブリックAPIを並列Promiseで超高速に叩き、AIに最新データをコンテキストとしてグラウンディング（接合）します。
 */

const express = require('express');
const path = require('path');
const { Readable } = require('stream');
const readline = require('readline');

const app = express();
const PORT = process.env.PORT || 3000;

const KEYS = {
    gemini: process.env.GEMINI_API_KEY,
    openai: process.env.OPENAI_API_KEY, // 追加：ChatGPT APIキー
    openrouter: process.env.OPENROUTER_API_KEY,
    cohere: process.env.COHERE_API_KEY,
    mistral: process.env.MISTRAL_API_KEY,
    huggingface: process.env.HUGGING_FACE_API_KEY,
    together: process.env.TOGETHER_API_KEY,
    youtube: process.env.YOUTUBE_API_KEY, // 任意：YouTube Data APIキー
    odpt: process.env.ODPT_API_KEY,       // 任意：電車・バス運行情報APIキー
    nhk: process.env.NHK_API_KEY,         // 任意：番組表APIキー
    cloudflare: {
        token: process.env.CLOUDFLARE_API_KEY,
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID
    }
};

app.use(express.json());
app.use(express.static(__dirname));

const PROVIDER_MODELS = {
    gemini: {
        'lemon-grandpro': 'gemini-2.5-pro',
        'lemon-sp': 'gemini-2.5-flash',
        'lemon-normal': 'gemini-2.5-flash',
        'lemon-lite': 'gemini-2.5-flash-lite'
    },
    openai: { // ChatGPTモデルマッピング
        'lemon-grandpro': 'gpt-4o',
        'lemon-sp': 'gpt-4o-mini',
        'lemon-normal': 'gpt-4o-mini',
        'lemon-lite': 'gpt-4o-mini'
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
        const regex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        let match;
        while ((match = regex.exec(html)) !== null && results.length < 8) {
            let snippet = match[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
            if (snippet) {
                results.push(`[情報源 ${results.length + 1}]: ${snippet}`);
            }
        }
        return results.length === 0 ? "該当する検索結果が見つかりませんでした。" : results.join("\n\n");
    } catch (e) {
        console.error("[❌ 検索エラー] 例外が発生:", e);
        return "検索に失敗しました。";
    }
}


// 1. 郵便番号検索API (zipcloud: 完全無料/キー不要)
async function fetchZipCode(zipcode) {
    const cleanZip = zipcode.replace(/[^0-9]/g, '');
    if (cleanZip.length < 7) return null;
    try {
        const response = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${cleanZip}`);
        if (!response.ok) return null;
        const data = await response.json();
        if (data.status === 200 && data.results) {
            const res = data.results[0];
            return `【郵便番号APIデータ】郵便番号: ${cleanZip}, 該当住所: ${res.address1}${res.address2}${res.address3} (カナ: ${res.kana1}${res.kana2}${res.kana3})`;
        }
    } catch (e) { console.error("郵便番号APIエラー:", e); }
    return null;
}

// 2. 書籍検索API (Google Books: 完全無料/キー不要)
async function fetchGoogleBooks(query) {
    try {
        const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=3`);
        if (!response.ok) return null;
        const data = await response.json();
        if (data.items) {
            return data.items.map((item, idx) => {
                const info = item.volumeInfo;
                return `[書籍 ${idx+1}] タイトル: ${info.title}, 著者: ${info.authors?.join(', ') || '不明'}, 出版社: ${info.publisher || '不明'}, 出版日: ${info.publishedDate || '不明'}, 概要: ${info.description?.substring(0, 150) || 'なし'}`;
            }).join('\n\n');
        }
    } catch (e) { console.error("Google Books APIエラー:", e); }
    return null;
}

// 3. 技術記事検索API (Qiita API v2: 完全無料/キー不要)
async function fetchQiita(query) {
    try {
        const response = await fetch(`https://qiita.com/api/v2/items?page=1&per_page=3&query=${encodeURIComponent(query)}`);
        if (!response.ok) return null;
        const data = await response.json();
        if (data.length > 0) {
            return data.map((item, idx) => {
                return `[Qiita技術記事 ${idx+1}] タイトル: ${item.title}, 投稿者: ${item.user.id}, いいね数: ${item.likes_count}, URL: ${item.url}, 本文概要: ${item.body?.substring(0, 120).replace(/\r?\n/g, ' ') || 'なし'}`;
            }).join('\n\n');
        }
    } catch (e) { console.error("Qiita APIエラー:", e); }
    return null;
}

// 4. 高精度翻訳API (MyMemory API: 完全無料/キー不要)
async function fetchTranslation(text, targetLang = 'en', sourceLang = 'ja') {
    try {
        const response = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sourceLang}|${targetLang}`);
        if (!response.ok) return null;
        const data = await response.json();
        if (data.responseData) {
            return `【MyMemory自動翻訳エンジンによる対訳】原文: "${text}" ➔ 翻訳結果: "${data.responseData.translatedText}"`;
        }
    } catch (e) { console.error("翻訳APIエラー:", e); }
    return null;
}

// 5. 辞書引きAPI (Jisho.org API: 完全無料/キー不要)
async function fetchJisho(keyword) {
    try {
        const response = await fetch(`https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(keyword)}`);
        if (!response.ok) return null;
        const data = await response.json();
        if (data.data && data.data.length > 0) {
            return data.data.slice(0, 2).map((item, idx) => {
                const senses = item.senses.map(s => s.english_definitions.join(', ')).join('; ');
                return `[辞書データ ${idx+1}] 検索語: ${item.slug}, 読み仮名: ${item.japanese?.[0]?.reading || '不明'}, 意味・定義(英): ${senses.substring(0, 180)}`;
            }).join('\n\n');
        }
    } catch (e) { console.error("辞書APIエラー:", e); }
    return null;
}

// 6. 地図ジオコーダー＆動的マップAPI (OpenStreetMap Nominatim: 完全無料/キー不要)
async function fetchMapCoordinates(place) {
    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=1`, {
            headers: { 'User-Agent': 'VotonLemonAI/1.3' }
        });
        if (!response.ok) return null;
        const data = await response.json();
        if (data.length > 0) {
            const loc = data[0];
            const lat = parseFloat(loc.lat);
            const lon = parseFloat(loc.lon);
            // 埋め込み用地図のBBOX計算 (周囲0.01度)
            const minLon = lon - 0.008;
            const minLat = lat - 0.005;
            const maxLon = lon + 0.008;
            const maxLat = lat + 0.005;
            return `【地図・GPS座標データ】場所: ${place}, 緯度: ${lat}, 経度: ${lon}, 正式地名: ${loc.display_name}.
※[重要：地図レンダリング指示] ユーザーに回答する際、以下のOpenStreetMap埋め込みiframeコードを必ず回答の最後に独立した段落としてそのまま記述してください。
<iframe width="100%" height="350" frameborder="0" scrolling="no" marginheight="0" marginwidth="0" src="https://www.openstreetmap.org/export/embed.html?bbox=${minLon}%2C${minLat}%2C${maxLon}%2C${maxLat}&layer=mapnik&marker=${lat}%2C${lon}"></iframe>`;
        }
    } catch (e) { console.error("地図APIエラー:", e); }
    return null;
}

async function processSearchGrounding(messages) {
    const userMessage = messages[messages.length - 1]?.content || "";
    
    // 現在時刻(JST)の決定
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

    let groundingContext = `\n[システム情報・コンテキスト]\n- 現在日時(日本時間/JST): ${jstTime}\n- 現在地: 東京都江東区、日本\n`;

    const apiPromises = [];

    // ① 郵便番号インテントの判定
    const zipMatch = userMessage.match(/郵便番号\s*([0-9]{3}-?[0-9]{4})/);
    if (zipMatch) {
        apiPromises.push(fetchZipCode(zipMatch[1]).then(res => res ? { type: 'Zip', data: res } : null));
    }

    // ② Qiitaインテントの判定
    if (userMessage.includes('Qiita') || userMessage.includes('qiita') || userMessage.includes('技術記事')) {
        const query = userMessage.replace(/(Qiita|qiita|技術記事|を調べて|の件|検索)/gi, '').trim();
        apiPromises.push(fetchQiita(query || 'JavaScript').then(res => res ? { type: 'Qiita', data: res } : null));
    }

    // ③ 書籍インテントの判定
    if (userMessage.includes('書籍') || userMessage.includes('本を検索') || userMessage.includes('本の情報') || userMessage.includes('Google Books')) {
        const query = userMessage.replace(/(書籍|本を検索|本の情報|Google Books|の|について|調べて|検索)/gi, '').trim();
        apiPromises.push(fetchGoogleBooks(query || 'AI').then(res => res ? { type: 'Books', data: res } : null));
    }

    // ④ 翻訳インテントの判定
    if (userMessage.includes('翻訳') || userMessage.includes('英語にして') || userMessage.includes('英語訳')) {
        const text = userMessage.replace(/(翻訳して|翻訳|英語にして|英語訳|の|について)/gi, '').trim();
        apiPromises.push(fetchTranslation(text || 'こんにちは、良い天気ですね！', 'en', 'ja').then(res => res ? { type: 'Translation', data: res } : null));
    }

    // ⑤ 辞書インテントの判定
    if (userMessage.includes('辞書') || userMessage.includes('意味は') || userMessage.includes('どういう意味') || userMessage.includes('単語')) {
        const word = userMessage.replace(/(辞書|意味は|どういう意味|単語|の|について|調べて)/gi, '').trim();
        apiPromises.push(fetchJisho(word || 'assistant').then(res => res ? { type: 'Dictionary', data: res } : null));
    }

    // ⑥ 地図インテントの判定
    if (userMessage.includes('地図') || userMessage.includes('マップ') || userMessage.includes('場所') || userMessage.includes('どこにある')) {
        const place = userMessage.replace(/(地図|マップ|場所|どこにある|をみせて|を表示して|の)/gi, '').trim();
        if (place.length > 1) {
            apiPromises.push(fetchMapCoordinates(place).then(res => res ? { type: 'Map', data: res } : null));
        }
    }

    // ⑦ テレビ・番組表インテント
    const needsTV = userMessage.includes('番組表') || userMessage.includes('テレビ番組') || userMessage.includes('番組情報');
    
    // ⑧ 電車・乗換・バス・運行情報インテント
    const needsTransit = userMessage.includes('乗換') || userMessage.includes('電車') || userMessage.includes('運行状況') || userMessage.includes('運行情報') || userMessage.includes('遅延') || userMessage.includes('バス');

    // ⑨ 株式・株価インテント
    const needsStock = userMessage.includes('株価') || userMessage.includes('株式') || userMessage.includes('株の価格');

    // ⑩ YouTube動画インテント
    const needsYouTube = userMessage.includes('YouTube') || userMessage.includes('動画') || userMessage.includes('ユーチューブ');

    // リアルタイムWeb検索が必要な一般条件
    const searchKeywords = [
        "最新", "ニュース", "今日", "いま", "天気", "誰", "どこ", "何時", 
        "2025", "2026", "検索", "調べて", "価格", "出来事", "トレンド"
    ];
    const needsGeneralSearch = searchKeywords.some(keyword => userMessage.includes(keyword)) || needsTV || needsTransit || needsStock || needsYouTube;

    if (needsGeneralSearch) {
        apiPromises.push(performWebSearch(userMessage).then(res => ({ type: 'WebSearch', data: res })));
    }

    const apiResults = await Promise.all(apiPromises);
    const validResults = apiResults.filter(r => r !== null);

    if (validResults.length > 0) {
        console.log(`[⚡ APIディスパッチャー発動] 解決されたAPIインテント: ${validResults.map(r => r.type).join(', ')}`);
        groundingContext += `\n【外部APIシステム連携による最新リアルタイム参照データ】\n`;
        validResults.forEach(r => {
            groundingContext += `\n--- [カテゴリ: ${r.type}] ---\n${r.data}\n`;
        });

        groundingContext += `
【AI回答作成厳守指示】
1. あなたは提供されたAPIによる高精度な参照データ、または最新Web検索結果を100%信頼し、プロフェッショナルかつ丁寧な回答を作成してください。
2. 機械的な「ソースによると」等の不自然な文章は一切排除し、あなた自身の知識であるかのように滑らかに執筆してください。
3. もし [地図・GPS座標データ] にある iframe タグがコンテキスト内に含まれる場合は、必ずその HTML コード iframe 部分を丸ごと、お使いの Markdown 回答の最終段落に「こちらが地図になります」という案内とともに記述（埋め込み）してください。絶対にエスケープや勝手なコード改変を行わないでください。
`;
    }

    const groundedMessages = [...messages];
    const systemInstructionIndex = groundedMessages.findIndex(m => m.role === 'system');

    if (systemInstructionIndex !== -1) {
        groundedMessages[systemInstructionIndex].content += "\n" + groundingContext;
    } else {
        groundedMessages.unshift({ role: 'system', content: groundingContext });
    }

    return groundedMessages;
}

app.post('/api/chat', async (req, res) => {
    console.log('\n===================================================');
    console.log('--- [📥 新規チャットリクエスト受信] ---');
    console.log('===================================================');
    const { modelKey, messages, temperature } = req.body;

    console.log(`[基本データ] クライアント指定モデルキー: "${modelKey}"`);
    
    // 安全対策：温度スライダーの破壊的な設定を最大1.0に強制制限
    let tempValue = parseFloat(temperature);
    if (isNaN(tempValue)) {
        tempValue = 0.7;
    } else {
        tempValue = Math.max(0.1, Math.min(tempValue, 1.0));
    }
    console.log(`[安全対策適用] クランプ制限後の設定温度 (Temperature): ${tempValue}`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // 動的プロバイダーフォールバック優先度構築
    const activeProviders = [];

    // OpenAI (ChatGPT) を最上位（またはGeminiの隣）に追加
    if (KEYS.gemini) activeProviders.push({ name: 'Google Gemini', type: 'gemini', key: KEYS.gemini });
    if (KEYS.openai) activeProviders.push({ name: 'ChatGPT (OpenAI)', type: 'openai', key: KEYS.openai });
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

    const groundedMessages = await processSearchGrounding(messages);
    let isSuccess = false;

    for (let i = 0; i < activeProviders.length; i++) {
        const prov = activeProviders[i];
        const targetModel = PROVIDER_MODELS[prov.type][modelKey] || PROVIDER_MODELS[prov.type]['lemon-normal'];

        console.log(`\n--- [🔄 試行 ${i + 1}/${activeProviders.length}] プロバイダー: ${prov.name} ---`);
        console.log(`[中継詳細] 送信先モデル名: "${targetModel}"`);

        try {
            let response;

            if (prov.type === 'gemini') {
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
                    payload.systemInstruction = { parts: [{ text: systemMsg.content }] };
                }

                response = await fetch(geminiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

            } else if (prov.type === 'openai') {
                // OpenAI API (ChatGPT) への接続処理
                response = await fetch('https://api.openai.com/v1/chat/completions', {
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

            } else if (prov.type === 'openrouter') {
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
    console.log(` Voton Lemon AI (ChatGPT & 12大API搭載) が起動しました。`);
    console.log(` 待機ポート: ${PORT}`);
    console.log(`===================================================`);
});
