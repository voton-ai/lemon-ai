/**
 * Voton Lemon AI - 外部公開用 サーバー & クライアント一体型アプリケーション
 * [特徴]
 * 1. レモンをモチーフにした爽やかでモダンなイエロー＆アンバーデザイン。
 * 2. ユーザーがその場でAIの「性格(システムプロンプト)」や「自由度(温度設定)」をカスタマイズ可能。
 * 3. 超高速な無料AIクラウド「Groq API」から、賢さ・速度の異なる4つの独自モデルをワンタップ切り替え。
 * 4. 初回訪問時のみ自動起動する「インタラクティブ・スポットライト・チュートリアル」を完備。
 * 5. 【NEW】ライト/ダークモード搭載。
 * 6. 【NEW】スマホ/PC完全対応の履歴復元（モバイルタップ時自動サイドバー閉じ）。
 * 7. 【NEW】履歴を一切保存しない「プライベートモード」を搭載。
 */

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Groq APIキー（Renderの環境変数から安全に読み込みます）
const GROQ_API_KEY = process.env.GROQ_API_KEY; 

app.use(express.json());

// 簡易的な負荷制限（同一IPからの過剰アクセス対策：1分間に30回まで）
const ipRequestCounts = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_REQUESTS = 30;

function rateLimiter(req, res, next) {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const currentTime = Date.now();
    
    if (!ipRequestCounts.has(ip)) {
        ipRequestCounts.set(ip, []);
    }
    
    const timestamps = ipRequestCounts.get(ip).filter(t => currentTime - t < RATE_LIMIT_WINDOW);
    timestamps.push(currentTime);
    ipRequestCounts.set(ip, timestamps);
    
    if (timestamps.length > MAX_REQUESTS) {
        return res.status(429).json({ error: '少し時間を置いてから再度お試しください。' });
    }
    next();
}

// 独自モデルのマッピング定義
const MODEL_MAP = {
    'grandpro': {
        apiName: 'llama-3.3-70b-versatile',
        displayName: 'Lemon AI GrandPro',
        speed: '★★☆☆☆ (やや遅め)',
        smart: '★★★★★ (最強脳)',
        desc: '超複雑な推論、プログラムの設計、長文の分析などに特化した最高峰モデル。'
    },
    'sp': {
        apiName: 'qwen/qwen3-32b',
        displayName: 'Lemon AI SP',
        speed: '★★★☆☆ (普通)',
        smart: '★★★★☆ (極めて優秀)',
        desc: '日本語の対応力が非常に高く、小説の執筆、議論、高度な学習アシスタント向け。'
    },
    'regular': {
        apiName: 'gemma2-9b-it',
        displayName: 'Lemon AI',
        speed: '★★★★☆ (高速)',
        smart: '★★★☆☆ (バランス良好)',
        desc: 'Googleの高性能モデル。表現力が豊かで、日常会話やアイデア出しに最適。'
    },
    'lite': {
        apiName: 'llama-3.1-8b-instant',
        displayName: 'Lemon AI Lite',
        speed: '★★★★★ (異次元の爆速)',
        smart: '★★☆☆☆ (シンプル回答)',
        desc: '応答スピードを最優先したライトモデル。ちょっとした調べ物や数行の翻訳向け。'
    }
};

// サーバー情報の返却
app.get('/api/server-info', (req, res) => {
    res.json({
        status: GROQ_API_KEY ? 'online' : 'APIキーが未設定です。サーバーの設定を確認してください。',
        defaultModel: 'regular',
        models: MODEL_MAP
    });
});

// チャットストリーミング中継処理
app.post('/api/chat', rateLimiter, async (req, res) => {
    const { messages, systemPrompt, temperature, modelKey } = req.body;
    
    if (!GROQ_API_KEY) {
        return res.status(500).json({ error: 'サーバーにGROQ_API_KEYが設定されていません。' });
    }

    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: '無効なリクエストです。' });
    }

    const activeModelConfig = MODEL_MAP[modelKey] || MODEL_MAP['regular'];
    const targetModelName = activeModelConfig.apiName;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const finalMessages = [];
    if (systemPrompt && systemPrompt.trim() !== '') {
        finalMessages.push({ role: 'system', content: systemPrompt });
    }
    finalMessages.push(...messages);

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: targetModelName,
                messages: finalMessages,
                temperature: temperature !== undefined ? Number(temperature) : 0.7,
                stream: true
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            res.write(`data: ${JSON.stringify({ error: `Groqエラー: ${errText}` })}\n\n`);
            return res.end();
        }

        const reader = response.body;
        if (!reader) {
            throw new Error('ストリームの取得に失敗しました。');
        }

        for await (const chunk of reader) {
            const text = chunk.toString();
            const lines = text.split('\n');
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const dataStr = line.slice(6).trim();
                    if (dataStr === '[DONE]') {
                        continue;
                    }
                    try {
                        const parsed = JSON.parse(dataStr);
                        const content = parsed.choices[0]?.delta?.content || '';
                        if (content) {
                            res.write(`data: ${JSON.stringify({ message: { content: content } })}\n\n`);
                        }
                    } catch (e) {
                        // パケット分割対策
                    }
                }
            }
        }
        res.end();

    } catch (error) {
        console.error('API通信エラー:', error);
        res.write(`data: ${JSON.stringify({ error: 'AIサーバーとの通信中にエラーが発生しました。' })}\n\n`);
        res.end();
    }
});

// フロントエンドのHTMLを配信
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ja" class="h-full dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Voton Lemon AI - カスタム＆高性能無料AIチャット</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        // Tailwindのダークモードをクラス制御に設定
        tailwind.config = {
            darkMode: 'class'
        }
    </script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <style>
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(234, 179, 8, 0.3); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(234, 179, 8, 0.5); }
        
        /* スポットライトエフェクト */
        .spotlight-active {
            position: relative !important;
            z-index: 50 !important;
            box-shadow: 0 0 0 9999px rgba(2, 6, 23, 0.85), 0 0 20px 5px rgba(234, 179, 8, 0.5) !important;
            pointer-events: none !important;
            border-color: rgba(234, 179, 8, 0.8) !important;
        }
    </style>
</head>
<body class="h-full bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 flex flex-col font-sans overflow-hidden transition-colors duration-200">

    <!-- メインレイアウト -->
    <div class="flex h-full w-full overflow-hidden">
        
        <!-- サイドバー -->
        <aside id="sidebar" class="fixed inset-y-0 left-0 z-40 w-80 transform -translate-x-full md:translate-x-0 transition-transform duration-300 ease-in-out bg-slate-100 dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col shadow-xl md:shadow-none">
            <!-- タイトルロゴ -->
            <div class="p-4 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center bg-slate-200/40 dark:bg-slate-950/40">
                <div class="flex items-center space-x-2">
                    <span class="p-2 bg-gradient-to-tr from-yellow-500 to-amber-500 rounded-lg text-slate-950 shadow-md">
                        <i data-lucide="citrus" class="w-5 h-5"></i>
                    </span>
                    <span class="font-extrabold text-lg bg-gradient-to-r from-yellow-500 to-amber-500 dark:from-yellow-400 dark:to-amber-300 bg-clip-text text-transparent tracking-wide">Voton Lemon AI</span>
                </div>
                <button onclick="toggleSidebar()" class="md:hidden p-1 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white rounded">
                    <i data-lucide="x" class="w-5 h-5"></i>
                </button>
            </div>

            <!-- 新規チャット作成 -->
            <div class="p-4 border-b border-slate-200 dark:border-slate-800/50">
                <button onclick="createNewChat()" class="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-gradient-to-r from-yellow-500 to-amber-500 hover:from-yellow-400 hover:to-amber-400 text-slate-950 rounded-lg font-bold transition-all duration-200 shadow-lg shadow-yellow-900/10">
                    <i data-lucide="plus-circle" class="w-4 h-4"></i>
                    新規スレッドを作成
                </button>
            </div>

            <!-- プライベートモード切り替えトグル (NEW) -->
            <div class="p-4 border-b border-slate-200 dark:border-slate-800/50 flex justify-between items-center bg-slate-200/20 dark:bg-slate-950/20">
                <span class="text-xs font-bold text-slate-500 dark:text-slate-400 flex items-center gap-1.5 uppercase tracking-wider">
                    <i data-lucide="eye-off" class="w-4 h-4 text-purple-500"></i>
                    プライベートモード
                </span>
                <button onclick="togglePrivateMode()" id="private-toggle-btn" class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none bg-slate-300 dark:bg-slate-700">
                    <span id="private-toggle-dot" class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out translate-x-0"></span>
                </button>
            </div>

            <!-- カスタマイズパネル (このチャット専用) -->
            <div id="tutorial-step-customize" class="p-4 border-b border-slate-200 dark:border-slate-800/80 bg-slate-200/10 dark:bg-slate-950/20 space-y-4">
                <div class="text-xs font-bold text-yellow-600 dark:text-yellow-400 flex items-center gap-1.5 uppercase tracking-wider">
                    <i data-lucide="sliders" class="w-3.5 h-3.5"></i>
                    AIをカスタマイズ
                </div>
                
                <!-- AIのキャラクター設定テンプレート -->
                <div class="space-y-1">
                    <label class="text-[10px] text-slate-500 dark:text-slate-400 font-bold block">性格テンプレート</label>
                    <select id="character-template" onchange="applyTemplate()" class="w-full bg-white dark:bg-slate-850 border border-slate-300 dark:border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 dark:text-slate-300 focus:border-yellow-500 outline-none cursor-pointer">
                        <option value="lemon">🍋 爽やかレモン (親切＆元気)</option>
                        <option value="sensei">🎓 優秀な先生 (わかりやすく指導)</option>
                        <option value="friend">💬 フレンズ風 (タメ口で話し相手)</option>
                        <option value="coder">💻 プログラマー (完璧なコード解説)</option>
                        <option value="critic">🧐 クリティカル (論理的な分析)</option>
                        <option value="custom">✍️ フルカスタム (自分で指示を書く)</option>
                    </select>
                </div>

                <!-- 自由入力用のシステムプロンプト -->
                <div id="custom-prompt-container" class="space-y-1 hidden">
                    <label class="text-[10px] text-slate-500 dark:text-slate-400 font-bold block">カスタムシステム指示</label>
                    <textarea id="custom-prompt-input" rows="3" oninput="updateCustomPrompt()" class="w-full bg-white dark:bg-slate-850 border border-slate-300 dark:border-slate-800 rounded-lg p-2 text-xs text-slate-800 dark:text-slate-200 focus:border-yellow-500 outline-none resize-none" placeholder="例：あなたは関西弁で話す親切なおばちゃんです。"></textarea>
                </div>

                <!-- 回答の柔軟性 (Temperature) -->
                <div class="space-y-1.5">
                    <div class="flex justify-between text-[10px] text-slate-500 dark:text-slate-400 font-bold">
                        <span>回答の柔軟性 (創造性)</span>
                        <span id="temp-val-display" class="text-yellow-600 dark:text-yellow-400 font-mono">0.7</span>
                    </div>
                    <input type="range" id="temp-slider" min="0" max="1.5" step="0.1" value="0.7" oninput="updateTemperature(this.value)" class="w-full accent-yellow-500 cursor-pointer">
                    <div class="flex justify-between text-[8px] text-slate-400 dark:text-slate-500">
                        <span>カチッと(正確)</span>
                        <span>ふわっと(アイデア)</span>
                    </div>
                </div>
            </div>

            <!-- チャット履歴 -->
            <div class="flex-1 overflow-y-auto px-2 py-3 space-y-1" id="chat-list"></div>

            <!-- フッター情報 -->
            <div class="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-200/50 dark:bg-slate-950 text-xs text-slate-500 text-center">
                <div class="font-bold text-slate-600 dark:text-slate-400">Voton Lemon AI</div>
                <div class="mt-1 text-[10px]">完全無料・ログイン不要・無制限</div>
                <button onclick="startTutorial(true)" class="mt-2 text-[10px] text-yellow-600 dark:text-yellow-500 hover:underline flex items-center justify-center gap-1 mx-auto">
                    <i data-lucide="help-circle" class="w-3 h-3"></i> チュートリアルを再実行
                </button>
            </div>
        </aside>

        <!-- メインチャット画面 -->
        <main class="flex-1 flex flex-col h-full bg-slate-50 dark:bg-slate-950 relative overflow-hidden transition-colors duration-200">
            
            <!-- プライベートモード作動中警告バナー (NEW) -->
            <div id="private-banner" class="hidden bg-purple-100 dark:bg-purple-950/80 border-b border-purple-200 dark:border-purple-800 text-purple-700 dark:text-purple-200 text-xs px-4 py-2 text-center flex items-center justify-center gap-1.5 font-bold transition-all">
                <i data-lucide="eye-off" class="w-4 h-4 text-purple-500"></i>
                <span>プライベートモード作動中：このチャットスレッドは履歴に保存されず、ブラウザをリロードすると完全に消去されます。</span>
            </div>

            <!-- ヘッダー -->
            <header class="h-16 border-b border-slate-200 dark:border-slate-800 bg-white/85 dark:bg-slate-900/40 backdrop-blur-md flex items-center justify-between px-4 sticky top-0 z-35 transition-colors duration-200">
                <div class="flex items-center gap-3">
                    <button onclick="toggleSidebar()" class="p-2 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-slate-800 rounded-lg md:hidden">
                        <i data-lucide="menu" class="w-6 h-6"></i>
                    </button>
                    <div>
                        <h2 id="current-chat-title" class="font-bold text-sm md:text-base text-slate-800 dark:text-slate-200 truncate max-w-[150px] sm:max-w-xs">新しいスレッド</h2>
                        <div class="flex items-center gap-1.5 mt-0.5">
                            <span class="inline-block w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse"></span>
                            <span id="active-model-badge" class="text-[10px] md:text-xs text-slate-500 dark:text-slate-400 font-mono">Lemon AI (通常)</span>
                        </div>
                    </div>
                </div>

                <!-- モデルセレクターとコントロール -->
                <div class="flex items-center gap-2">
                    <!-- テーマ切り替えトグル (NEW) -->
                    <button onclick="toggleTheme()" class="p-2 text-slate-500 dark:text-slate-400 hover:text-yellow-600 dark:hover:text-yellow-400 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-lg transition-colors" title="ライト/ダーク切り替え">
                        <i id="theme-icon" data-lucide="sun" class="w-5 h-5"></i>
                    </button>

                    <div id="tutorial-step-model" class="rounded-lg p-1">
                        <select id="model-selector" onchange="applyModelChange()" class="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 text-xs text-yellow-600 dark:text-yellow-400 rounded-lg px-2.5 py-1.5 focus:border-yellow-500 outline-none cursor-pointer font-bold transition-colors">
                            <option value="grandpro">👑 Lemon AI GrandPro</option>
                            <option value="sp">✨ Lemon AI SP</option>
                            <option value="regular" selected>🍋 Lemon AI</option>
                            <option value="lite">⚡ Lemon AI Lite</option>
                        </select>
                    </div>
                    <button id="tutorial-step-clear" onclick="clearCurrentChat()" class="p-2 text-rose-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors" title="会話をクリア">
                        <i data-lucide="trash-2" class="w-5 h-5"></i>
                    </button>
                </div>
            </header>

            <!-- メッセージ表示部 -->
            <div id="chat-messages" class="flex-1 overflow-y-auto p-4 space-y-6 md:p-6 bg-slate-50 dark:bg-slate-950 transition-colors">
                <!-- ウェルカムスクリーン -->
                <div id="welcome-screen" class="max-w-xl mx-auto my-12 text-center space-y-6">
                    <div class="inline-flex p-4 bg-gradient-to-tr from-yellow-500/20 to-amber-500/20 rounded-2xl text-yellow-600 dark:text-yellow-400 shadow-inner">
                        <i data-lucide="citrus" class="w-12 h-12"></i>
                    </div>
                    <div class="space-y-2">
                        <h1 class="text-3xl font-extrabold text-slate-800 dark:text-white tracking-tight">Voton Lemon AI</h1>
                        <p class="text-slate-500 dark:text-slate-400 text-sm">
                            世界最速クラウド上で動く「高性能AI」を、自分好みのキャラクターに自由にカスタマイズして、完全無料で無制限に利用できるチャットサイトです。
                        </p>
                    </div>
                    <div class="p-4 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 text-left text-xs text-slate-500 dark:text-slate-400 space-y-3 shadow-sm">
                        <div class="font-bold text-yellow-600 dark:text-yellow-400 flex items-center gap-1">
                            <i data-lucide="sparkles" class="w-3.5 h-3.5"></i>
                            🍋 あなただけの体験をカスタマイズ:
                        </div>
                        <div>
                            左メニューからAIのキャラクターを「先生」「友達」「プログラマー」など、あるいは**あなたの自由な指示（フルカスタム）**で即座に変更できます。
                        </div>
                        <div>
                            さらに、右上から性能や速度の異なる4つの「Lemon AI」をシーンに合わせて切り替えられます。
                        </div>
                        <div class="text-[11px] text-purple-600 dark:text-purple-400 font-bold border-t border-slate-100 dark:border-slate-800 pt-2 flex items-center gap-1">
                            <i data-lucide="eye-off" class="w-3 h-3"></i>
                            NEW! プライベートモード：
                            <span>他人に履歴を見せたくない、完全に一時的に使用したい時は左メニューから即座に切り替え可能！</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- フッター・入力フォーム -->
            <footer class="p-4 border-t border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur-md sticky bottom-0 z-30 transition-colors">
                <div class="max-w-4xl mx-auto relative">
                    <form id="chat-form" onsubmit="handleSendMessage(event)" class="relative bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-2xl shadow-xl focus-within:border-yellow-500 transition-all">
                        <textarea 
                            id="user-input" 
                            rows="2"
                            placeholder="レモンにメッセージを送信... (Shift + Enter で改行)" 
                            class="w-full pl-4 pr-16 py-3.5 bg-transparent border-0 outline-none focus:ring-0 text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 text-sm md:text-base resize-none"
                            onkeydown="handleTextareaKeydown(event)"
                        ></textarea>
                        
                        <div id="tutorial-step-input" class="absolute right-3 bottom-3 flex items-center gap-2">
                            <button id="stop-btn" type="button" onclick="cancelGeneration()" class="hidden p-2 text-rose-500 hover:text-rose-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl" title="生成を停止">
                                <i data-lucide="square" class="w-5 h-5 fill-rose-500"></i>
                            </button>
                            <button id="send-btn" type="submit" class="p-2 text-slate-950 bg-gradient-to-tr from-yellow-500 to-amber-500 hover:from-yellow-400 hover:to-amber-400 rounded-xl transition-all shadow-md shadow-yellow-900/20">
                                <i data-lucide="send" class="w-5 h-5"></i>
                            </button>
                        </div>
                    </form>
                    <p class="text-center text-[10px] text-slate-450 dark:text-slate-500 mt-2">
                        Voton Lemon AI is optimized with custom models. AIは誤った情報を出力することがあります。
                    </p>
                </div>
            </footer>
        </main>
    </div>

    <!-- UI通知エレメント -->
    <div id="toast" class="fixed top-5 right-5 z-50 transform translate-y-[-100px] opacity-0 transition-all duration-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-4 py-3 rounded-xl shadow-xl flex items-center gap-2 text-sm text-slate-800 dark:text-white">
        <i id="toast-icon" data-lucide="info" class="w-4 h-4 text-yellow-500"></i>
        <span id="toast-text">メッセージ</span>
    </div>

    <!-- ===== インタラクティブチュートリアルオーバーレイ ===== -->
    <div id="tutorial-overlay" class="fixed inset-0 z-45 bg-slate-950/80 backdrop-blur-sm hidden transition-opacity duration-300 flex items-center justify-center p-4">
        <!-- チュートリアルフキダシカード -->
        <div id="tutorial-card" class="bg-white dark:bg-slate-900 border-2 border-yellow-500/80 w-full max-w-md rounded-2xl shadow-2xl p-6 relative flex flex-col space-y-4 text-slate-800 dark:text-slate-100 transform scale-95 opacity-0 transition-all duration-300">
            <!-- レモンロゴアイコン -->
            <div class="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
                <span class="p-1.5 bg-yellow-500 rounded-lg text-slate-950 shadow-md">
                    <i data-lucide="citrus" class="w-4 h-4"></i>
                </span>
                <span id="tutorial-title" class="font-bold text-yellow-600 dark:text-yellow-400 text-sm">Lemon AI ガイド</span>
            </div>
            
            <!-- ガイド本文 -->
            <div class="text-xs leading-relaxed text-slate-600 dark:text-slate-300 min-h-[90px]" id="tutorial-text">
                説明がここに流れます。
            </div>

            <!-- モデル別性能比較表 -->
            <div id="tutorial-models-table" class="hidden text-[11px] bg-slate-100 dark:bg-slate-950/80 p-3 rounded-xl border border-slate-200 dark:border-slate-800 space-y-2">
                <div class="font-bold text-yellow-600 dark:text-yellow-400 pb-1 border-b border-slate-200 dark:border-slate-800 flex justify-between">
                    <span>モデル別スペック</span>
                    <span>賢さ / 速度</span>
                </div>
                <div class="flex justify-between items-center text-slate-700 dark:text-slate-300">
                    <span class="font-bold">👑 GrandPro</span>
                    <span class="font-mono text-yellow-600 dark:text-yellow-400">★★★★★ / ★★☆☆☆</span>
                </div>
                <div class="flex justify-between items-center text-slate-700 dark:text-slate-300">
                    <span class="font-bold">✨ SP</span>
                    <span class="font-mono text-yellow-600 dark:text-yellow-400">★★★★☆ / ★★★☆☆</span>
                </div>
                <div class="flex justify-between items-center text-slate-700 dark:text-slate-300">
                    <span class="font-bold">🍋 無印 (標準)</span>
                    <span class="font-mono text-yellow-600 dark:text-yellow-400">★★★☆☆ / ★★★★☆</span>
                </div>
                <div class="flex justify-between items-center text-slate-700 dark:text-slate-300">
                    <span class="font-bold">⚡ Lite</span>
                    <span class="font-mono text-yellow-600 dark:text-yellow-400">★★☆☆☆ / ★★★★★</span>
                </div>
            </div>

            <!-- コントロールボタン -->
            <div class="flex justify-between items-center pt-2 border-t border-slate-200 dark:border-slate-800">
                <button onclick="skipTutorial()" class="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 font-semibold">
                    チュートリアルを終了
                </button>
                <div class="flex items-center gap-2">
                    <span id="tutorial-progress" class="text-[10px] text-slate-500 dark:text-slate-400 font-mono mr-2">1 / 5</span>
                    <button id="tutorial-prev-btn" onclick="prevTutorialStep()" class="p-1 px-3 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-bold rounded-lg transition-all hidden">
                        戻る
                    </button>
                    <button id="tutorial-next-btn" onclick="nextTutorialStep()" class="p-1 px-4 bg-gradient-to-r from-yellow-500 to-amber-500 text-slate-950 text-xs font-bold rounded-lg transition-all hover:scale-105 shadow-md shadow-yellow-900/10 flex items-center gap-1">
                        <span>次へ</span>
                        <i data-lucide="chevron-right" class="w-3.5 h-3.5"></i>
                    </button>
                </div>
            </div>
        </div>
    </div>

    <script>
        // 設定ステート
        let isDarkMode = localStorage.getItem('lemon_theme') !== 'light';
        let isPrivateMode = false;

        let chats = JSON.parse(localStorage.getItem('lemon_chats') || '[]');
        let activeChatId = localStorage.getItem('lemon_active_chat_id') || null;
        let abortController = null;
        let isGenerating = false;
        let activeModelKey = 'regular'; // デフォルトは通常モデル

        // キャラクター性格テンプレートのシステムプロンプト定義
        const templates = {
            lemon: "あなたはVoton Lemon AI（レモンアシスタント）です。親切、かつ明るく爽やかに回答してください。レモンにちなんだユニークな例えをたまに交えると良いでしょう。返答は親しみやすく簡潔にまとめてください。",
            sensei: "あなたは非常に聡明で丁寧な日本語教師（メンター）です。ユーザーの質問に対して、順序立てて大大大変分かりやすく、要点を整理して優しく指導してください。",
            friend: "あなたはユーザーの親友です。敬語は一切使わず、親近感のある「タメ口」で、明るく友達のようにフランクに話を聞いたり回答したりしてください。",
            coder: "あなたは極めて優秀なリードソフトウェアエンジニアです。質問に対して、正確で動作可能なコードとそのロジカルな日本語解説を最短ステップで提示してください。余計な世間話は省きます。",
            critic: "あなたは冷徹で極めて客観的なデータアナリストです。ユーザーの意見や質問に対し、あらゆる多角的な視点からメリット・デメリット、論理的矛盾などを冷静かつ厳格に批評・分析してください。"
        };

        window.addEventListener('DOMContentLoaded', async () => {
            lucide.createIcons();
            
            // テーマの初期化 (NEW)
            initTheme();

            // サーバーの疎通確認
            await checkServerStatus();

            if (chats.length === 0) {
                createNewChat();
            } else {
                renderChatList();
                if (activeChatId) {
                    selectChat(activeChatId);
                } else {
                    selectChat(chats[0].id);
                }
            }

            // チュートリアル起動判定 (初回訪問時)
            if (!localStorage.getItem('lemon_tutorial_completed')) {
                setTimeout(() => { startTutorial(); }, 1200);
            }
        });

        // ====================================================
        // テーマ切り替え機能 (NEW)
        // ====================================================
        function initTheme() {
            const html = document.documentElement;
            const themeIcon = document.getElementById('theme-icon');
            
            if (isDarkMode) {
                html.classList.add('dark');
                themeIcon.setAttribute('data-lucide', 'sun');
            } else {
                html.classList.remove('dark');
                themeIcon.setAttribute('data-lucide', 'moon');
            }
            lucide.createIcons();
        }

        function toggleTheme() {
            isDarkMode = !isDarkMode;
            localStorage.setItem('lemon_theme', isDarkMode ? 'dark' : 'light');
            initTheme();
            showToast(isDarkMode ? "ダークモードに変更しました" : "ライトモードに変更しました", "success");
        }

        // ====================================================
        // プライベートモード機能 (NEW)
        // ====================================================
        function togglePrivateMode() {
            isPrivateMode = !isPrivateMode;
            const btn = document.getElementById('private-toggle-btn');
            const dot = document.getElementById('private-toggle-dot');
            
            if (isPrivateMode) {
                btn.classList.remove('bg-slate-300', 'dark:bg-slate-700');
                btn.classList.add('bg-purple-600');
                dot.classList.add('translate-x-5');
                showToast("プライベートモードを有効化（履歴は保存されません）", "success");
                
                // シークレット用スレッドをメモリ上で作成
                createPrivateChat();
            } else {
                btn.classList.remove('bg-purple-600');
                btn.classList.add('bg-slate-300', 'dark:bg-slate-700');
                dot.classList.remove('translate-x-5');
                showToast("プライベートモードをOFFにし、通常の履歴に戻りました", "info");
                
                // メモリ上のプライベートチャットをパージ
                chats = chats.filter(c => !c.isPrivate);
                
                // 通常スレッドに戻る
                if (chats.length > 0) {
                    selectChat(chats[0].id);
                } else {
                    createNewChat();
                }
            }
        }

        function createPrivateChat() {
            const newChat = {
                id: 'chat_private_' + Date.now(),
                title: '🕵️ プライベートスレッド',
                template: 'lemon',
                systemPrompt: templates.lemon,
                temperature: 0.7,
                modelKey: 'regular',
                messages: [],
                isPrivate: true
            };
            
            chats.unshift(newChat);
            // localStorageへの書き込みはサスペンド (saveChatsToStorageをあえて呼ばない)
            renderChatList();
            selectChat(newChat.id);
        }

        async function checkServerStatus() {
            try {
                const res = await fetch('/api/server-info');
                const data = await res.json();
                if (data.status.includes('未設定')) {
                    showToast('サーバーのAPIキー設定が完了していません。', 'error');
                }
            } catch (err) {
                showToast('サーバーと通信できません。', 'error');
            }
        }

        function toggleSidebar() {
            document.getElementById('sidebar').classList.toggle('-translate-x-full');
        }

        function showToast(message, type = 'info') {
            const toast = document.getElementById('toast');
            const toastText = document.getElementById('toast-text');
            const toastIcon = document.getElementById('toast-icon');
            toastText.innerText = message;
            
            let iconName = 'info';
            let iconColor = 'text-yellow-500';
            if (type === 'success') { iconName = 'check-circle'; iconColor = 'text-emerald-500'; }
            else if (type === 'error') { iconName = 'alert-triangle'; iconColor = 'text-rose-500'; }
            
            toastIcon.setAttribute('data-lucide', iconName);
            toastIcon.className = \`w-4 h-4 \${iconColor}\`;
            lucide.createIcons();

            toast.classList.remove('translate-y-[-100px]', 'opacity-0');
            toast.classList.add('translate-y-0', 'opacity-100');
            setTimeout(() => {
                toast.classList.add('translate-y-[-100px]', 'opacity-0');
                toast.classList.remove('translate-y-0', 'opacity-100');
            }, 3000);
        }

        function createNewChat() {
            // プライベートモード中は自動的にプライベートチャットを生産
            if (isPrivateMode) {
                createPrivateChat();
                return;
            }

            const newChat = {
                id: 'chat_' + Date.now(),
                title: '新規チャット',
                template: 'lemon',
                systemPrompt: templates.lemon,
                temperature: 0.7,
                modelKey: 'regular',
                messages: []
            };
            chats.unshift(newChat);
            saveChatsToStorage();
            renderChatList();
            selectChat(newChat.id);
            if (window.innerWidth < 768) {
                const sidebar = document.getElementById('sidebar');
                if (!sidebar.classList.contains('-translate-x-full')) toggleSidebar();
            }
        }

        function selectChat(chatId) {
            activeChatId = chatId;
            
            const chat = chats.find(c => c.id === chatId);
            if (!chat) return;

            // 通常チャットの時のみ、最後にアクティブだったIDを保持
            if (!chat.isPrivate) {
                localStorage.setItem('lemon_active_chat_id', chatId);
            }

            // プライベートモードの警告表示制御 (NEW)
            const privateBanner = document.getElementById('private-banner');
            if (chat.isPrivate) {
                privateBanner.classList.remove('hidden');
            } else {
                privateBanner.classList.add('hidden');
            }

            document.getElementById('current-chat-title').innerText = chat.title;
            
            // モデル復元
            activeModelKey = chat.modelKey || 'regular';
            document.getElementById('model-selector').value = activeModelKey;
            updateActiveModelBadge(activeModelKey);

            // カスタマイズ状態復元
            document.getElementById('character-template').value = chat.template || 'lemon';
            document.getElementById('temp-slider').value = chat.temperature !== undefined ? chat.temperature : 0.7;
            document.getElementById('temp-val-display').innerText = chat.temperature !== undefined ? chat.temperature : 0.7;
            
            if (chat.template === 'custom') {
                document.getElementById('custom-prompt-container').classList.remove('hidden');
                document.getElementById('custom-prompt-input').value = chat.systemPrompt || '';
            } else {
                document.getElementById('custom-prompt-container').classList.add('hidden');
            }

            renderMessages();
            renderChatList();

            // モバイル時の自動サイドバー閉じ最適化 (NEW)
            if (window.innerWidth < 768) {
                const sidebar = document.getElementById('sidebar');
                if (!sidebar.classList.contains('-translate-x-full')) {
                    toggleSidebar();
                }
            }
        }

        function applyModelChange() {
            const chat = chats.find(c => c.id === activeChatId);
            if (!chat) return;

            activeModelKey = document.getElementById('model-selector').value;
            chat.modelKey = activeModelKey;
            saveChatsToStorage();
            updateActiveModelBadge(activeModelKey);
            showToast(\`AIを \${getModelFriendlyName(activeModelKey)} に切り替えました！\`, "success");
        }

        function getModelFriendlyName(key) {
            const names = {
                'grandpro': 'GrandPro (最高峰)',
                'sp': 'SP (高品質)',
                'regular': 'Lemon AI (通常)',
                'lite': 'Lite (爆速)'
            };
            return names[key] || 'Lemon AI';
        }

        function updateActiveModelBadge(key) {
            const badge = document.getElementById('active-model-badge');
            const map = {
                'grandpro': 'Lemon AI GrandPro (超高推論)',
                'sp': 'Lemon AI SP (詳細創作)',
                'regular': 'Lemon AI (標準会話)',
                'lite': 'Lemon AI Lite (超爆速)'
            };
            badge.innerText = map[key] || map['regular'];
        }

        function applyTemplate() {
            const chat = chats.find(c => c.id === activeChatId);
            if (!chat) return;

            const selected = document.getElementById('character-template').value;
            chat.template = selected;

            if (selected === 'custom') {
                document.getElementById('custom-prompt-container').classList.remove('hidden');
                chat.systemPrompt = document.getElementById('custom-prompt-input').value;
            } else {
                document.getElementById('custom-prompt-container').classList.add('hidden');
                chat.systemPrompt = templates[selected];
            }

            saveChatsToStorage();
            showToast("AIの性格・キャラクターを変更しました！", "success");
        }

        function updateCustomPrompt() {
            const chat = chats.find(c => c.id === activeChatId);
            if (!chat) return;
            chat.systemPrompt = document.getElementById('custom-prompt-input').value;
            saveChatsToStorage();
        }

        function updateTemperature(val) {
            document.getElementById('temp-val-display').innerText = val;
            const chat = chats.find(c => c.id === activeChatId);
            if (!chat) return;
            chat.temperature = Number(val);
            saveChatsToStorage();
        }

        function deleteChat(chatId, event) {
            event.stopPropagation();
            chats = chats.filter(c => c.id !== chatId);
            if (chats.length === 0) {
                activeChatId = null;
                createNewChat();
            } else {
                if (activeChatId === chatId) {
                    activeChatId = chats[0].id;
                }
                saveChatsToStorage();
                renderChatList();
                selectChat(activeChatId);
            }
            showToast("スレッドを削除しました", "info");
        }

        function clearCurrentChat() {
            const chat = chats.find(c => c.id === activeChatId);
            if (!chat) return;
            chat.messages = [];
            chat.title = chat.isPrivate ? "🕵️ プライベートスレッド" : "新規チャット";
            saveChatsToStorage();
            renderMessages();
            renderChatList();
            showToast("会話をリセットしました", "info");
        }

        function saveChatsToStorage() {
            // プライベートモードのスレッドを完全に除外して保存！ (NEW)
            const normalChats = chats.filter(c => !c.isPrivate);
            localStorage.setItem('lemon_chats', JSON.stringify(normalChats));
        }

        function renderChatList() {
            const container = document.getElementById('chat-list');
            container.innerHTML = '';
            chats.forEach(chat => {
                const isActive = chat.id === activeChatId;
                const activeClass = isActive 
                    ? 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-white border-l-2 border-yellow-500' 
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/50 dark:hover:bg-slate-900/60 hover:text-slate-900 hover:dark:text-slate-200';
                
                const chatItem = document.createElement('div');
                chatItem.className = \`group flex items-center justify-between p-3 rounded-lg cursor-pointer transition-all \${activeClass}\`;
                chatItem.setAttribute('onclick', \`selectChat('\${chat.id}')\`);
                
                const iconName = chat.isPrivate ? 'eye-off' : 'message-square';
                const iconColor = isActive 
                    ? (chat.isPrivate ? 'text-purple-500' : 'text-yellow-500') 
                    : 'text-slate-400 dark:text-slate-500';

                chatItem.innerHTML = \`
                    <div class="flex items-center gap-2.5 overflow-hidden w-full">
                        <i data-lucide="\${iconName}" class="w-4 h-4 shrink-0 \${iconColor}"></i>
                        <span class="text-xs font-medium truncate pr-2 w-full">\${escapeHtml(chat.title)}</span>
                    </div>
                    <button onclick="deleteChat('\${chat.id}', event)" class="p-1 opacity-0 group-hover:opacity-100 hover:bg-slate-300 dark:hover:bg-slate-800 rounded text-slate-500 hover:text-rose-500 transition-all shrink-0">
                        <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                    </button>
                \`;
                container.appendChild(chatItem);
            });
            lucide.createIcons();
        }

        function renderMessages() {
            const chat = chats.find(c => c.id === activeChatId);
            const container = document.getElementById('chat-messages');
            const welcomeScreen = document.getElementById('welcome-screen');

            if (!chat || chat.messages.length === 0) {
                container.innerHTML = '';
                container.appendChild(welcomeScreen);
                welcomeScreen.classList.remove('hidden');
                return;
            }

            welcomeScreen.classList.add('hidden');
            container.innerHTML = '';

            chat.messages.forEach((msg, idx) => {
                const isUser = msg.role === 'user';
                const wrapper = document.createElement('div');
                wrapper.className = \`flex w-full \${isUser ? 'justify-end' : 'justify-start'}\`;

                const inner = document.createElement('div');
                inner.className = \`max-w-[85%] md:max-w-3xl flex gap-3 p-4 rounded-2xl \${
                    isUser 
                        ? 'bg-gradient-to-tr from-yellow-500 to-amber-500 text-slate-950 rounded-tr-none shadow-md font-medium' 
                        : 'bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-800 rounded-tl-none shadow-sm'
                }\`;

                const iconContainer = document.createElement('div');
                iconContainer.className = \`w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-xs font-bold \${
                    isUser 
                        ? 'bg-yellow-600 text-white' 
                        : (chat.isPrivate ? 'bg-purple-100 dark:bg-purple-950 text-purple-600 dark:text-purple-300 border border-purple-200 dark:border-purple-900' : 'bg-slate-200 dark:bg-slate-800 text-yellow-600 dark:text-yellow-400 border border-slate-300 dark:border-slate-700')
                }\`;
                
                const aiIcon = chat.isPrivate ? 'eye-off' : 'citrus';
                iconContainer.innerHTML = isUser ? '<i data-lucide="user" class="w-4 h-4"></i>' : \`<i data-lucide="\${aiIcon}" class="w-4 h-4"></i>\`;

                const textContainer = document.createElement('div');
                textContainer.className = "flex-1 space-y-1 overflow-x-auto text-sm leading-relaxed";
                
                if (isUser) {
                    textContainer.innerText = msg.content;
                } else {
                    textContainer.innerHTML = marked.parse(msg.content);
                }

                const metaContainer = document.createElement('div');
                metaContainer.className = "flex items-center justify-between mt-2 pt-2 border-t border-slate-100 dark:border-slate-850 text-[10px] text-slate-400 dark:text-slate-500";
                metaContainer.innerHTML = \`
                    <span>\${msg.time ? new Date(msg.time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : ''}</span>
                    <button onclick="copyToClipboard(this, \\\`\${msg.content.replace(/\`/g, '\\\\\`').replace(/\\$/g, '\\\\$')}\\\`)" class="hover:text-slate-800 dark:hover:text-white flex items-center gap-1 transition-colors">
                        <i data-lucide="copy" class="w-3 h-3"></i> コピー
                    </button>
                \`;

                if (isUser) metaContainer.classList.add('hidden');

                const contentColumn = document.createElement('div');
                contentColumn.className = "flex-grow flex flex-col";
                contentColumn.appendChild(textContainer);
                if (!isUser) contentColumn.appendChild(metaContainer);

                if (isUser) {
                    inner.appendChild(contentColumn);
                    inner.appendChild(iconContainer);
                } else {
                    inner.appendChild(iconContainer);
                    inner.appendChild(contentColumn);
                }
                wrapper.appendChild(inner);
                container.appendChild(wrapper);
            });
            lucide.createIcons();
            container.scrollTop = container.scrollHeight;
        }

        async function handleSendMessage(event) {
            if (event) event.preventDefault();
            if (isGenerating) return;

            const inputEl = document.getElementById('user-input');
            const messageText = inputEl.value.trim();
            if (!messageText) return;

            const chat = chats.find(c => c.id === activeChatId);
            if (!chat) return;

            chat.messages.push({ role: 'user', content: messageText, time: Date.now() });

            if (chat.title === '新規チャット') {
                chat.title = messageText.length > 15 ? messageText.substring(0, 15) + '...' : messageText;
            }

            inputEl.value = '';
            inputEl.style.height = 'auto';
            saveChatsToStorage();
            renderChatList();
            renderMessages();

            const aiMsgIndex = chat.messages.length;
            chat.messages.push({ role: 'assistant', content: '', time: Date.now() });
            renderMessages();

            await generateStream(chat, aiMsgIndex);
        }

        async function generateStream(chat, aiMsgIndex) {
            isGenerating = true;
            toggleLoading(true);
            abortController = new AbortController();

            const sendMessages = chat.messages.slice(0, aiMsgIndex).map(m => ({
                role: m.role,
                content: m.content
            }));

            const chatMessagesContainer = document.getElementById('chat-messages');

            try {
                const response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        messages: sendMessages,
                        systemPrompt: chat.systemPrompt,
                        temperature: chat.temperature,
                        modelKey: activeModelKey
                    }),
                    signal: abortController.signal
                });

                if (response.status === 429) {
                    throw new Error('負荷が高いため一時的にリクエストを制限しています。1分後にお試しください。');
                }

                if (!response.ok) {
                    throw new Error('AIサーバーとの通信に失敗しました。');
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let accumulatedText = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\n');
                    
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6).trim();
                            if (dataStr === '[DONE]') {
                                continue;
                            }
                            try {
                                const parsed = JSON.parse(dataStr);
                                const content = parsed.choices[0]?.delta?.content || '';
                                if (content) {
                                    accumulatedText += content;
                                    chat.messages[aiMsgIndex].content = accumulatedText;
                                    updateLastAIMessageUI(accumulatedText);
                                    chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
                                }
                            } catch (e) {
                                // JSONのパースエラーは無視
                            }
                        }
                    }
                }
            } catch (error) {
                if (error.name === 'AbortError') {
                    showToast("生成を中断しました", "info");
                } else {
                    chat.messages[aiMsgIndex].content = \`⚠️ \${error.message}\`;
                    updateLastAIMessageUI(chat.messages[aiMsgIndex].content);
                    showToast("通信失敗しました", "error");
                }
            } finally {
                isGenerating = false;
                toggleLoading(false);
                saveChatsToStorage();
                renderMessages();
            }
        }

        function updateLastAIMessageUI(text) {
            const container = document.getElementById('chat-messages');
            const lastMessageWrapper = container.lastElementChild;
            if (!lastMessageWrapper) return;
            const textEl = lastMessageWrapper.querySelector('.flex-1');
            if (textEl) textEl.innerHTML = marked.parse(text);
        }

        function cancelGeneration() {
            if (abortController) abortController.abort();
        }

        function toggleLoading(loading) {
            if (loading) {
                document.getElementById('send-btn').classList.add('hidden');
                document.getElementById('stop-btn').classList.remove('hidden');
            } else {
                document.getElementById('send-btn').classList.remove('hidden');
                document.getElementById('stop-btn').classList.add('hidden');
            }
        }

        function handleTextareaKeydown(event) {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                document.getElementById('chat-form').requestSubmit();
            }
        }

        const textarea = document.getElementById('user-input');
        textarea.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = (this.scrollHeight) + 'px';
        });

        function copyToClipboard(button, text) {
            const tempTextarea = document.createElement('textarea');
            tempTextarea.value = text;
            document.body.appendChild(tempTextarea);
            tempTextarea.select();
            try {
                document.execCommand('copy');
                button.innerHTML = \`<i data-lucide="check" class="w-3 h-3 text-emerald-500"></i> 完了\`;
                lucide.createIcons();
                setTimeout(() => {
                    button.innerHTML = \`<i data-lucide="copy" class="w-3 h-3"></i> コピー\`;
                    lucide.createIcons();
                }, 2000);
            } catch (err) {
                showToast("コピーに失敗しました", "error");
            }
            document.body.removeChild(tempTextarea);
        }

        function escapeHtml(str) {
            if (typeof str !== 'string') return str;
            return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[m]));
        }

        // ====================================================
        // インタラクティブチュートリアルロジック
        // ====================================================
        let tutorialStep = 0;
        const tutorialSteps = [
            {
                elementId: null,
                title: "🍋 Voton Lemon AI へようこそ！",
                text: "このサイトでは、世界最速のAI「Gemma2/Llama」を完全無制限＆無料で利用できます。<br>1分で理解できる、かんたんな使い方をご案内します！"
            },
            {
                elementId: "tutorial-step-customize",
                title: "⚙️ 1. AIキャラクターのカスタマイズ",
                text: "ここからいつでもAIの「性格(指示)」を調整できます。<br>テンプレートを選ぶだけで、先生や友達に変更できます。さらに『フルカスタム』を選べば、好きな役割を自由自在に作り込めます！"
            },
            {
                elementId: "tutorial-step-model",
                title: "👑 2. 4つの Lemon AI モデル",
                text: "右上からいつでもAIの『頭脳』を変更できます。日常会話は通常モデル、難解なタスクにはGrandProなど、用途に合わせて最強モデルを自由に使い分けましょう。",
                showModelsTable: true
            },
            {
                elementId: "tutorial-step-clear",
                title: "🗑️ 3. 会話のスッキリ・リセット",
                text: "チャットが長くなったり、別の新しいテーマで相談をしたくなったら、このゴミ箱ボタンを押すだけで会話履歴を綺麗にリセットできます。"
            },
            {
                elementId: "tutorial-step-input",
                title: "✉️ 4. メッセージを送信しよう！",
                text: "ここに入力して送信します。AIの返答中に『途中でストップ』させたいときは、一時停止ボタン（■）に切り替わるので、いつでも中断できます。<br>これで準備は完了です。AIとの会話を思いっきり楽しんでください！"
            }
        ];

        function startTutorial(force = false) {
            const sidebar = document.getElementById('sidebar');
            if (sidebar.classList.contains('-translate-x-full')) {
                toggleSidebar();
            }

            tutorialStep = 0;
            const overlay = document.getElementById('tutorial-overlay');
            overlay.classList.remove('hidden');
            setTimeout(() => {
                document.getElementById('tutorial-card').classList.remove('scale-95', 'opacity-0');
                showTutorialStep();
            }, 100);
        }

        function showTutorialStep() {
            document.querySelectorAll('.spotlight-active').forEach(el => {
                el.classList.remove('spotlight-active');
            });

            const step = tutorialSteps[tutorialStep];
            
            document.getElementById('tutorial-title').innerText = step.title;
            document.getElementById('tutorial-text').innerHTML = step.text;
            document.getElementById('tutorial-progress').innerText = \`\${tutorialStep + 1} / \${tutorialSteps.length}\`;

            const modelTable = document.getElementById('tutorial-models-table');
            if (step.showModelsTable) {
                modelTable.classList.remove('hidden');
            } else {
                modelTable.classList.add('hidden');
            }

            if (step.elementId) {
                const target = document.getElementById(step.elementId);
                if (target) {
                    target.classList.add('spotlight-active');
                    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }

            document.getElementById('tutorial-prev-btn').style.display = tutorialStep === 0 ? 'none' : 'block';
            
            const nextBtn = document.getElementById('tutorial-next-btn');
            if (tutorialStep === tutorialSteps.length - 1) {
                nextBtn.innerHTML = 'スタート！';
            } else {
                nextBtn.innerHTML = '<span>次へ</span><i data-lucide="chevron-right" class="w-3.5 h-3.5"></i>';
                lucide.createIcons();
            }
        }

        function nextTutorialStep() {
            if (tutorialStep < tutorialSteps.length - 1) {
                tutorialStep++;
                showTutorialStep();
            } else {
                skipTutorial();
            }
        }

        function prevTutorialStep() {
            if (tutorialStep > 0) {
                tutorialStep--;
                showTutorialStep();
            }
        }

        function skipTutorial() {
            document.querySelectorAll('.spotlight-active').forEach(el => {
                el.classList.remove('spotlight-active');
            });

            const overlay = document.getElementById('tutorial-overlay');
            document.getElementById('tutorial-card').classList.add('scale-95', 'opacity-0');
            setTimeout(() => {
                overlay.classList.add('hidden');
                if (window.innerWidth < 768) {
                    const sidebar = document.getElementById('sidebar');
                    if (!sidebar.classList.contains('-translate-x-full')) toggleSidebar();
                }
            }, 300);

            localStorage.setItem('lemon_tutorial_completed', 'true');
            showToast("チュートリアルを完了しました！AIライフを楽しんでください！", "success");
        }
    </script>
</body>
</html>
    `);
});

// サーバー起動
app.listen(PORT, () => {
    console.log(`Voton Lemon AI Server running on port ${PORT}`);
});
