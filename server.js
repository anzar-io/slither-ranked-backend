'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { calculateEloGain } = require('./elo');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 10000;
const HOST = process.env.HOST || '0.0.0.0';      // 0.0.0.0 pour exposer le serveur sur Render
const ADMIN_KEY = process.env.ADMIN_KEY || '';      // vide = routes admin désactivées
// DATA_DIR = dossier où players.json est stocké. Sur Render, pointe-le vers le disque persistant (ex: /var/data).
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'players.json');
if (process.env.RENDER && !process.env.DATA_DIR && !process.env.DATABASE_URL) {
    console.warn('⚠️ Neither DATABASE_URL nor DATA_DIR is set: players.json is on a temporary disk and will be LOST at every restart/redeploy.');
}

const LIMITS = {
    LEADERBOARD_SIZE: 50,
    ADMIN_MATCH_LIST: 200   // number of recent matches shown on the admin page
};

const RANKS = [
    { name: 'Bronze',     min: 0,     max: 1500,  fee: 0 },
    { name: 'Silver',     min: 1500,  max: 3000,  fee: 10 },
    { name: 'Gold',         min: 3000,  max: 4500,  fee: 30 },
    { name: 'Diamond',    min: 4500,  max: 7000,  fee: 50 },
    { name: 'Mythic',   min: 7000,  max: 9500,  fee: 75 },
    { name: 'Legendary', min: 9500,  max: 12000, fee: 85 },
    { name: 'Master',     min: 12000, max: 15000, fee: 100 },
    { name: 'Pro',        min: 15000, max: 25000, fee: 135 }
];
const HIGH_RANKS = ['Mythic', 'Legendary', 'Master']; // ranks where a big game is split between the old and the new rank

// Official ranked game servers. A game played elsewhere is still saved, but flagged in /admin so you can cancel it.
const OFFICIAL_SERVERS = ['92.222.100.202:444', '198.244.231.35:444', '57.129.37.42:444'];
const cleanServer = (v) => (typeof v === 'string' && /^[0-9a-zA-Z.:\[\]-]{3,60}$/.test(v)) ? v : '';

const rankByName = (name) => RANKS.find(r => r.name === name) || RANKS[0];
const rankFromElo = (elo) => {
    for (let i = RANKS.length - 1; i >= 0; i--) if (elo >= RANKS[i].min) return RANKS[i].name;
    return RANKS[0].name;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ID_RE = /^user_[a-z0-9]{1,16}_\d{10,15}$/;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const publicIdOf = (uuid) => sha256(uuid).slice(0, 12);
const safeEqual = (a, b) => {
    const ba = Buffer.from(a), bb = Buffer.from(b);
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

function cleanNickname(n) {
    if (typeof n !== 'string') return 'Player';
    n = n.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s*@.*$/, '').trim().slice(0, 24);
    return n || 'Player';
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

// ---------------------------------------------------------------------------
// Storage: PostgreSQL if DATABASE_URL is set (recommended online), otherwise the players.json file
// ---------------------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL || '';
let db = {};              // all players, kept in memory, key = player UUID
let pool = null;          // PostgreSQL connection pool (only when DATABASE_URL is set)
let writeChain = Promise.resolve();

// Checks a stored record and fills in missing fields. Returns false if the record must be ignored.
function acceptRecord(id, rec) {
    if (!(ID_RE.test(id) && rec && rec.tokenHash && rec.publicId)) return false;
    rec.matches = Array.isArray(rec.matches) ? rec.matches : [];
    for (const m of rec.matches) {
        if (!m.id) m.id = crypto.randomUUID();
        if (typeof m.at !== 'number') m.at = 0;
        m.cancelled = m.cancelled === true;
    }
    db[id] = rec;
    return true;
}

// ----- file mode -----
function loadDatabase() {
    if (!fs.existsSync(DB_FILE)) return;
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
        const backup = `${DB_FILE}.corrupt-${Date.now()}`;
        fs.copyFileSync(DB_FILE, backup);
        console.error(`⚠️ players.json is unreadable, backed up to ${backup}. Starting empty.`);
        return;
    }
    let dropped = 0;
    for (const [id, rec] of Object.entries(raw || {})) {
        if (!acceptRecord(id, rec)) dropped++;
    }
    if (dropped > 0) {
        const backup = `${DB_FILE}.legacy-${Date.now()}`;
        fs.copyFileSync(DB_FILE, backup);
        console.log(`ℹ️ ${dropped} old entries (old nickname-based format) ignored, copy saved in ${backup}`);
    }
    console.log(`📂 ${Object.keys(db).length} player(s) loaded`);
}

function saveDatabase() {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, DB_FILE); // atomic write
}

// ----- PostgreSQL mode (one row per player) -----
async function loadDatabaseFromPostgres() {
    const { Pool } = require('pg');
    pool = new Pool({
        connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false },
        max: 5,
        connectionTimeoutMillis: 15000,   // waking Neon can take a few seconds, but never wait forever
        query_timeout: 15000,             // a query that hangs is cut after 15 s instead of blocking everything
        idleTimeoutMillis: 10000,         // drop idle connections before Neon silently kills them
        keepAlive: true
    });
    pool.on('error', (e) => console.error('[DB] idle connection error:', e.message));
    await pool.query('CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, data JSONB NOT NULL)');
    const result = await pool.query('SELECT id, data FROM players');
    for (const row of result.rows) acceptRecord(row.id, row.data);
    console.log(`🐘 ${Object.keys(db).length} player(s) loaded from PostgreSQL`);
}

// ----- Saving players -----
// Every change marks the player as "dirty". Saves are grouped: after a change the server waits 2 seconds, then writes
// ALL changed players in ONE database request (so 8 games ending together cost 1 write, not 8). A failed write is
// retried 3 times, and anything still dirty is retried every 30 s and when the server stops. A slow or sleeping
// database delays a save but never loses it, and the player never waits for it.
const BATCH_SQL = 'INSERT INTO players (id, data) SELECT t.id, t.data::jsonb FROM unnest($1::text[], $2::text[]) AS t(id, data) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data';
const FLUSH_DELAY_MS = 2000;
const dirty = new Map();   // uuid -> version number of the latest change
let versionCounter = 0;
let flushPromise = null;   // a grouped save is already scheduled
let flushChain = Promise.resolve();   // saves run one after the other, so an old save can never overwrite a newer one
const stats = { changed: 0, saved: 0, failed: 0 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function doFlush() {
    const batch = [...dirty.entries()].filter(([uuid]) => db[uuid]);
    if (batch.length === 0) { dirty.clear(); return true; }
    const ids = batch.map(([uuid]) => uuid);
    const datas = batch.map(([uuid]) => JSON.stringify(db[uuid]));
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await pool.query(BATCH_SQL, [ids, datas]);
            for (const [uuid, version] of batch) if (dirty.get(uuid) === version) dirty.delete(uuid);   // keep it dirty if it changed meanwhile
            stats.saved += batch.length;
            return true;
        } catch (e) {
            stats.failed++;
            console.error(`[DB] write failed for ${batch.length} player(s) (attempt ${attempt}/3): ${e.message}`);
            if (attempt < 3) await sleep(1000 * attempt);
        }
    }
    return false;
}

function flushOnce() {
    const p = flushChain.then(doFlush);
    flushChain = p.catch(() => {});
    return p;
}

async function flushDirty() {
    if (flushPromise) await flushPromise.catch(() => {});
    await flushOnce();
    if (dirty.size > 0) console.warn(`[DB] ${dirty.size} player(s) still waiting to be saved`);
}

function persistPlayer(uuid) {
    if (!pool) { saveDatabase(); return Promise.resolve(); }
    dirty.set(uuid, ++versionCounter);
    stats.changed++;
    if (!flushPromise) {
        flushPromise = (async () => {
            try {
                let ok = true;
                do { await sleep(FLUSH_DELAY_MS); ok = await flushOnce(); } while (ok && dirty.size > 0);
            } catch (e) {
                console.error('[DB] unexpected:', e.message);
            } finally {
                flushPromise = null;
            }
        })();
    }
    return flushPromise;
}

// One summary line per minute (only when something happened), to see at a glance if saves keep up.
setInterval(() => {
    if (!pool || (stats.changed === 0 && stats.failed === 0 && dirty.size === 0)) return;
    console.log(`[STATS] last minute: ${stats.changed} change(s), ${stats.saved} saved, ${stats.failed} failed attempt(s), ${dirty.size} waiting`);
    stats.changed = stats.saved = stats.failed = 0;
}, 60000).unref();

function findByPublicId(publicId) {
    return Object.entries(db).find(([, p]) => p.publicId === publicId) || null;
}

const sortedPlayers = () => Object.values(db).filter(p => !p.hidden).sort((a, b) => b.elo - a.elo);

function newRecord(uuid, token, nickname) {
    return {
        publicId: publicIdOf(uuid),
        tokenHash: sha256(token),
        name: nickname,
        elo: 0,
        rank: 'Bronze',
        matches: []
    };
}

// ---------------------------------------------------------------------------
// Logique Elo
// ---------------------------------------------------------------------------
// The fee is paid once per game. For Mythic / Legendary / Master, when a game is big enough to cross into the next rank,
// the part of the game needed to fill the current rank to 100% is paid with the CURRENT rank's formula, and the rest of
// the game (the surplus) is paid with the NEW rank's formula. A single game can therefore cross several ranks if it is huge,
// but every rank it goes through pays at its own rate.
function computeMatch(elo, rank, score, duration) {
    let e = elo - rankByName(rank).fee;   // Elo after paying the entry fee
    let r = rank;
    let remaining = 1;                    // share of the game not paid yet
    for (let step = 0; step < 4; step++) {
        const info = rankByName(r);
        const part = calculateEloGain(score, duration, r, 0) * remaining;   // what this rank would pay for the remaining share
        const canCross = HIGH_RANKS.includes(r) && r !== 'Pro';
        if (canCross && part > 0 && e < info.max && e + part > info.max) {
            const need = info.max - e;
            remaining *= (1 - need / part);
            e = info.max;
            r = rankFromElo(e);
            console.log(`[RANK UP] Crossing ${info.name} -> ${r}: ${Math.round(need)} Elo paid at ${info.name} rate, surplus paid at ${r} rate.`);
            continue;
        }
        e += part;
        break;
    }
    const eloChange = Math.round(e - elo);
    const newElo = Math.max(0, elo + eloChange);
    return { eloChange, newElo, newRank: rankFromElo(newElo) };
}

function applyMatch(rec, score, duration, gameId, server) {
    const oldRank = rec.rank;
    const r = computeMatch(rec.elo, rec.rank, score, duration);
    rec.elo = r.newElo;
    rec.rank = r.newRank;
    rec.matches.push({
        id: crypto.randomUUID(),
        gameId: gameId || null,
        server: server || '',
        score,
        duration,
        change: r.eloChange,
        time: new Date().toLocaleTimeString('en-GB'),
        at: Date.now(),
        cancelled: false
    });
    return { eloChange: r.eloChange, oldRank };
}

function recomputePlayer(rec) {
    rec.elo = 0;
    rec.rank = 'Bronze';
    for (const m of rec.matches) {
        if (m.cancelled) { m.change = 0; continue; }
        if (m.manual) {   // a manual admin adjustment: a fixed number of Elo, never recalculated
            rec.elo = Math.max(0, rec.elo + m.change);
            rec.rank = rankFromElo(rec.elo);
            continue;
        }
        const r = computeMatch(rec.elo, rec.rank, m.score, m.duration);
        m.change = r.eloChange;
        rec.elo = r.newElo;
        rec.rank = r.newRank;
    }
}

const visibleMatches = (rec) => rec.matches.filter(m => !m.cancelled && !m.manual);
const publicMatch = (m) => ({ score: m.score, duration: m.duration, change: m.change, time: m.time });

// ---------------------------------------------------------------------------
// App & middlewares
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);   // Render sits in front of the server: use the visitor's real IP
app.use(cors());
app.use(express.json({ limit: '10kb' }));

const adminFails = new Map();   // ip -> timestamps of wrong admin keys
setInterval(() => adminFails.clear(), 15 * 60 * 1000).unref();

function requireAdmin(req, res, next) {
    if (!ADMIN_KEY) return res.status(404).json({ success: false, error: 'Not found' });

    const now = Date.now();
    const fails = (adminFails.get(req.ip) || []).filter(t => now - t < 15 * 60 * 1000);
    if (fails.length >= 10) {
        return res.status(429).json({ success: false, error: 'Too many wrong admin keys, try again in 15 minutes' });
    }

    const key = req.get('x-admin-key') || '';
    if (!safeEqual(sha256(key), sha256(ADMIN_KEY))) {
        fails.push(now);
        adminFails.set(req.ip, fails);
        return res.status(403).json({ success: false, error: 'Invalid admin key' });
    }
    next();
}

// ---------------------------------------------------------------------------
// API publique
// ---------------------------------------------------------------------------
// Used by an uptime monitor to keep the free Render server awake. It does not touch the database.
app.get('/health', (req, res) => res.type('text').send('ok'));

app.get('/api/playerdata', (req, res) => {
    const playerId = req.query.playerId;
    if (typeof playerId !== 'string' || !ID_RE.test(playerId)) {
        return res.status(400).json({ success: false, error: 'Invalid playerId' });
    }

    const all = sortedPlayers();
    const rec = db[playerId];
    const player = rec
        ? { id: rec.publicId, name: rec.name, elo: rec.elo, rank: rec.rank,
            position: all.indexOf(rec) >= 0 ? all.indexOf(rec) + 1 : null, matches: visibleMatches(rec).slice(-5).map(publicMatch) }
        : { id: publicIdOf(playerId), name: 'Player', elo: 0, rank: 'Bronze', position: null, matches: [] };

    const leaderboard = all.slice(0, LIMITS.LEADERBOARD_SIZE)
        .map(p => ({ id: p.publicId, name: p.name, elo: p.elo, rank: p.rank }));

    res.json({ success: true, player, leaderboard });
});

app.post('/api/matches/submit', async (req, res) => {
    const b = req.body || {};
    const { playerId, playerToken } = b;

    if (typeof playerId !== 'string' || !ID_RE.test(playerId)) return res.status(400).json({ success: false, error: 'Invalid playerId' });
    if (typeof playerToken !== 'string' || playerToken.length < 16 || playerToken.length > 128) {
        return res.status(400).json({ success: false, error: 'Invalid playerToken' });
    }
    const score = Math.floor(Number(b.finalScore));
    const duration = Math.floor(Number(b.durationSeconds));
    if (!Number.isFinite(score) || score <= 0 || !Number.isFinite(duration) || duration <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid data' });
    }

    let rec = db[playerId];
    if (!rec) {
        rec = db[playerId] = newRecord(playerId, playerToken, cleanNickname(b.nickname));
    } else if (!safeEqual(sha256(playerToken), rec.tokenHash)) {
        return res.status(403).json({ success: false, error: 'Invalid token' });
    }

    rec.name = cleanNickname(b.nickname);

    // The same game can arrive twice (the player's script retries). It must only count once.
    const gameId = (typeof b.gameId === 'string' && /^match_[a-z0-9]{1,16}_\d{10,15}$/.test(b.gameId)) ? b.gameId : null;
    if (gameId) {
        const dup = rec.matches.find(m => m.gameId === gameId);
        if (dup) return res.json({ success: true, eloChange: dup.change, newElo: rec.elo, newRank: rec.rank, duplicate: true });
    }

    const { eloChange, oldRank } = applyMatch(rec, score, duration, gameId, cleanServer(b.server));
    persistPlayer(playerId);   // saved in the background (with retries): the player never waits for the database

    console.log(`[MATCH] ${rec.name} | Server: ${cleanServer(b.server) || '?'}${cleanServer(b.server) && !OFFICIAL_SERVERS.includes(cleanServer(b.server)) ? ' (NOT OFFICIAL)' : ''} | Old rank: ${oldRank} | Score: ${score} | Duration: ${duration}s | Delta: ${eloChange} | Total: ${rec.elo} Elo (${rec.rank})`);
    res.json({ success: true, eloChange, newElo: rec.elo, newRank: rec.rank });
});

// ---------------------------------------------------------------------------
// API admin
// ---------------------------------------------------------------------------
app.post('/api/admin/simulate', requireAdmin, async (req, res) => {
    const found = findByPublicId(req.body.publicId);
    const score = Math.floor(Number(req.body.score));
    const duration = Math.floor(Number(req.body.duration)) || 120;
    if (!found || !Number.isFinite(score) || score <= 0) return res.status(400).json({ success: false, error: 'Invalid parameters' });
    const [uuid, rec] = found;
    const result = applyMatch(rec, score, duration);
    await persistPlayer(uuid);
    res.json({ success: true, ...result, newElo: rec.elo, newRank: rec.rank });
});

app.post('/api/admin/reset', requireAdmin, async (req, res) => {
    const found = findByPublicId(req.body.publicId);
    if (!found) return res.status(404).json({ success: false, error: 'Player not found' });
    const [uuid, rec] = found;
    rec.elo = 0; rec.rank = 'Bronze'; rec.matches = [];
    await persistPlayer(uuid);
    console.log(`[RESET] Profile of ${rec.name} was reset.`);
    res.json({ success: true });
});

app.get('/api/admin/players', requireAdmin, (req, res) => {
    const rows = Object.values(db).map(p => ({
        publicId: p.publicId, name: p.name, elo: p.elo, rank: p.rank, hidden: p.hidden === true,
        games: p.matches.filter(m => !m.cancelled).length,
        last: p.matches.length ? p.matches[p.matches.length - 1].at || 0 : 0
    }));
    rows.sort((a, b) => b.last - a.last);
    res.json({ success: true, players: rows });
});

// Adds (or removes, with a negative number) a fixed amount of Elo. It is saved as a "manual" entry in the match list,
// so you can see it, cancel it, and it survives every recalculation.
app.post('/api/admin/adjust', requireAdmin, async (req, res) => {
    const { publicId, amount, note } = req.body || {};
    const found = findByPublicId(publicId);
    const n = Math.round(Number(amount));
    if (!found || !Number.isFinite(n) || n === 0 || Math.abs(n) > 20000) {
        return res.status(400).json({ success: false, error: 'Invalid parameters (amount must be a non-zero number, max 20000)' });
    }
    const [uuid, rec] = found;
    rec.matches.push({
        id: crypto.randomUUID(), gameId: null, manual: true,
        note: typeof note === 'string' ? note.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60) : '',
        score: 0, duration: 0, change: n,
        time: new Date().toLocaleTimeString('en-GB'), at: Date.now(), cancelled: false
    });
    rec.elo = Math.max(0, rec.elo + n);
    rec.rank = rankFromElo(rec.elo);
    await persistPlayer(uuid);
    console.log(`[ADMIN] Manual adjustment for ${rec.name}: ${n >= 0 ? '+' : ''}${n} Elo. New total: ${rec.elo} Elo (${rec.rank})`);
    res.json({ success: true, newElo: rec.elo, newRank: rec.rank });
});

// Hides a player from the leaderboard (nothing is deleted, it can be restored).
app.post('/api/admin/player', requireAdmin, async (req, res) => {
    const { publicId, hidden } = req.body || {};
    const found = findByPublicId(publicId);
    if (!found || typeof hidden !== 'boolean') return res.status(400).json({ success: false, error: 'Invalid parameters' });
    found[1].hidden = hidden;
    await persistPlayer(found[0]);
    console.log(`[ADMIN] Player ${found[1].name} (${publicId}) ${hidden ? 'hidden' : 'restored'}.`);
    res.json({ success: true });
});

app.get('/api/admin/matches', requireAdmin, (req, res) => {
    const rows = [];
    for (const rec of Object.values(db)) {
        for (const m of rec.matches) {
            rows.push({
                publicId: rec.publicId, player: rec.name, matchId: m.id,
                score: m.score, duration: m.duration, change: m.change,
                time: m.time, at: m.at, cancelled: m.cancelled, manual: m.manual === true, note: m.note || '', server: m.server || '', official: !m.server || OFFICIAL_SERVERS.includes(m.server),
                elo: rec.elo, rank: rec.rank
            });
        }
    }
    rows.sort((a, b) => b.at - a.at);
    res.json({ success: true, matches: rows.slice(0, LIMITS.ADMIN_MATCH_LIST) });
});

app.post('/api/admin/match', requireAdmin, async (req, res) => {
    const { publicId, matchId, cancelled } = req.body || {};
    const found = findByPublicId(publicId);
    const rec = found && found[1];
    const match = rec && rec.matches.find(m => m.id === matchId);
    if (!match || typeof cancelled !== 'boolean') return res.status(400).json({ success: false, error: 'Invalid parameters' });

    match.cancelled = cancelled;
    recomputePlayer(rec);
    await persistPlayer(found[0]);
    console.log(`[ADMIN] Match of ${rec.name} (${match.score} pts) ${cancelled ? 'cancelled' : 'restored'}. New total: ${rec.elo} Elo (${rec.rank})`);
    res.json({ success: true, newElo: rec.elo, newRank: rec.rank });
});

app.get('/admin', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Ranked Admin</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 20px; }
        h1 { color: #38bdf8; font-size: 22px; }
        .bar { display: flex; gap: 12px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
        input[type=text] { background: #1e293b; border: 1px solid #334155; color: #f8fafc; padding: 8px 10px; border-radius: 6px; width: 240px; }
        #status { color: #fbbf24; margin: 10px 0; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; background: #1e293b; border-radius: 10px; overflow: hidden; }
        th, td { padding: 9px 8px; text-align: center; border-bottom: 1px solid #334155; }
        th { color: #94a3b8; background: #172033; }
        td.name { color: #38bdf8; font-weight: bold; }
        tr.flagged td { background: rgba(251, 191, 36, 0.12); }
        tr.cancelled td { color: #64748b; text-decoration: line-through; }
        tr.cancelled td:last-child, tr.cancelled td:nth-last-child(2) { text-decoration: none; }
        button { background: #3b82f6; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 12px; }
        button.danger { background: #ef4444; }
        .hint { color: #94a3b8; font-size: 12px; margin-bottom: 12px; }
    </style>
</head>
<body>
    <h1>🛡️ Ranked Admin - Recent Matches</h1>
    <div class="hint">Rows highlighted in yellow have a very high points-per-minute rate and are worth checking. Cancelling a match recalculates the player's Elo as if it was never played. You can restore it at any time.</div>
    <div class="bar">
        <input type="text" id="filter" placeholder="Filter by player name...">
        <label><input type="checkbox" id="onlyFlag"> Only suspicious</label>
        <button id="refresh">Refresh</button>
    </div>
    <div id="status"></div>
    <h2 style="font-size:16px;color:#94a3b8;margin:18px 0 8px;">Players (most recently active first)</h2>
    <table>
        <thead><tr><th>Player</th><th>Rank</th><th>Elo</th><th>Games</th><th>ID</th><th>Status</th><th></th></tr></thead>
        <tbody id="players"></tbody>
    </table>
    <h2 style="font-size:16px;color:#94a3b8;margin:18px 0 8px;">Recent matches</h2>
    <table>
        <thead><tr><th>Date</th><th>Player</th><th>Score</th><th>Duration</th><th>Pts/min</th><th>Server</th><th>Elo change</th><th>Current Elo</th><th>Status</th><th></th></tr></thead>
        <tbody id="rows"></tbody>
    </table>
    <script>
        var PPM_WARN = 20000;
        var key = sessionStorage.getItem('adminKey') || '';
        var allMatches = [];
        var statusEl = document.getElementById('status');

        function setStatus(t) { statusEl.textContent = t; }

        function api(path, body) {
            var opts = { headers: { 'Content-Type': 'application/json', 'x-admin-key': key } };
            if (body) { opts.method = 'POST'; opts.body = JSON.stringify(body); }
            return fetch(path, opts);
        }

        async function load() {
            if (!key) key = prompt('Admin key') || '';
            if (!key) { setStatus('No key entered. Reload the page to try again.'); return; }
            var r = await api('/api/admin/matches');
            if (r.status === 404) { setStatus('Admin tools are disabled: start the server with ADMIN_KEY set.'); return; }
            if (r.status === 403) { sessionStorage.removeItem('adminKey'); key = ''; setStatus('Invalid admin key. Reload the page to try again.'); return; }
            sessionStorage.setItem('adminKey', key);
            allMatches = (await r.json()).matches;
            render();
            var pr = await api('/api/admin/players');
            if (pr.ok) renderPlayers((await pr.json()).players);
        }

        function cell(tr, text, cls) {
            var td = document.createElement('td');
            td.textContent = text;
            if (cls) td.className = cls;
            tr.appendChild(td);
        }

        function render() {
            setStatus('');
            var q = document.getElementById('filter').value.toLowerCase();
            var onlyFlag = document.getElementById('onlyFlag').checked;
            var tbody = document.getElementById('rows');
            tbody.textContent = '';
            allMatches.forEach(function(m) {
                var ppm = Math.round(m.score / (Math.max(m.duration, 1) / 60));
                var flagged = !m.manual && (ppm >= PPM_WARN || !m.official);
                if (q && m.player.toLowerCase().indexOf(q) === -1) return;
                if (onlyFlag && !flagged) return;
                var tr = document.createElement('tr');
                if (m.cancelled) tr.className = 'cancelled'; else if (flagged) tr.className = 'flagged';
                cell(tr, m.at ? new Date(m.at).toLocaleString('en-GB') : m.time);
                cell(tr, m.player, 'name');
                cell(tr, m.manual ? 'MANUAL' : m.score.toLocaleString('en-GB'));
                cell(tr, m.manual ? (m.note || '-') : m.duration + 's');
                cell(tr, m.manual ? '-' : ppm.toLocaleString('en-GB') + (flagged ? ' ⚠' : ''));
                cell(tr, m.manual ? '-' : (m.server || '?') + (m.official ? '' : ' ⚠'));
                cell(tr, m.cancelled ? '-' : (m.change >= 0 ? '+' : '') + m.change);
                cell(tr, m.elo + ' (' + m.rank + ')');
                cell(tr, m.cancelled ? 'Cancelled' : (m.manual ? 'Manual' : 'Counted'));
                var td = document.createElement('td');
                var btn = document.createElement('button');
                btn.textContent = m.cancelled ? 'Restore' : 'Cancel';
                if (!m.cancelled) btn.className = 'danger';
                btn.onclick = function() { toggle(m); };
                td.appendChild(btn);
                tr.appendChild(td);
                tbody.appendChild(tr);
            });
            if (!tbody.children.length) setStatus('No matches to show.');
        }

        function renderPlayers(list) {
            var tb = document.getElementById('players');
            tb.textContent = '';
            list.forEach(function(p) {
                var tr = document.createElement('tr');
                if (p.hidden) tr.className = 'cancelled';
                cell(tr, p.name, 'name'); cell(tr, p.rank); cell(tr, p.elo); cell(tr, p.games); cell(tr, p.publicId);
                cell(tr, p.hidden ? 'Hidden' : 'Visible');
                var td = document.createElement('td');
                var b = document.createElement('button');
                b.textContent = p.hidden ? 'Restore' : 'Hide';
                if (!p.hidden) b.className = 'danger';
                b.onclick = async function() {
                    var msg = (p.hidden ? 'Restore' : 'Hide from leaderboard') + ' ONLY this profile?\\n\\n' + p.name + ' | ' + p.rank + ' | ' + p.elo + ' Elo | ' + p.games + ' games | id ' + p.publicId;
                    if (!confirm(msg)) return;
                    var r = await api('/api/admin/player', { publicId: p.publicId, hidden: !p.hidden });
                    if (!r.ok) { alert('Error ' + r.status); return; }
                    await load();
                };
                var add = document.createElement('button');
                add.textContent = '+/- Elo';
                add.style.marginLeft = '6px';
                add.onclick = async function() {
                    var v = prompt('Add Elo to ' + p.name + ' (' + p.rank + ', ' + p.elo + ' Elo, id ' + p.publicId + ').\\nType a number (use a minus sign to remove):');
                    if (v === null || v === '') return;
                    var amount = Number(v);
                    if (!isFinite(amount) || amount === 0) { alert('Not a valid number'); return; }
                    var note = prompt('Short reason (optional, shown in the list):') || '';
                    if (!confirm('Give ' + (amount > 0 ? '+' : '') + amount + ' Elo to ' + p.name + ' (' + p.publicId + ')?')) return;
                    var r = await api('/api/admin/adjust', { publicId: p.publicId, amount: amount, note: note });
                    if (!r.ok) { alert('Error ' + r.status); return; }
                    await load();
                };
                td.appendChild(b); td.appendChild(add); tr.appendChild(td); tb.appendChild(tr);
            });
        }

        async function toggle(m) {
            var action = m.cancelled ? 'Restore' : 'Cancel';
            if (!confirm(action + ' this match of ' + m.player + ' (' + m.score + ' pts)? The player Elo will be recalculated.')) return;
            var r = await api('/api/admin/match', { publicId: m.publicId, matchId: m.matchId, cancelled: !m.cancelled });
            if (!r.ok) { alert('Error ' + r.status); return; }
            await load();
        }

        document.getElementById('filter').oninput = render;
        document.getElementById('onlyFlag').onchange = render;
        document.getElementById('refresh').onclick = load;
        load();
    </script>
</body>
</html>`);
});

app.get('/', (req, res) => {
    const all = sortedPlayers();
    const requested = typeof req.query.player === 'string' ? req.query.player : '';
    const player = all.find(p => p.publicId === requested) || all[0] || null;

    const leaderboardRows = all.slice(0, LIMITS.LEADERBOARD_SIZE).map((p, i) => `
        <tr style="cursor:pointer; background:${player && p === player ? '#334155' : 'transparent'};" onclick="window.location.href='/?player=${encodeURIComponent(p.publicId)}'">
            <td>#${i + 1}</td>
            <td style="font-weight:bold; color:#38bdf8;">${esc(p.name)}</td>
            <td><span class="rank-badge ${esc(p.rank)}" style="font-size:10px; padding:2px 8px; margin:0;">${esc(p.rank)}</span></td>
            <td style="color:#4ade80; font-weight:bold;">${p.elo} Elo</td>
        </tr>`).join('') || `<tr><td colspan="4" style="color:#666;">No players registered yet.</td></tr>`;

    let playerPanel = `<h1>🎮 Player Profile</h1><p style="text-align:center;color:#94a3b8;">No players yet.</p>`;
    let progressPercent = 0;

    if (player) {
        const info = rankByName(player.rank);
        progressPercent = player.rank === 'Pro' ? 100
            : Math.min(100, Math.max(0, ((player.elo - info.min) / (info.max - info.min)) * 100));

        const historyRows = visibleMatches(player).slice(-5).reverse().map(m => `
            <tr>
                <td>${Number(m.score)} pts</td>
                <td>${Number(m.duration)}s</td>
                <td style="color:${m.change >= 0 ? '#2ecc71' : '#e74c3c'}; font-weight:bold;">${m.change >= 0 ? '+' + Number(m.change) : Number(m.change)} Elo</td>
                <td style="color:#888; font-size:12px;">${esc(m.time)}</td>
            </tr>`).join('') || `<tr><td colspan="4" style="color:#666;">No matches recorded yet.</td></tr>`;

        const adminPanel = ADMIN_KEY ? `
            <div class="test-panel" id="admin-panel" style="display:none">
                <div style="font-size:11px; color:#94a3b8; margin-bottom:6px;">Admin tools for: ${esc(player.name)}</div>
                <button onclick="admin('/api/admin/simulate', 20000, 1800)">🧪 Test 20k</button>
                <button onclick="admin('/api/admin/simulate', 50000, 2400)">🧪 Test 50k</button>
                <button onclick="admin('/api/admin/simulate', 80000, 3000)">🧪 Test 80k</button>
                <button onclick="admin('/api/admin/simulate', 130000, 3600)">🧪 Test 130k</button>
                <button class="reset" onclick="if(confirm('Reset this profile?')) admin('/api/admin/reset')">🔄 Reset</button>
            </div>` : '';

        playerPanel = `
            <h1>🎮 Player Profile</h1>
            <div style="font-size:16px; color:#94a3b8; margin-bottom:10px; text-align:center; word-break:break-all;">${esc(player.name)}</div>
            <div style="text-align:center;"><div class="rank-badge ${esc(player.rank)}">${esc(player.rank)}</div></div>
            <div class="elo-score">${player.elo} <span style="font-size:16px; color:#94a3b8;">Elo</span></div>
            <div class="progress-container"><div class="progress-bar"></div></div>
            <div class="progress-text">${player.rank === 'Pro' ? '👑 Top tier' : 'Tier progress: ' + Math.round(progressPercent) + '%'}</div>
            <h3>📜 Match history</h3>
            <table>
                <thead><tr><th>Score</th><th>Duration</th><th>Delta</th><th>Time</th></tr></thead>
                <tbody>${historyRows}</tbody>
            </table>
            ${adminPanel}`;
    }

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Slither.io Ranked - Leaderboard</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 20px; display: flex; justify-content: center; gap: 20px; }
        .container { width: 450px; background: #1e293b; padding: 25px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); border: 1px solid #334155; height: fit-content; }
        h1 { color: #38bdf8; margin-top: 0; font-size: 20px; text-align: center; }
        .rank-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-weight: bold; font-size: 12px; text-transform: uppercase; margin-bottom: 5px; }
        .Bronze { background: #b45309; color: #fef3c7; }
        .Silver { background: #64748b; color: #f1f5f9; }
        .Gold { background: #eab308; color: #713f12; }
        .Diamond { background: #06b6d4; color: #ecfeff; }
        .Mythic { background: #a855f7; color: #faf5ff; }
        .Legendary { background: #f59e0b; color: #fffbeb; }
        .Master { background: #dc2626; color: #fee2e2; }
        .Pro { background: linear-gradient(135deg, #fbbf24, #d97706); color: #fff; box-shadow: 0 0 12px rgba(251, 191, 36, 0.5); }
        .elo-score { font-size: 42px; font-weight: 800; color: #4ade80; margin: 5px 0; text-align: center; }
        .progress-container { background: #334155; border-radius: 10px; height: 10px; width: 100%; margin: 15px 0 5px 0; overflow: hidden; }
        .progress-bar { background: #38bdf8; height: 100%; width: ${progressPercent}%; transition: width 0.4s ease; }
        .progress-text { font-size: 11px; color: #94a3b8; margin-bottom: 20px; text-align: right; }
        h3 { border-bottom: 2px solid #334155; padding-bottom: 6px; font-size: 14px; color: #cbd5e1; margin-top: 25px; }
        table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
        th, td { padding: 8px; text-align: center; border-bottom: 1px solid #334155; }
        th { color: #94a3b8; font-weight: 600; }
        .test-panel { margin-top: 20px; background: #0f172a; padding: 12px; border-radius: 8px; text-align: center; }
        button { background: #3b82f6; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-weight: bold; margin: 4px; font-size: 12px; transition: background 0.2s; }
        button:hover { background: #2563eb; }
        button.reset { background: #ef4444; }
        button.reset:hover { background: #dc2626; }
    </style>
</head>
<body>
    <div class="container">${playerPanel}</div>
    <div class="container" style="width:350px;">
        <h1>🏆 Global Leaderboard</h1>
        <div style="font-size:11px; color:#94a3b8; text-align:center; margin-bottom:10px;">Click a player to see their profile</div>
        <table>
            <thead><tr><th>#</th><th>Player</th><th>Rank</th><th>Elo</th></tr></thead>
            <tbody>${leaderboardRows}</tbody>
        </table>
    </div>
    <script>
        var PLAYER_PUBLIC_ID = ${jsonForScript(player ? player.publicId : null)};
        // The admin tools are hidden for visitors. Open this page with #admin at the end of the address to see them.
        if (location.hash === '#admin') { var ap = document.getElementById('admin-panel'); if (ap) ap.style.display = 'block'; }
        async function admin(url, score, duration) {
            var key = sessionStorage.getItem('adminKey') || prompt('Admin key');
            if (!key) return;
            var r = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
                body: JSON.stringify({ publicId: PLAYER_PUBLIC_ID, score: score, duration: duration })
            });
            if (r.status === 403) { sessionStorage.removeItem('adminKey'); alert('Invalid admin key'); return; }
            sessionStorage.setItem('adminKey', key);
            location.reload();
        }
    </script>
</body>
</html>`);
});

app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
        return res.status(400).json({ success: false, error: 'Invalid request' });
    }
    console.error(err);
    res.status(500).json({ success: false, error: 'Server error' });
});

async function start() {
    if (DATABASE_URL) await loadDatabaseFromPostgres();
    else loadDatabase();

    if (pool) setInterval(() => flushDirty().catch(() => {}), 30000).unref();

    // Render stops the old server on every deploy/restart: save everything still pending first.
    const shutdown = async (signal) => {
        console.log(`${signal} received, saving pending players...`);
        const timer = setTimeout(() => process.exit(0), 8000);
        try { if (pool) await flushDirty(); } catch (e) {}
        clearTimeout(timer);
        process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    app.listen(PORT, HOST, () => {
        console.log(`🚀 Ranked server running on http://${HOST}:${PORT}${ADMIN_KEY ? ' (admin enabled)' : ''}`);
    });
}

start().catch((e) => {
    console.error('Could not start the server:', e);
    process.exit(1);
});