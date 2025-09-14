// referral.js — implementation minimale en mémoire
const db = {
  users: {},   // jid -> { jid, name, code, used: Set, count, reward }
  codes: {}    // code -> inviterJid
};

function randomCode(len = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i=0;i<len;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

module.exports = {
  init: async () => { return Promise.resolve(); },

  getOrCreateUser: async (jid, opts = {}) => {
    if (!db.users[jid]) {
      db.users[jid] = { jid, name: opts.name || null, code: null, used: new Set(), count: 0, reward: 0 };
    }
    return db.users[jid];
  },

  generateCodeFor: async (jid, preferred = '') => {
    if (!db.users[jid]) await module.exports.getOrCreateUser(jid, { name: preferred });
    if (!db.users[jid].code) {
      let code;
      do { code = (preferred ? String(preferred).toUpperCase().slice(0,4) : '') + randomCode(4); } while (db.codes[code]);
      db.users[jid].code = code;
      db.codes[code] = jid;
    }
    return db.users[jid].code;
  },

  useCode: async (useeJid, code) => {
    code = String(code || '').toUpperCase();
    if (!code) return { ok: false, reason: 'NO_CODE' };
    const inviter = db.codes[code];
    if (!inviter) return { ok: false, reason: 'CODE_NOT_FOUND' };
    if (inviter === useeJid) return { ok: false, reason: 'OWN_CODE' };
    const u = db.users[useeJid] || { used: new Set() };
    if (u.used && u.used.has(code)) return { ok: false, reason: 'ALREADY_USED_BY_THIS' };
    // apply
    if (!db.users[useeJid]) db.users[useeJid] = { jid: useeJid, name: null, code: null, used: new Set(), count: 0, reward: 0 };
    db.users[useeJid].used.add(code);
    db.users[inviter].count = (db.users[inviter].count||0) + 1;
    db.users[inviter].reward = (db.users[inviter].reward||0) + 1;
    return { ok: true, inviter };
  },

  getStats: async (jidOrPhone) => {
    // accept either full jid or plain number
    let jid = jidOrPhone;
    if (!jid) return null;
    if (!jid.includes('@')) {
      jid = `${String(jid)}@s.whatsapp.net`;
    }
    return db.users[jid] || null;
  }
};
