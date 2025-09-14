global.WebSocket = require('ws');
global.fetch = require('node-fetch');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('baileys');

const app = express();
const server = http.createServer(app);

global.mode = global.mode || 'public';

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://adam-d-h7-q8qo.onrender.com';
const io = new Server(server, {
  cors: { origin: [ALLOWED_ORIGIN], methods: ['GET','POST'] },
  pingInterval: 25000,
  pingTimeout: 120000
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.status(200).send("d'accord"));

const SESSIONS_BASE = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_BASE)) fs.mkdirSync(SESSIONS_BASE, { recursive: true });

const OWNER_NAME = 'Superman';
const OWNER_NUMBER = '963996673375';
const BOT_NAME = 'Superman';

const IMAGE_URLS = [
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757699633/tf-stream-url/IMG-20250903-WA0013_lohb7y.jpg",
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757699628/tf-stream-url/IMG-20250903-WA0012_zf6hfg.jpg",
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757699621/tf-stream-url/IMG-20250903-WA0016_cusztg.jpg",
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757699615/tf-stream-url/IMG-20250903-WA0017_glroro.jpg",
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757699598/tf-stream-url/IMG-20250903-WA0576_dxkdcw.jpg",
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757699585/tf-stream-url/IMG-20250903-WA0577_vahynk.jpg",
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757699577/tf-stream-url/IMG-20250903-WA0574_bjiqmp.jpg",
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757699569/tf-stream-url/IMG-20250903-WA0580_zxz0m0.jpg",
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757699550/tf-stream-url/IMG-20250903-WA0581_wngssa.jpg"
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function nextAuthFolder() {
  const items = fs.readdirSync(SESSIONS_BASE).filter(n => n.startsWith('auth_info'));
  const nums = items.map(n => {
    const m = n.match(/auth_info(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  });
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `auth_info${next}`;
}

const sessions = {}; // sessions en mémoire

/**
 * LINK DETECTION
 * Very broad regex for many link types.
 */
const LINK_REGEX = /(https?:\/\/\S+|www\.\S+|\bchat\.whatsapp\.com\/\S+|\bwa\.me\/\S+|\bt\.me\/\S+|\byoutu\.be\/\S+|\byoutube\.com\/\S+|\btelegram\.me\/\S+|\bdiscord(?:app)?\.com\/invite\/\S+|\bdiscord\.gg\/\S+|\bbit\.ly\/\S+|\bshort\.cm\/\S+)/i;

function gatherMessageTextFields(m) {
  const parts = [];
  try {
    if (!m) return parts;
    if (m.conversation) parts.push(m.conversation);
    if (m.extendedTextMessage && m.extendedTextMessage.text) parts.push(m.extendedTextMessage.text);
    if (m.imageMessage && m.imageMessage.caption) parts.push(m.imageMessage.caption);
    if (m.videoMessage && m.videoMessage.caption) parts.push(m.videoMessage.caption);
    if (m.documentMessage && m.documentMessage.caption) parts.push(m.documentMessage.caption);
    if (m.buttonsMessage && m.buttonsMessage.contentText) parts.push(m.buttonsMessage.contentText);
    if (m.templateMessage && m.templateMessage.hydratedTemplate && m.templateMessage.hydratedTemplate.bodyText) parts.push(m.templateMessage.hydratedTemplate.bodyText);
    if (m.listResponseMessage && m.listResponseMessage.title) parts.push(m.listResponseMessage.title);
    if (m.listResponseMessage && m.listResponseMessage.description) parts.push(m.listResponseMessage.description);

    // context/preview
    const ctx = (m.extendedTextMessage && m.extendedTextMessage.contextInfo) || (m.imageMessage && m.imageMessage.contextInfo) || (m.videoMessage && m.videoMessage.contextInfo) || {};
    if (ctx.externalAdReply && ctx.externalAdReply.sourceUrl) parts.push(ctx.externalAdReply.sourceUrl);
    if (ctx.externalAdReply && ctx.externalAdReply.previewUrl) parts.push(ctx.externalAdReply.previewUrl);
    if (ctx.externalAdReply && ctx.externalAdReply.thumbnailUrl) parts.push(ctx.externalAdReply.thumbnailUrl);
  } catch (e) { /* ignore */ }
  return parts.filter(Boolean);
}

function messageContainsLink(msg) {
  try {
    if (!msg || !msg.message) return false;
    if (msg.key && msg.key.fromMe) return false; // never delete bot's own messages
    const parts = gatherMessageTextFields(msg.message);
    const aggregated = parts.join(' ');
    if (LINK_REGEX.test(aggregated)) return true;
    const j = JSON.stringify(msg.message || {});
    return LINK_REGEX.test(j);
  } catch (e) {
    return false;
  }
}

async function startBaileysForSession(sessionId, folderName, socket, opts = { attempt: 0 }) {
  if (sessions[sessionId] && sessions[sessionId].sock) return sessions[sessionId];

  const dir = path.join(SESSIONS_BASE, folderName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // charge auth state
  let state, saveCreds;
  try {
    const auth = await useMultiFileAuthState(dir);
    state = auth.state;
    saveCreds = auth.saveCreds;
  } catch (err) {
    console.error(`[${sessionId}] useMultiFileAuthState failed`, err);
    socket.emit('error', { message: "Échec du chargement de l'état d'authentification", detail: String(err) });
    throw err;
  }

  // récupère meta.json
  let sessionOwnerNumber = null;
  try {
    const metaPath = path.join(dir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta && meta.phone) sessionOwnerNumber = String(meta.phone).replace(/\D/g, '');
    }
  } catch (e) { console.warn(`[${sessionId}] impossible de lire meta.json`, e); }

  // get WA version best-effort
  let version = undefined;
  try {
    const res = await fetchLatestBaileysVersion();
    if (res && res.version) version = res.version;
  } catch (err) {
    console.warn(`[${sessionId}] fetchLatestBaileysVersion failed — proceeding without explicit version`);
  }

  const logger = pino({ level: 'silent' });
  const sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false });

  const sessionObj = {
    sock,
    saveCreds,
    folderName,
    dir,
    restarting: false,
    invisibleMode: {},
    bienvenueEnabled: {},
    noLienMode: {}, // jid -> 'off' | 'exceptAdmins' | 'all'
    sessionOwnerNumber,
    botId: null,
  };
  sessions[sessionId] = sessionObj;

  // persist creds
  sock.ev.on('creds.update', saveCreds);

  // helper: fetch image buffer
  async function fetchImageBuffer() {
    try {
      const url = IMAGE_URLS[Math.floor(Math.random() * IMAGE_URLS.length)];
      const res = await fetch(url);
      if (!res.ok) throw new Error('fetch status ' + res.status);
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch (e) {
      return null;
    }
  }

  async function sendWithImage(jid, content, options = {}) {
    const text = (typeof content === 'string') ? content : (content.text || '');
    const mentions = (typeof content === 'object' && content.mentions) ? content.mentions : undefined;
    const quoted = (typeof content === 'object' && content.quoted) ? content.quoted : undefined;

    if (options.skipImage) {
      const msg = { text };
      if (mentions) msg.mentions = mentions;
      if (quoted) msg.quoted = quoted;
      return sock.sendMessage(jid, msg);
    }

    try {
      const buf = await fetchImageBuffer();
      if (buf) {
        const msg = { image: buf, caption: text };
        if (mentions) msg.mentions = mentions;
        if (quoted) msg.quoted = quoted;
        return await sock.sendMessage(jid, msg);
      }
    } catch (err) {
      console.warn(`[${sessionId}] envoi image buffer échoué:`, err);
    }

    try {
      const url = IMAGE_URLS[Math.floor(Math.random() * IMAGE_URLS.length)];
      const msg = { image: { url }, caption: text };
      if (mentions) msg.mentions = mentions;
      if (quoted) msg.quoted = quoted;
      return await sock.sendMessage(jid, msg);
    } catch (err) {
      console.warn(`[${sessionId}] envoi image url échoué:`, err);
    }

    const msg = { text };
    if (mentions) msg.mentions = mentions;
    if (quoted) msg.quoted = quoted;
    return sock.sendMessage(jid, msg);
  }

  async function quickReply(jid, text, opts = {}) {
    return sendWithImage(jid, text, opts);
  }

  // helpers destinés au traitement de messages
  function getSenderId(msg) {
    return (msg.key && msg.key.participant) ? msg.key.participant : msg.key.remoteJid;
  }
  function getNumberFromJid(jid) {
    if (!jid) return '';
    return jid.split('@')[0];
  }
  function getDisplayName(msg) {
    return msg.pushName || (msg.message && msg.message?.extendedTextMessage?.contextInfo?.participant) || 'Utilisateur';
  }

  async function isGroupAdminFn(jid, participantId) {
    try {
      const meta = await sock.groupMetadata(jid);
      const p = meta.participants.find(x => x.id === participantId);
      return !!(p && (p.admin || p.admin === 'superadmin'));
    } catch (e) {
      return false;
    }
  }

  // connection.update handler
  sock.ev.on('connection.update', async (update) => {
    try {
      const { connection, qr, lastDisconnect } = update;
      if (qr) {
        try {
          const dataUrl = await QRCode.toDataURL(qr);
          socket.emit('qr', { sessionId, qrDataUrl: dataUrl });
        } catch (e) {
          socket.emit('qr', { sessionId, qrString: qr });
        }
      }

      if (connection === 'open') {
        try {
          if (sock.user && (sock.user.id || sock.user.jid)) {
            sessionObj.botId = (sock.user.id || sock.user.jid);
          } else if (sock.user) {
            sessionObj.botId = sock.user;
          }
        } catch (e) { /* ignore */ }

        try {
          const me = sock.user?.id || sock.user?.jid || (sock.user && sock.user[0] && sock.user[0].id);
          if (me) {
            const ownerNum = (typeof me === 'string' && me.includes('@')) ? me.split('@')[0] : String(me);
            sessionObj.sessionOwnerNumber = ownerNum.replace(/\D/g, '');
            console.log(`[${sessionId}] sessionOwnerNumber détecté automatiquement: ${sessionObj.sessionOwnerNumber}`);
          }
        } catch (e) {
          console.warn(`[${sessionId}] impossible de détecter session owner automatiquement`, e);
        }

        console.log(`[${sessionId}] Connecté (dossier=${folderName})`);
        socket.emit('connected', { sessionId, folderName });
        try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ connectedAt: Date.now(), phone: sessionObj.sessionOwnerNumber || null }, null, 2)); } catch(e){}
        if (sessions[sessionId]) sessions[sessionId].restarting = false;
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error || {}).output?.statusCode || null;
        console.log(`[${sessionId}] Connexion fermée, code=${code}`);
        socket.emit('disconnected', { sessionId, reason: code });

        if (code === DisconnectReason.loggedOut) {
          try { sock.end(); } catch(e){}
          delete sessions[sessionId];
          return;
        }

        if (code === DisconnectReason.restartRequired || code === 515) {
          console.log(`[${sessionId}] redémarrage requis (code ${code}). Tentative de ré-init.`);
          if (sessions[sessionId]) sessions[sessionId].restarting = true;
          try { sock.end(); } catch(e){}
          delete sessions[sessionId];

          const attempt = (opts && opts.attempt) ? opts.attempt : 0;
          const delay = Math.min(30000, 2000 + attempt * 2000);
          setTimeout(() => {
            startBaileysForSession(sessionId, folderName, socket, { attempt: attempt + 1 })
              .then(() => socket.emit('restarted', { sessionId, folderName }))
              .catch(err => {
                console.error(`[${sessionId}] restart failed`, err);
                socket.emit('error', { message: "Le redémarrage a échoué", detail: String(err) });
              });
          }, delay);
          return;
        }

        try { sock.end(); } catch(e){}
        delete sessions[sessionId];
        setTimeout(() => {
          startBaileysForSession(sessionId, folderName, socket, { attempt: 0 })
            .then(() => socket.emit('reconnected', { sessionId, folderName }))
            .catch(err => {
              console.error(`[${sessionId}] reconnect failed`, err);
              socket.emit('error', { message: "La reconnexion a échoué", detail: String(err) });
            });
        }, 5000);
      }
    } catch (err) {
      console.error('connection.update handler error', err);
    }
  });

  function buildMenu(pushName = 'Utilisateur') {
    return `*○ Menu*\n\n` +
`  *${BOT_NAME}*\n` +
`────────────────────────────\n` +
`🚶🏻‍♂️ Utilisateur: "${pushName}"\n` +
`🥀 Propriétaire: *${OWNER_NAME}*\n\n` +
`────────────────────────────\n` +
`📂 Commandes:\n` +
`────────────────────────────\n\n` +

`🔱 *Général*\n` +
`*● Menu*\n` +
`*● Interdire*\n` +
`*○ Owner*\n` +
`*○ Signale*\n` +
`*● Qr [texte]*\n\n` +

`🔱 *Groupe*\n` +
`*○ Lien*\n` +
`*● Tagall*\n` +
`*○ Hidetag*\n` +
`*● Kick*\n` +
`*○ Add*\n` +
`*● Promote*\n` +
`*○ Demote*\n` +
`*● Kickall*\n` +
`*○ Ferme*\n` +
`*● Ouvert*\n` +
`*○ Bienvenue [off]*\n\n` +

`🔱 *Modération*\n` +
`*● Nolien*\n` +
`*○ Nolien2*\n` +
`*● Kickall*\n` +
`*○ Kick*\n` +
`*● Add*\n` +
`*○ Promote*\n` +
`*● Delmote*\n\n` +

`  *${BOT_NAME}*\n` +
`────────────────────────────\n` +
`> *Superman*`;
  }

  function resolveTargetIds({ jid, m, args }) {
    const ids = [];
    const ctx = m.extendedTextMessage?.contextInfo || {};
    if (ctx.mentionedJid && Array.isArray(ctx.mentionedJid) && ctx.mentionedJid.length) {
      return ctx.mentionedJid;
    }
    if (ctx.participant) ids.push(ctx.participant);
    if (args && args.length) {
      for (const a of args) {
        if (!a) continue;
        if (a.includes('@')) { ids.push(a); continue; }
        const cleaned = a.replace(/[^0-9+]/g, '');
        if (!cleaned) continue;
        const noPlus = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
        ids.push(`${noPlus}@s.whatsapp.net`);
      }
    }
    return Array.from(new Set(ids));
  }

  // --- MAIN message handler ---
  sock.ev.on('messages.upsert', async (up) => {
    try {
      const messages = up.messages || [];
      if (!messages.length) return;
      const msg = messages[0];
      if (!msg || !msg.message) return;

      const jid = msg.key.remoteJid;
      const isGroup = jid && jid.endsWith && jid.endsWith('@g.us');

      // ignore status
      if (msg.key && msg.key.remoteJid === 'status@broadcast') return;

      // extract text for cmd parsing (best-effort)
      let raw = '';
      const m = msg.message;
      if (m.conversation) raw = m.conversation;
      else if (m.extendedTextMessage?.text) raw = m.extendedTextMessage.text;
      else if (m.imageMessage?.caption) raw = m.imageMessage.caption;
      else if (m.videoMessage?.caption) raw = m.videoMessage.caption;
      else if (m.documentMessage?.caption) raw = m.documentMessage.caption;
      else raw = '';

      const textRaw = (raw || '').toString().trim();
      const withoutDot = textRaw.startsWith('.') ? textRaw.slice(1) : textRaw;
      const parts = withoutDot.split(/\s+/).filter(Boolean);
      const cmd = (parts[0] || '').toLowerCase();
      const args = parts.slice(1);
      const argText = args.join(' ').trim();

      // sender info
      const senderId = getSenderId(msg) || jid;
      const senderNumber = getNumberFromJid(senderId);
      const pushName = getDisplayName(msg) || 'Utilisateur';

      // owner/session owner detection
      const sessionOwnerNumber = sessionObj.sessionOwnerNumber || OWNER_NUMBER; // scanner QR ou fallback
      const isOwner = (senderNumber === OWNER_NUMBER) || (senderNumber === sessionOwnerNumber);
      const isAdmin = isGroup ? await isGroupAdminFn(jid, senderId) : false;

      // PRIVÉ: si global.mode === 'private', ne répondre qu'au scanner (sessionOwnerNumber) ou OWNER_NUMBER
      if (global.mode === 'private') {
        if (!((senderNumber === sessionOwnerNumber) || (senderNumber === OWNER_NUMBER))) {
          return;
        }
      }

      // LINK ENFORCEMENT
      try {
        const containsLink = messageContainsLink(msg);
        if (isGroup && containsLink) {
          const mode = sessionObj.noLienMode[jid] || 'off';

          // EXCEPTION: do NOT delete if message is an image with caption containing the link.
          // (User requested: "Nolien ... pa dwe supprimé lien url image ki paret ak koman lan")
          const isImageWithCaptionLink = !!(m.imageMessage && m.imageMessage.caption && LINK_REGEX.test(m.imageMessage.caption));

          if (msg.key && msg.key.fromMe) {
            // don't delete our own messages
          } else if (isImageWithCaptionLink) {
            // skip deletion for image-with-caption links
            console.log(`[SKIP] image-caption link ignored group=${jid} sender=${senderId} caption="${(m.imageMessage.caption||'').slice(0,120)}"`);
          } else if (mode === 'exceptAdmins') {
            // nolien: delete messages with links EXCEPT if sender is admin/owner
            if (!isAdmin && !isOwner) {
              try {
                await sock.sendMessage(jid, { delete: msg.key });
                console.log(`[DEL] nolien: group=${jid} sender=${senderId} snippet="${(textRaw||'').slice(0,120)}"`);
              } catch (e) { console.warn(`[DEL_ERR] nolien delete failed group=${jid} sender=${senderId}`, e); }
              return;
            }
          } else if (mode === 'all') {
            // nolien2: delete messages with links for ALL users (including admins)
            try {
              await sock.sendMessage(jid, { delete: msg.key });
              console.log(`[DEL] nolien2: group=${jid} sender=${senderId} snippet="${(textRaw||'').slice(0,120)}"`);
            } catch (e) { console.warn(`[DEL_ERR] nolien2 delete failed group=${jid} sender=${senderId}`, e); }
            return;
          }
        }
      } catch (e) { /* ignore link enforcement errors */ }

      // invisible mode behavior
      if (isGroup && sessionObj.invisibleMode[jid]) {
        try { await sendWithImage(jid, 'ㅤ   '); } catch (e) {}
        return;
      }

      // DEBUG
      console.log(`[${sessionId}] MSG from=${jid} sender=${senderId} cmd=${cmd} text="${(textRaw||'').slice(0,120)}"`);

      // --- COMMANDS ---
      switch (cmd) {
        case 'd':
        case 'menu':
          await sendWithImage(jid, buildMenu(pushName));
          break;

        case 'nolien':
          if (!isGroup) return await quickReply(jid, 'Seulement pour groupe.');
          if (!(isAdmin || isOwner)) return await quickReply(jid, 'Seul admin/owner peut activer.');
          // support "nolien off" to disable
          if (argText && argText.toLowerCase() === 'off') {
            sessionObj.noLienMode[jid] = 'off';
            await quickReply(jid, 'Mode nolien désactivé.');
            console.log(`[MODE] nolien OFF for ${jid}`);
          } else {
            sessionObj.noLienMode[jid] = 'exceptAdmins';
            await quickReply(jid, 'Mode nolien activé : tous les liens seront supprimés SAUF ceux des admins.');
            console.log(`[MODE] nolien EXCEPT_ADMINS for ${jid} (nolien2 disabled)`);
          }
          break;

        case 'nolien2':
          if (!isGroup) return await quickReply(jid, 'Seulement pour groupe.');
          if (!(isAdmin || isOwner)) return await quickReply(jid, 'Seul admin/owner peut activer.');
          // support "nolien2 off" to disable
          if (argText && argText.toLowerCase() === 'off') {
            sessionObj.noLienMode[jid] = 'off';
            await quickReply(jid, 'Mode nolien2 désactivé.');
            console.log(`[MODE] nolien2 OFF for ${jid}`);
          } else {
            sessionObj.noLienMode[jid] = 'all';
            await quickReply(jid, 'Mode nolien2 activé : tous les liens seront supprimés (même admin).');
            console.log(`[MODE] nolien2 ALL for ${jid} (nolien disabled)`);
          }
          break;

        case 'bienvenue':
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nBienvenue pour groupe seulement.`); break; }
          if (!(await isGroupAdminFn(jid, senderId)) && !isOwner) { await sendWithImage(jid, `${BOT_NAME}\nTu n'es pas admin.`); break; }
          sessionObj.bienvenueEnabled[jid] = !(argText && argText.toLowerCase() === 'off');
          await sendWithImage(jid, `${BOT_NAME}\nBienvenue : ${sessionObj.bienvenueEnabled[jid] ? 'ON' : 'OFF'}`);
          break;

        // rest of your commands unchanged (kept as in previous file)
        // ... (keep all other command cases from your original file) ...

        default:
          // pas de commande connue => rien faire
          break;
      }

    } catch (err) {
      console.error('messages.upsert handler error', err);
    }
  });

  // bienvenue handler: envoie message si activé — ONLY on join (action === 'add')
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const action = update.action || update.type || null;
      if (action !== 'add') return; // ignore leave/remove
      const gid = update.id || update.jid || update.groupId;
      if (!gid) return;
      if (!sessionObj.bienvenueEnabled[gid]) return;
      const meta = await sock.groupMetadata(gid);
      const groupName = meta.subject || '';
      for (const p of (update.participants || [])) {
        const userJid = typeof p === 'string' ? p : p?.id;
        if (!userJid) continue;
        const txt = `Bienvenue @${userJid.split('@')[0]} dans ${groupName}`;
        await sendWithImage(gid, { text: txt, mentions: [userJid] });
      }
    } catch (e) { console.error('bienvenue error', e); }
  });

  return sessionObj;
}

// socket.io UI handlers
io.on('connection', (socket) => {
  console.log('Client web connecté', socket.id);

  socket.on('create_session', async (payload) => {
    try {
      const profile = (payload && payload.profile) ? String(payload.profile) : 'unknown';
      const name = (payload && payload.name) ? String(payload.name) : '';
      const phone = (payload && payload.phone) ? String(payload.phone) : '';

      const folderName = nextAuthFolder();
      const sessionId = uuidv4();

      const dir = path.join(SESSIONS_BASE, folderName);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const meta = { sessionId, folderName, profile, name, phone, createdAt: Date.now() };
      try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2)); } catch(e){}

      await startBaileysForSession(sessionId, folderName, socket);

      socket.emit('session_created', { sessionId, folderName });
    } catch (err) {
      console.error('create_session error', err);
      socket.emit('error', { message: "Échec de la création de session", detail: String(err) });
    }
  });

  socket.on('list_sessions', () => {
    const arr = fs.readdirSync(SESSIONS_BASE).filter(n => n.startsWith('auth_info')).map(n => {
      let meta = {};
      const metaPath = path.join(SESSIONS_BASE, n, 'meta.json');
      if (fs.existsSync(metaPath)) {
        try { meta = JSON.parse(fs.readFileSync(metaPath)); } catch (e) {}
      }
      const inMem = Object.values(sessions).find(s => s.folderName === n);
      return { folder: n, meta, online: !!inMem, lastSeen: meta.connectedAt || null };
    });
    socket.emit('sessions_list', arr);
  });

  socket.on('destroy_session', (payload) => {
    try {
      if (!payload || !payload.folder) return socket.emit('error', { message: 'folder required' });
      const folder = payload.folder;
      const target = Object.entries(sessions).find(([k, v]) => v.folderName === folder);
      if (target) {
        const [sid, val] = target;
        try { val.sock.end(); } catch(e){}
        delete sessions[sid];
      }
      const full = path.join(SESSIONS_BASE, folder);
      if (fs.existsSync(full)) fs.rmSync(full, { recursive: true, force: true });
      socket.emit('session_destroyed', { folder });
    } catch (err) {
      console.error('destroy_session error', err);
      socket.emit('error', { message: "Échec de la suppression de session", detail: String(err) });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('Client web déconnecté', socket.id, 'raison:', reason);
  });
});

// logs
process.on('uncaughtException', (err) => console.error('uncaughtException', err));
process.on('unhandledRejection', (reason) => console.error('unhandledRejection', reason));

// start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur démarré sur http://localhost:${PORT} (port ${PORT})`));
