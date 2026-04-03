import "dotenv/config"; // 👈 استدعاء ملف الـ env فوراً
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import TelegramBot from "node-telegram-bot-api";
import { Redis } from "@upstash/redis";

// ==========================
// 🔐 سحب البيانات من ملف .env بأمان
// ==========================
const BOT_TOKEN = process.env.BOT_TOKEN; 
const apiId = parseInt(process.env.API_ID); // تحويل الآيدي إلى رقم لأن المكتبة ترفض النص
const apiHash = process.env.API_HASH;
const stringSession = new StringSession(process.env.STRING_SESSION);

const MASTER_ADMIN = process.env.MASTER_ADMIN; 

// ==========================
// 🗄️ إعداد قاعدة البيانات (Upstash Redis)
// ==========================
const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const DEFAULT_CONFIG = { admins: [MASTER_ADMIN], groups: [], keywords: [], receivers: [], enabled: true, regex: false, forward_mode: "text" };

const loadConfig = async () => {
    try {
        const data = await redis.get("bot_config");
        if (!data) {
            await saveConfig(DEFAULT_CONFIG);
            return DEFAULT_CONFIG;
        }
        return data; 
    } catch (e) {
        console.error("❌ خطأ في تحميل البيانات:", e.message);
        return DEFAULT_CONFIG;
    }
};

const saveConfig = async (data) => {
    try {
        await redis.set("bot_config", data);
    } catch (e) {
        console.error("❌ خطأ في حفظ البيانات:", e.message);
    }
};

// ==========================
// 🤖 إعداد البوت والعميل
// ==========================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

// ==========================
// ⌨️ لوحة المفاتيح وحالة المستخدمين
// ==========================
const keyboard = {
    reply_markup: {
        resize_keyboard: true,
        keyboard: [
            ["▶️ تشغيل", "⏸ إيقاف"],
            ["➕ كروب", "➖ كروب"],
            ["➕ كلمة", "➖ كلمة"],
            ["➕ مستلم", "➖ مستلم"],
            ["➕ Admin", "➖ Admin"],
            ["📋 الحالة", "❌ إلغاء الأمر"]
        ]
    }
};

const userStates = {}; 

const isAdmin = async (id) => {
    const cfg = await loadConfig();
    return cfg.admins.includes(String(id)) || String(id) === MASTER_ADMIN;
};

// ==========================
// 🎮 تحكم البوت
// ==========================
bot.onText(/\/start/, async (msg) => {
    if (!(await isAdmin(msg.from.id))) return;
    bot.sendMessage(msg.chat.id, "🎛 أهلاً بك في لوحة التحكم (متصلة بقاعدة البيانات)", keyboard);
});

bot.on("message", async (msg) => {
    const userId = String(msg.from.id);
    if (!(await isAdmin(userId))) return;

    const text = msg.text || "";
    const cfg = await loadConfig();

    // أوامر التحكم السريعة
    if (text === "▶️ تشغيل") { cfg.enabled = true; await saveConfig(cfg); return bot.sendMessage(userId, "✅ تم تفعيل المراقبة."); }
    if (text === "⏸ إيقاف") { cfg.enabled = false; await saveConfig(cfg); return bot.sendMessage(userId, "⛔ تم إيقاف المراقبة."); }
    if (text === "📋 الحالة") return bot.sendMessage(userId, `\`\`\`json\n${JSON.stringify(cfg, null, 2)}\n\`\`\``, { parse_mode: "Markdown" });
    if (text === "❌ إلغاء الأمر") { userStates[userId] = null; return bot.sendMessage(userId, "✅ تم إلغاء الأمر الحالي.", keyboard); }

    // إعداد الحالات
    const stateCommands = ["➕ كروب", "➖ كروب", "➕ كلمة", "➖ كلمة", "➕ مستلم", "➖ مستلم", "➕ Admin", "➖ Admin"];
    if (stateCommands.includes(text)) {
        userStates[userId] = text;
        return bot.sendMessage(userId, `📌 أرسل القيمة المطلوبة لـ: ${text}\n(أو اختر '❌ إلغاء الأمر')`);
    }

    // معالجة المدخلات
    const currentState = userStates[userId];
    if (currentState) {
        if (currentState === "➕ كروب" && !cfg.groups.includes(text)) cfg.groups.push(text);
        if (currentState === "➖ كروب") cfg.groups = cfg.groups.filter(g => g !== text);
        if (currentState === "➕ كلمة" && !cfg.keywords.includes(text)) cfg.keywords.push(text);
        if (currentState === "➖ كلمة") cfg.keywords = cfg.keywords.filter(k => k !== text);
        if (currentState === "➕ مستلم" && !cfg.receivers.includes(text)) cfg.receivers.push(text);
        if (currentState === "➖ مستلم") cfg.receivers = cfg.receivers.filter(r => r !== text);
        if (currentState === "➕ Admin" && !cfg.admins.includes(text)) cfg.admins.push(text);
        if (currentState === "➖ Admin") cfg.admins = cfg.admins.filter(a => a !== text);

        await saveConfig(cfg);
        userStates[userId] = null; // تصفير الحالة
        return bot.sendMessage(userId, "✅ تم الحفظ في قاعدة البيانات بنجاح.");
    }
});

// ==========================
// 📨 Userbot Logic
// ==========================
(async () => {
    try {
        await client.start();
        console.log("✅ Userbot Running... Monitoring started.");

        client.addEventHandler(async (e) => {
            const msg = e.message;
            const textMessage = msg?.message || "";
            if (!textMessage) return;

            const cfg = await loadConfig();
            if (!cfg.enabled) return;

            const chatId = msg.chatId ? msg.chatId.toString() : "";
            
            // 1. فحص الكروب
            if (cfg.groups.length > 0) {
                const isAllowed = cfg.groups.some(savedId => 
                    savedId === chatId || savedId === `-100${chatId}` || chatId === `-100${savedId}`
                );
                if (!isAllowed) return;
            }

            // 2. فحص الكلمات
            if (cfg.keywords.length === 0) return;
            
            const lowerMsg = textMessage.toLowerCase();
            const matched = cfg.keywords.some(k => lowerMsg.includes(k.toLowerCase()));

            if (!matched) return;

            console.log("✅✅ تطابق! جاري الإرسال...");

            // 3. التجهيز والإرسال
            const sender = await msg.getSender();
            const senderName = sender?.firstName || "Unknown";
            const userLink = sender?.username ? `https://t.me/${sender.username}` : "لا يوجد";
            const groupTitle = msg.chat?.title || "كروب غير معروف";

            const formatted = `🔔 رسالة مطابقة\n👤 من: ${senderName}\n🔗 الحساب: ${userLink}\n👥 الكروب: ${groupTitle}\n\n📝 النص:\n${textMessage}`;

            for (const r of cfg.receivers) {
                try {
                    if (cfg.forward_mode === "forward") {
                        await client.forwardMessages(r, { messages: msg.id, fromPeer: msg.chatId });
                    } else {
                        await client.sendMessage(r, { message: formatted });
                    }
                    console.log(`   -> تم الإرسال لـ ${r}`);
                } catch (err) {
                    console.log(`   -> فشل الإرسال لـ ${r}: ${err.message}`);
                }
            }
        }, new NewMessage({}));
    } catch (error) {
        console.error("❌ فشل تشغيل الـ Userbot:", error);
    }
})();