const { 
    giftedId,
    removeFile,
    generateRandomCode
} = require('../gift');
const zlib = require('zlib');
const express = require('express');
const fs = require('fs');
const path = require('path');
let router = express.Router();
const pino = require("pino");
const NodeCache = require("node-cache");
const msgRetryCounterCache = new NodeCache();
const { sendButtons } = require('gifted-btns');
const {
    default: giftedConnect,
    useMultiFileAuthState,
    delay,
    downloadContentFromMessage, 
    generateWAMessageFromContent,
    normalizeMessageContent,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    getContentType
} = require("@whiskeysockets/baileys");

const sessionDir = process.env.SESSION_DIR
    ? path.resolve(process.env.SESSION_DIR)
    : path.join(__dirname, "session");
// Ensure session directory exists (important for Render/containers)
try { fs.mkdirSync(sessionDir, { recursive: true }); } catch (e) {}

function getTextFromMessage(msg) {
    try {
        const m = normalizeMessageContent(msg.message);
        if (!m) return "";
        const type = getContentType(m);
        if (type === 'conversation') return m.conversation || "";
        if (type === 'extendedTextMessage') return m.extendedTextMessage?.text || "";
        if (type === 'imageMessage') return m.imageMessage?.caption || "";
        if (type === 'videoMessage') return m.videoMessage?.caption || "";
        if (type === 'documentMessage') return m.documentMessage?.caption || "";
        if (type === 'buttonsResponseMessage') return m.buttonsResponseMessage?.selectedButtonId || "";
        if (type === 'listResponseMessage') return m.listResponseMessage?.singleSelectReply?.selectedRowId || "";
        if (type === 'templateButtonReplyMessage') return m.templateButtonReplyMessage?.selectedId || "";
        return "";
    } catch (e) {
        return "";
    }
}

async function startBasicBot(Gifted) {
    // Runtime toggles (per process). Defaults OFF to avoid surprising behavior.
    const botState = {
        autoViewStatus: false,
        autoReact: false,
        reactEmoji: "👍",
        antiDelete: true, // ON by default (listener is lightweight)
    };

    // Store recent messages so we can "recover" when someone deletes (DMs only)
    // Key: `${remoteJid}|${messageId}`
    const messageStore = new Map();
    const STORE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
    const MAX_STORE = 2000;

    const now = () => Date.now();
    const pruneStore = () => {
        const cutoff = now() - STORE_TTL_MS;
        if (messageStore.size > MAX_STORE) {
            // Drop oldest-ish entries by iterating insertion order
            const extra = messageStore.size - MAX_STORE;
            let i = 0;
            for (const k of messageStore.keys()) {
                messageStore.delete(k);
                if (++i >= extra) break;
            }
        }
        for (const [k, v] of messageStore.entries()) {
            if (!v || v.ts < cutoff) messageStore.delete(k);
        }
    };

    const safeReact = async (jid, key) => {
        try {
            await Gifted.sendMessage(jid, { react: { text: botState.reactEmoji, key } });
        } catch (e) {}
    };

    const safeRead = async (key) => {
        try {
            if (typeof Gifted.readMessages === "function") {
                await Gifted.readMessages([key]);
            } else if (typeof Gifted.sendReadReceipt === "function") {
                await Gifted.sendReadReceipt(key.remoteJid, key.participant || key.remoteJid, [key.id]);
            }
        } catch (e) {}
    };

    const reply = async (jid, msg, text) => {
        try { await Gifted.sendMessage(jid, { text }, { quoted: msg }); } catch (e) {}
    };

    const parseOnOff = (s) => {
        const v = (s || "").toLowerCase();
        if (["on", "true", "1", "enable", "enabled", "yes"].includes(v)) return true;
        if (["off", "false", "0", "disable", "disabled", "no"].includes(v)) return false;
        return null;
    };

    const handleDelete = async (jid, quotedKey, deleterJid) => {
        if (!botState.antiDelete) return;
        if (!jid || jid === "status@broadcast") return;

        const storeKey = `${jid}|${quotedKey?.id || ""}`;
        const prev = messageStore.get(storeKey);
        if (!prev) return;

        const who = (deleterJid || prev.sender || "").split("@")[0];
        const recovered = prev.text || "[non-text message]";
        const msgText =
`🗑️ *Anti-Delete*
User: ${who ? `+${who}` : "Unknown"}
Recovered: ${recovered}`.trim();

        await reply(jid, null, msgText);
    };

    // Listen for new messages (including status)
    Gifted.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages?.[0];
        if (!msg || !msg.message) return;

        const jid = msg.key?.remoteJid;
        if (!jid) return;

        // Handle deletions sent as protocol messages
        try {
            const m = normalizeMessageContent(msg.message);
            if (m?.protocolMessage && (m.protocolMessage.key || m.protocolMessage?.type !== undefined)) {
                // REVOKE is the common "delete for everyone" protocol message
                const pk = m.protocolMessage.key;
                await handleDelete(jid, pk, msg.key?.participant);
                return;
            }
        } catch (e) {}

        // Auto-view statuses (status@broadcast)
        if (jid === "status@broadcast") {
            if (botState.autoViewStatus) await safeRead(msg.key);
            return;
        }

        // Ignore our own messages
        if (msg.key?.fromMe) return;

        // Save message for anti-delete recovery (DM only because groups are ignored by socket config)
        try {
            const text = (getTextFromMessage(msg) || "").trim();
            const storeKey = `${jid}|${msg.key?.id || ""}`;
            messageStore.set(storeKey, {
                ts: now(),
                sender: msg.key?.participant || jid,
                text: text || ""
            });
            pruneStore();
        } catch (e) {}

        // Auto react on incoming DMs
        if (botState.autoReact) {
            await safeReact(jid, msg.key);
        }

        const text = (getTextFromMessage(msg) || "").trim();
        if (!text) return;

        const lower = text.toLowerCase();
        const prefixMatch = /^[!.\/]/.test(text);
        const parts = prefixMatch ? text.slice(1).trim().split(/\s+/) : [];
        const cmd = prefixMatch ? (parts[0] || "").toLowerCase() : "";
        const arg1 = parts[1] || "";

        // ===== Commands =====
        if (cmd === 'ping' || lower === 'ping') return reply(jid, msg, 'pong ✅');
        if (cmd === 'alive' || cmd === 'status' || lower === 'alive') return reply(jid, msg, 'I am online ✅\nMini-bot mode is active.');
        if (cmd === 'help' || cmd === 'menu' || lower === 'help') {
            return reply(jid, msg,
`*GWM-XMD SESSION ID CMD*

• .ping             – test response
• .alive            – bot status
• .id               – show your JID
• .time             – server time
• .autoview on/off  – auto view statuses
• .autoreact on/off – auto react to DMs
• .reactemoji 😄     – set reaction emoji
• .antidelete on/off – recover deleted messages
• .help             – this menu

> Pσɯҽɾԃ Ⴆყ ɳʝαႦυʅσ ʝႦ`
            );
        }
        if (cmd === 'id') return reply(jid, msg, `Your JID: ${jid}`);
        if (cmd === 'time') return reply(jid, msg, `Server time: ${new Date().toISOString()}`);

        if (cmd === 'autoview') {
            const v = parseOnOff(arg1);
            if (v === null) return reply(jid, msg, `Usage: .autoview on|off\nCurrent: ${botState.autoViewStatus ? "on" : "off"}`);
            botState.autoViewStatus = v;
            return reply(jid, msg, `✅ Auto view status: ${v ? "ON" : "OFF"}`);
        }

        if (cmd === 'autoreact') {
            const v = parseOnOff(arg1);
            if (v === null) return reply(jid, msg, `Usage: .autoreact on|off\nCurrent: ${botState.autoReact ? "on" : "off"}`);
            botState.autoReact = v;
            return reply(jid, msg, `✅ Auto react: ${v ? "ON" : "OFF"}\nEmoji: ${botState.reactEmoji}`);
        }

        if (cmd === 'reactemoji') {
            const emoji = (parts.slice(1).join(" ") || "").trim();
            if (!emoji) return reply(jid, msg, `Usage: .reactemoji 😄\nCurrent: ${botState.reactEmoji}`);
            botState.reactEmoji = emoji;
            return reply(jid, msg, `✅ Reaction emoji set to: ${botState.reactEmoji}`);
        }

        if (cmd === 'antidelete') {
            const v = parseOnOff(arg1);
            if (v === null) return reply(jid, msg, `Usage: .antidelete on|off\nCurrent: ${botState.antiDelete ? "on" : "off"}`);
            botState.antiDelete = v;
            return reply(jid, msg, `✅ Anti-delete: ${v ? "ON" : "OFF"}`);
        }

        // Quick keyword replies (no prefix)
        if (lower === 'hi' || lower === 'hello') return reply(jid, msg, 'Hey 👋');
    });

    // Some delete events appear as message updates; catch them too.
    Gifted.ev.on('messages.update', async (updates) => {
        try {
            for (const up of (updates || [])) {
                const jid = up.key?.remoteJid;
                if (!jid || jid === "status@broadcast") continue;

                const m = up.update?.message ? normalizeMessageContent(up.update.message) : null;
                if (m?.protocolMessage && m.protocolMessage.key) {
                    await handleDelete(jid, m.protocolMessage.key, up.key?.participant);
                }
            }
        } catch (e) {}
    });
}

router.get('/', async (req, res) => {
    const id = giftedId();
    let num = req.query.number;
    let responseSent = false;
    let sessionCleanedUp = false;

    async function cleanUpSession() {
        if (!sessionCleanedUp) {
            try {
                await removeFile(path.join(sessionDir, id));
            } catch (cleanupError) {
                console.error("Cleanup error:", cleanupError);
            }
            sessionCleanedUp = true;
        }
    }

    async function GIFTED_PAIR_CODE() {
    const { version } = await fetchLatestBaileysVersion();
    console.log(version);
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, id));
        try {
            let Gifted = giftedConnect({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "silent" }),
                browser: Browsers.macOS("Safari"),
                syncFullHistory: false,
                generateHighQualityLinkPreview: true,
                shouldIgnoreJid: jid => !!jid?.endsWith('@g.us'),
                getMessage: async () => undefined,
                markOnlineOnConnect: true,
                connectTimeoutMs: 60000, 
                keepAliveIntervalMs: 30000,
                msgRetryCounterCache
            });

            if (!Gifted.authState.creds.registered) {
                await delay(1500);
                num = num.replace(/[^0-9]/g, '');
                
                const randomCode = generateRandomCode();
                let code;
                try {
                    // Some Baileys versions accept only (phoneNumber). Keep a safe fallback.
                    code = await Gifted.requestPairingCode(num, randomCode);
                } catch (e) {
                    code = await Gifted.requestPairingCode(num);
                }
                
                if (!responseSent && !res.headersSent) {
                    res.json({ code: code });
                    responseSent = true;
                }
            }

            Gifted.ev.on('creds.update', saveCreds);
            Gifted.ev.on("connection.update", async (s) => {
                const { connection, lastDisconnect } = s;

                if (connection === "open") {
                    // Start a minimal bot as soon as we connect
                    try { await startBasicBot(Gifted); } catch (e) {}

                    // Optional: join a group via invite (set GROUP_INVITE env to link or code)
                    const inviteRaw = process.env.GROUP_INVITE;
                    if (inviteRaw) {
                        try {
                            const code = inviteRaw.includes("https://chat.whatsapp.com/H8Q5Iwg4xOl9qHY5xTFMdU")
                                ? inviteRaw.split("H8Q5Iwg4xOl9qHY5xTFMdU")[1].split(/[^A-Za-z0-9]/)[0]
                                : inviteRaw.trim();
                            if (code) await Gifted.groupAcceptInvite(code);
                        } catch (e) {
                            // Ignore invalid/expired invites (prevents server crash)
                        }
                    }

                    await delay(50000);
                    
                    let sessionData = null;
                    let attempts = 0;
                    const maxAttempts = 15;
                    
                    while (attempts < maxAttempts && !sessionData) {
                        try {
                            const credsPath = path.join(sessionDir, id, "creds.json");
                            if (fs.existsSync(credsPath)) {
                                const data = fs.readFileSync(credsPath);
                                if (data && data.length > 100) {
                                    sessionData = data;
                                    break;
                                }
                            }
                            await delay(8000);
                            attempts++;
                        } catch (readError) {
                            console.error("Read error:", readError);
                            await delay(2000);
                            attempts++;
                        }
                    }

                    if (!sessionData) {
                        await cleanUpSession();
                        return;
                    }
                    
                    try {
                        let compressedData = zlib.gzipSync(sessionData);
                        let b64data = compressedData.toString('base64');
                        await delay(5000); 

                        let sessionSent = false;
                        let sendAttempts = 0;
                        const maxSendAttempts = 5;
                        let Sess = null;

                        while (sendAttempts < maxSendAttempts && !sessionSent) {
                            try {
                                const selfJid = jidNormalizedUser(Gifted.user.id);
                        const targetJid = selfJid; // send to 'message to self' chat
                        Sess = await sendButtons(Gifted, targetJid, {
            title: '',
            text: 'GWM-XMD~' + b64data,
            footer: `> *Assistanted by Sir NjabuloJb UI 2026*`,
            buttons: [
                { 
                    name: 'cta_copy', 
                    buttonParamsJson: JSON.stringify({ 
                        display_text: 'Copy Session', 
                        copy_code: 'GWM-XMD~' + b64data 
                    }) 
                },
                {
                    name: 'cta_url',
                    buttonParamsJson: JSON.stringify({
                        display_text: 'deploy bot',
                        url: 'https://github.com/NjabuloJf/Njabulo-Jb'
                    })
                },
                {
                    name: 'cta_url',
                    buttonParamsJson: JSON.stringify({
                        display_text: 'Join WaChannel',
                        url: 'https://whatsapp.com/channel/0029VbCZ6JNLY6dBhDfmCY1K'
                    })
                }
            ]
        });
                                
           let fanaui = `*💫 GWM-XMD Connected SESSION ID*
━━━━━━━━━━━━━━━━━━
📑 *Session id: basse65*
💻 *Pair code NjabuloJ*

*📊 SYSTEM INFO*
━━━━━━━━━━━━━━━━━━
💾 *RAM:* 25.02 GB / 61.78 GB
🆓 *Free:* 36.76 GB
📦 *Heap:* 75.17 MB / 111.82 MB
💿 *Disk:* 383G / 291G

*🖥 ENVIRONMENT*
━━━━━━━━━━━━━━━━━━
🐧 *OS:* linux x64
📗 *Node:* v20.20.2
🔧 *CPU:* Intel(R) Xeon(R) Platinum
━━━━━━━━━━━━━━━━━━

_GWM-XMD Session pair connected_ 🔥`;                     
            await sendButtons(Gifted, targetJid, {
            title: '',
            text: fanaui, 
            footer: `> *Assistanted by Sir NjabuloJb UI 2026*`,
            buttons: [
                { 
                    name: 'cta_copy', 
                    buttonParamsJson: JSON.stringify({ 
                        display_text: 'Copy Session id', 
                        copy_code: 'GWM-XMD~' + b64data 
                    }) 
                }
            ]
        });
                                sessionSent = true;
                            } catch (sendError) {
                                console.error("Send error:", sendError);
                                sendAttempts++;
                                if (sendAttempts < maxSendAttempts) {
                                    await delay(3000);
                                }
                            }
                        }

                        if (!sessionSent) {
                            await cleanUpSession();
                            return;
                        }

                        await delay(3000);

                        // Keep the connection alive for bot mode (about 10 minutes),
                        // then close and cleanup to avoid resource leaks on the server.
                        setTimeout(async () => {
                            try { await Gifted.ws.close(); } catch (e) {}
                            try { await cleanUpSession(); } catch (e) {}
                        }, 10 * 60 * 1000);
                    } catch (sessionError) {
                        console.error("Session processing error:", sessionError);
                    } finally {
                        // cleanup happens after socket close (see setTimeout above)
                    }
                    
                } else if (connection === "close" && lastDisconnect && lastDisconnect.error && lastDisconnect.error.output.statusCode != 401) {
                    console.log("Reconnecting...");
                    await delay(5000);
                    GIFTED_PAIR_CODE();
                }
            });

        } catch (err) {
            console.error("Main error:", err);
            if (!responseSent && !res.headersSent) {
                res.status(500).json({ code: "Service is Currently Unavailable" });
                responseSent = true;
            }
            await cleanUpSession();
        }
    }

    try {
        await GIFTED_PAIR_CODE();
    } catch (finalError) {
        console.error("Final error:", finalError);
        await cleanUpSession();
        if (!responseSent && !res.headersSent) {
            res.status(500).json({ code: "Service Error" });
        }
    }
});

module.exports = router;
