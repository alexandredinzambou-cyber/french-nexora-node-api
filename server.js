const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/* ============================================================================
   PORTAIL DE CONNEXION NOX — codes d'accès distribués via le bot Telegram.
   - Un membre demande un code au bot (/code) → durée choisie via boutons
     (3 jours / 1 mois / pour toujours) → code envoyé en MP Telegram.
   - Sur le site, l'utilisateur saisit son code → vérification + session.
   - La session est revérifiée (durée) à chaque chargement de page et toutes
     les 5 minutes ; code invalide/expiré → écran « contactez l'admin ».
   Stockage : fichier JSON (_nox_auth.json) — pas de dépendance externe.
   ========================================================================== */
const AUTH_FILE = path.join(__dirname, '_nox_auth.json');
const AUTH_TTL_DAYS = { '3d': 3, '1m': 30, 'forever': 0 };   // 0 = illimité
const AUTH_LABELS = { '3d': '3 jours', '1m': '1 mois', 'forever': 'Pour toujours' };

/* --- Seed des codes via variable d'environnement (Railway) ---
   Le filesystem Railway est ÉPHÉMÈRE : _nox_auth.json (gitignore) disparaît à
   chaque redéploiement, et aucun code n'est alors valide. NOX_AUTH_CODES permet
   de déclarer les codes actifs en prod, format (JSON ou simplifié) :
     NOX_AUTH_CODES="NOX-XXXX-XXXX,NOX-YYYY-YYYY"            → tous 'forever'
     NOX_AUTH_CODES='{"NOX-XXXX-XXXX":{"plan":"1m","exp":0}}' → JSON complet
   Le seed fusionne (sans écraser) l'état fichier à chaque loadAuthDb(). */
function seededCodes() {
    const raw = (process.env.NOX_AUTH_CODES || '').trim();
    if (!raw) return {};
    const out = {};
    try {
        if (raw.startsWith('{')) {
            const parsed = JSON.parse(raw);
            for (const [code, rec] of Object.entries(parsed)) {
                if (rec && typeof rec === 'object') out[normalizeCode(code)] = rec;
                else out[normalizeCode(code)] = { plan: 'forever', exp: 0, active: 1 };
            }
        } else {
            for (const c of raw.split(',')) {
                const code = normalizeCode(c);
                if (code) out[code] = { plan: 'forever', exp: 0, active: 1, createdBy: 'env' };
            }
        }
    } catch (e) { console.error('[auth] NOX_AUTH_CODES invalide :', e.message); }
    return out;
}

function loadAuthDb() {
    let db;
    try { db = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')); }
    catch (e) { db = { codes: {}, sessions: {} }; }
    db.codes = (db.codes && typeof db.codes === 'object') ? db.codes : {};
    db.sessions = (db.sessions && typeof db.sessions === 'object') ? db.sessions : {};
    /* Fusion du seed env : les codes déclarés restent valides même si le fichier
       a disparu (redéploiement Railway). Ne supprime jamais un code existant. */
    const seed = seededCodes();
    for (const [code, rec] of Object.entries(seed)) {
        if (!db.codes[code]) db.codes[code] = rec;
    }
    return db;
}
function saveAuthDb(db) {
    try { fs.writeFileSync(AUTH_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.error('[auth] save:', e.message); }
}
function normalizeCode(c) {
    return String(c || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}
/* Un code est valide si : connu, actif, et non expiré (exp=0 → illimité). */
function authCodeState(db, code) {
    const rec = db.codes[code];
    if (!rec || rec.active === false || rec.active === 0) return { ok: false, reason: 'invalid' };
    if (rec.exp && Date.now() > rec.exp) return { ok: false, reason: 'expired' };
    return { ok: true, rec };
}
function authPayload(rec) {
    return {
        ok: true,
        plan: rec.plan || 'forever',
        label: AUTH_LABELS[rec.plan] || 'Accès',
        exp: rec.exp || 0,
        remainingDays: rec.exp ? Math.max(0, Math.ceil((rec.exp - Date.now()) / 86400000)) : null,
    };
}

/* --- API d'authentification : /api/auth/* (JSON, GET check + POST verify) --- */
async function handleAuthApi(pathname, searchParams, req, res) {
    const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(obj));
    };
    const readBody = () => new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')); }
            catch (e) { resolve({}); }
        });
    });

    /* GET /api/auth/check?code=… (ou header X-NOX-Code) : revérification de la
       session à chaque chargement de page — la durée est recontrôlée ici. */
    if (pathname === '/api/auth/check') {
        const db = loadAuthDb();
        const code = normalizeCode(searchParams.get('code') || req.headers['x-nox-code'] || '');
        if (!code) return json(200, { ok: false, reason: 'missing' });
        const st = authCodeState(db, code);
        if (!st.ok) return json(200, { ok: false, reason: st.reason });
        /* Session glissante : tant que le code est valide, la session vit. */
        db.sessions[code] = Date.now() + 30 * 86400000;
        for (const [c, exp] of Object.entries(db.sessions)) {
            if (Date.now() > exp || !db.codes[c]) delete db.sessions[c];
        }
        saveAuthDb(db);
        return json(200, authPayload(st.rec));
    }

    /* --- Administration distante (bot Telegram sur Railway) : /api/auth/admin ---
       Le bot et le serveur sont dans des containers séparés : impossible d'écrire
       directement _nox_auth.json. Le bot appelle donc ces endpoints avec un secret
       partagé (AUTH_ADMIN_SECRET) pour synchroniser codes et sessions. */
    if (pathname === '/api/auth/admin') {
        const secret = process.env.AUTH_ADMIN_SECRET || '';
        const provided = req.headers['x-admin-secret'] || searchParams.get('secret') || '';
        if (!secret) return json(503, { ok: false, reason: 'secret_not_configured' });
        if (provided !== secret) return json(403, { ok: false, reason: 'forbidden' });

        if (req.method === 'GET') {
            return json(200, { ok: true, db: loadAuthDb() });
        }
        if (req.method !== 'POST') return json(405, { ok: false, reason: 'method' });
        const adminBody = await readBody();
        const action = String(adminBody.action || '');
        const db = loadAuthDb();
        db.codes = (db.codes && typeof db.codes === 'object') ? db.codes : {};
        db.sessions = (db.sessions && typeof db.sessions === 'object') ? db.sessions : {};

        if (action === 'get') {
            return json(200, { ok: true, db });
        }
        if (action === 'sync') {
            /* Pousse/retire UN code : rec complet, ou {active:false} pour révoquer. */
            const code = normalizeCode(adminBody.code);
            if (!code) return json(200, { ok: false, reason: 'missing' });
            if (adminBody.rec && typeof adminBody.rec === 'object' && adminBody.rec.active !== false) {
                db.codes[code] = adminBody.rec;
            } else {
                delete db.codes[code];
                delete db.sessions[code];
            }
            saveAuthDb(db);
            return json(200, { ok: true, code });
        }
        if (action === 'sessions_set') {
            /* Remplace l'état des sessions (déconnexion ciblée/globale par le bot). */
            if (adminBody.sessions && typeof adminBody.sessions === 'object') {
                db.sessions = adminBody.sessions;
            }
            saveAuthDb(db);
            return json(200, { ok: true });
        }
        if (action === 'sessions_clear') {
            db.sessions = {};
            saveAuthDb(db);
            return json(200, { ok: true });
        }
        return json(200, { ok: false, reason: 'unknown_action' });
    }

    if (req.method !== 'POST') return json(405, { ok: false, reason: 'method' });
    const body = await readBody();

    /* POST /api/auth/verify { code } : validation de la saisie du portail. */
    if (pathname === '/api/auth/verify') {
        const code = normalizeCode(body.code);
        if (!code) return json(200, { ok: false, reason: 'missing' });
        const db = loadAuthDb();
        const st = authCodeState(db, code);
        if (!st.ok) return json(200, { ok: false, reason: st.reason });
        db.sessions[code] = Date.now() + 30 * 86400000;
        saveAuthDb(db);
        return json(200, authPayload(st.rec));
    }

    /* POST /api/auth/logout { code } : déconnexion du portail. La session est
       supprimée CÔTÉ SERVEUR (sinon la revérification périodique /api/auth/check
       recréerait une session glissante) ; le code d'accès lui-même reste actif
       tant que sa durée n'est pas écoulée. */
    if (pathname === '/api/auth/logout') {
        const code = normalizeCode(body.code);
        if (!code) return json(200, { ok: false, reason: 'missing' });
        const db = loadAuthDb();
        if (db.sessions && typeof db.sessions === 'object' && db.sessions[code]) {
            delete db.sessions[code];
            saveAuthDb(db);
        }
        return json(200, { ok: true });
    }

    json(404, { ok: false, reason: 'unknown' });
}

const textTypes = ['application/json', 'application/javascript', 'text/html', 'text/css', 'text/plain'];

const PORT = process.env.PORT || 3100; // 3100 : évite le conflit avec l'API Content-Nexora (8787)
const HOST = '0.0.0.0';

/* API Content-Nexora (autoflix-api) : métadonnées, catalogue, recherche, resolve.
   Les flux vidéo (/api/streams, /api/providers) viennent de l'API Node. */
const CONTENT_NEXORA_BASE = (process.env.CONTENT_NEXORA_API || 'https://content-nexora-production.example.com').replace(/\/+$/, '');

/* API French Nexora Node (port 3200) : source principale des flux vidéo (Puppeteer providers).
   Contourne Cloudflare via Puppeteer. */
const NODE_API_BASE = (process.env.NODE_API_BASE || 'http://127.0.0.1:3200').replace(/\/+$/, '');

/* API QuickJS (port 3300) : 20+ providers QuickJS (anime-sama, frenchstream, voiranime, etc.).
   Compilés depuis src/ vers providers/ via esbuild. */
const QUICKJS_API_BASE = (process.env.QUICKJS_API_BASE || 'http://127.0.0.1:3300').replace(/\/+$/, '');

/* API Anime-Sama (anime-sama-api) : service anime standalone.
   Exposé via /api/anime/* en same-origin pour le site NOX. */
const ANIME_API_BASE = (process.env.ANIME_API_BASE || 'http://127.0.0.1:5001').replace(/\/+$/, '');

/* API ReelShort (reelshort.com) : service dramas standalone (reelshort-api, Flask).
   Exposé via /api/drama/* en same-origin pour le site NOX. */
const DRAMA_API_BASE = (process.env.DRAMA_API_BASE || 'http://127.0.0.1:5002').replace(/\/+$/, '');

/* Proxy same-origin vers API Drama : /api/drama/* → API Drama (port 5002). */
async function proxyDramaApi(target, init, res) {
    try {
        const r = await fetch(target, init);
        const body = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json; charset=utf-8' });
        res.end(body);
    } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            error: 'API ReelShort injoignable.',
            message: "Lancez l'API ReelShort (reelshort-api) sur http://127.0.0.1:5002, ou définissez DRAMA_API_BASE.",
            dramaApi: DRAMA_API_BASE + '/health',
        }));
    }
}

/* Proxy same-origin vers Anime-Sama API : /api/anime/* → Anime-Sama API (port 5001)
   Le format des URLs diffère : NOX utilise /api/anime/v1/... , l'API anime expose /api/v1/... */
async function proxyAnimeApi(target, init, res) {
    try {
        const r = await fetch(target, init);
        const body = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json; charset=utf-8' });
        res.end(body);
    } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            error: 'API Anime-Sama injoignable.',
            message: "Lancez l'API Anime-Sama (anime-sama-api) sur http://127.0.0.1:5001, ou définissez ANIME_API_BASE.",
            animeApi: ANIME_API_BASE + '/health',
        }));
    }
}

/* Proxy same-origin vers Content-Nexora : le front NOX servi sur ce serveur appelle /api/*
   en same-origin, ce serveur relaie vers l'API (évite tout blocage CORS). GET + POST (/api/resolve). */
async function proxyContentNexora(target, init, res) {
    try {
        const r = await fetch(target, init);
        const body = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json; charset=utf-8' });
        res.end(body);
    } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            error: 'API Content-Nexora injoignable.',
            message: "Lancez l'API Content-Nexora (autoflix-api) sur https://content-nexora-production.example.com, ou définissez CONTENT_NEXORA_API.",
            contentNexora: CONTENT_NEXORA_BASE + '/api/health',
        }));
    }
}

/* Proxy same-origin vers French Nexora Node API : flux vidéo (/api/streams, /api/providers).
   Providers Puppeteer (orion, aether, tmdbembed). */
async function proxyNodeApi(target, init, res) {
    try {
        const r = await fetch(target, init);
        const body = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json; charset=utf-8' });
        res.end(body);
    } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            error: 'API French Nexora Node injoignable.',
            message: "Lancez l'API Node (api-server.js) sur http://127.0.0.1:3200, ou définissez NODE_API_BASE.",
            nodeApi: NODE_API_BASE + '/api/health',
        }));
    }
}

/* Proxy same-origin vers QuickJS API : 20+ providers QuickJS (anime-sama, frenchstream, voiranime, etc.). */
async function proxyQuickJsApi(target, init, res) {
    try {
        const r = await fetch(target, init);
        const body = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json; charset=utf-8' });
        res.end(body);
    } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            error: 'API QuickJS injoignable.',
            message: "Lancez l'API QuickJS (quickjs-api.js) sur http://127.0.0.1:3300, ou définissez QUICKJS_API_BASE.",
            quickjsApi: QUICKJS_API_BASE + '/health',
        }));
    }
}

/* ============================================================================
   GESTIONNAIRE API VIDÉO COMBINÉE : Node API (Puppeteer) + QuickJS API
   ============================================================================ */

async function fetchJson(url, init = {}) {
    try {
        const r = await fetch(url, { ...init, headers: { 'Accept': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(130000) });
        if (!r.ok) return null;
        return await r.json();
    } catch (e) {
        return null;
    }
}

async function handleVideoApiRequest(requestUrl, req, res) {
    const isProviders = requestUrl.pathname === '/api/providers';
    const isStreams = requestUrl.pathname === '/api/streams' || requestUrl.pathname.startsWith('/api/streams/');
    
    if (isProviders) {
        return handleProvidersRequest(res);
    }
    
    if (isStreams) {
        return handleStreamsRequest(requestUrl, res);
    }
    
    // Fallback : proxy vers Node API
    const target = NODE_API_BASE + requestUrl.pathname + requestUrl.search;
    const init = { method: req.method, headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(130000) };
    proxyNodeApi(target, init, res);
}

async function handleProvidersRequest(res) {
    const [nodeData, quickjsData] = await Promise.all([
        fetchJson(NODE_API_BASE + '/api/providers'),
        fetchJson(QUICKJS_API_BASE + '/api/providers')
    ]);
    
    const nodeProviders = (nodeData && nodeData.providers) || [];
    const quickjsProviders = (quickjsData && quickjsData.providers) || [];
    
    // Fusionner en évitant les doublons (par id)
    const seen = new Set();
    const merged = [];
    
    for (const p of [...nodeProviders, ...quickjsProviders]) {
        const id = p.id || p.name;
        if (id && !seen.has(id)) {
            seen.add(id);
            merged.push({
                id,
                name: p.name || id,
                description: p.description || '',
                source: p.source || (nodeProviders.includes(p) ? 'french-nexora-node' : 'quickjs'),
                enabled: p.enabled !== false
            });
        }
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
        language: 'fr',
        count: merged.length,
        providers: merged,
        sources: {
            'french-nexora-node': nodeProviders.length,
            'quickjs': quickjsProviders.length
        }
    }));
}

async function handleStreamsRequest(requestUrl, res) {
    const searchParams = requestUrl.searchParams;
    const tmdbId = searchParams.get('tmdbId') || searchParams.get('id');
    const mediaType = searchParams.get('mediaType') || searchParams.get('type') || 'movie';
    const provider = searchParams.get('provider') || 'all';
    const season = searchParams.get('season') || searchParams.get('saison') || '1';
    const episode = searchParams.get('episode') || '1';
    
    if (!tmdbId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'tmdbId requis' }));
    }
    
    // Construire les URLs pour les deux APIs
    const params = new URLSearchParams({
        tmdbId,
        mediaType,
        season,
        episode
    });
    if (provider !== 'all') params.set('provider', provider);
    
    const nodeUrl = NODE_API_BASE + '/api/streams?' + params.toString();
    const quickjsUrl = QUICKJS_API_BASE + '/api/streams?' + params.toString();
    
    const [nodeData, quickjsData] = await Promise.all([
        fetchJson(nodeUrl),
        fetchJson(quickjsUrl)
    ]);
    
    // Fusionner les streams
    const nodeStreams = (nodeData && (nodeData.streams || nodeData.sources || nodeData.players || [])) || [];
    const quickjsStreams = (quickjsData && (quickjsData.streams || quickjsData.sources || quickjsData.players || [])) || [];
    
    return mergeAndRespond(res, tmdbId, mediaType, provider, nodeStreams, quickjsStreams, nodeData, quickjsData);
}

function mergeAndRespond(res, tmdbId, mediaType, provider, nodeStreams, quickjsStreams, nodeData, quickjsData) {
    // Normaliser et dédupliquer
    const seenUrls = new Set();
    const mergedStreams = [];
    
    function normalizeStream(s, source) {
        const url = s.url || s.proxyM3U8 || s.proxyM3u8 || s.m3u8 || s.directUrl || s.embedUrl || s.streamUrl || '';
        if (!url || seenUrls.has(url)) return null;
        seenUrls.add(url);
        return {
            url,
            type: s.type || (/\.m3u8/i.test(url) ? 'hls' : 'iframe'),
            quality: s.quality || null,
            language: s.language || s.lang || null,
            providerName: s.providerName || s.provider || s.source || source,
            provider: source,
            headers: s.headers || null,
            referer: s.referer || null
        };
    }
    
    for (const s of nodeStreams) {
        const ns = normalizeStream(s, 'french-nexora-node');
        if (ns) mergedStreams.push(ns);
    }
    for (const s of quickjsStreams) {
        const ns = normalizeStream(s, 'quickjs');
        if (ns) mergedStreams.push(ns);
    }
    
    const ok = mergedStreams.length > 0;
    
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
        ok,
        success: ok,
        tmdbId,
        mediaType,
        type: mediaType,
        provider: provider || 'all',
        count: mergedStreams.length,
        streams: mergedStreams,
        sources: mergedStreams,
        hosters: mergedStreams.map((s, i) => ({
            id: i,
            nom: s.providerName,
            lang: s.language || 'fr',
            quality: s.quality,
            embedUrl: s.type === 'iframe' ? s.url : null,
            m3u8: s.type === 'hls' ? s.url : null,
            source: s.provider
        })),
        providers: [
            { id: 'french-nexora-node', name: 'French Nexora Node (Puppeteer)', status: nodeData ? 'ok' : 'error', count: nodeStreams.length },
            { id: 'quickjs', name: 'QuickJS Providers (20+)', status: quickjsData ? 'ok' : 'error', count: quickjsStreams.length }
        ],
        error: ok ? undefined : 'Aucune source trouvée sur les deux APIs'
    }));
}

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

/* Proxy vidéo same-origin /vproxy : contourne le CORS des hébergeurs HLS qui n'envoient
   pas Access-Control-Allow-Origin (hls.js charge les playlists en XHR). On relaie segments
   et playlists, en injectant Referer/UA et en réécrivant les sous-playlists du m3u8. */
function proxyVideo(targetUrl, res, req, refererParam) {
    let parsed;
    try {
        parsed = new URL(targetUrl);
    } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid URL');
        return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid protocol');
        return;
    }
    /* Referer : celui de la page du lecteur (passé en ?referer=) est souvent exigé par le CDN ;
       à défaut, celui de l'hôte du flux. */
    const streamReferer = refererParam || ('https://' + parsed.host + '/');
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Referer': streamReferer,
        'Origin': 'https://' + parsed.host,
        'Accept': '*/*',
    };
    const range = req && req.headers && req.headers.range;
    if (range) headers['Range'] = range;
    const init = { headers, redirect: 'follow', signal: AbortSignal.timeout(60000) };
    fetch(parsed.href, init).then((up) => {
        const outHeaders = { 'Access-Control-Allow-Origin': '*' };
        const ct = up.headers.get('content-type');
        if (ct) outHeaders['Content-Type'] = ct;
        const cl = up.headers.get('content-length');
        if (cl) outHeaders['Content-Length'] = cl;
        const cr = up.headers.get('content-range');
        if (cr) outHeaders['Content-Range'] = cr;
        outHeaders['Accept-Ranges'] = 'bytes';
        const isPlaylist = /mpegurl|vnd\.apple\.mpegurl|\.m3u8(\?|#|$)/i.test(ct || '') || /\.m3u8(\?|#|$)/i.test(parsed.pathname);
        if (up.status >= 300 && up.status < 400 && up.headers.get('location')) {
            res.writeHead(302, Object.assign({ Location: '/vproxy?url=' + encodeURIComponent(new URL(up.headers.get('location'), parsed.href).href) }, outHeaders));
            res.end();
            return;
        }
        if (!up.ok) {
            res.writeHead(up.status, outHeaders);
            res.end();
            return;
        }
        if (isPlaylist) {
            return up.text().then((text) => {
                const base = parsed.href;
                const rewritten = text.split('\n').map((line) => {
                    const t = line.trim();
                    if (!t || t.startsWith('#')) {
                        /* URI="..." dans les tags EXT-X-MEDIA / EXT-X-I-FRAME-STREAM-INF */
                        return line.replace(/URI="([^"]+)"/g, (m, u) => 'URI="' + proxyRef(u, base, streamReferer) + '"');
                    }
                    return proxyRef(t, base, streamReferer);
                }).join('\n');
                outHeaders['Content-Type'] = outHeaders['Content-Type'] || 'application/vnd.apple.mpegurl';
                delete outHeaders['Content-Length'];
                res.writeHead(200, outHeaders);
                res.end(rewritten);
            });
        }
        res.writeHead(up.status, outHeaders);
        up.arrayBuffer().then((buf) => res.end(Buffer.from(buf))).catch(() => res.end());
    }).catch((e) => {
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        }
        res.end('Proxy error: ' + (e && e.message || e));
    });
}

function proxyRef(u, base, ref) {
    if (!u || /^(data|blob):/i.test(u)) return u;
    if (/^\/vproxy\?/.test(u)) return u;
    const abs = new URL(u, base).href;
    return '/vproxy?url=' + encodeURIComponent(abs) + (ref ? '&referer=' + encodeURIComponent(ref) : '');
}

/* --- Proxy d'images TMDB : /imgproxy?u=<url image.tmdb.org> ----------------
   Le navigateur chargeait des dizaines de posters directement depuis
   image.tmdb.org → ERR_HTTP2_PROTOCOL_ERROR (route saturée/rate-limitée).
   Désormais : le serveur fetch UNE fois, cache sur disque (_img_cache/, TTL
   7 j) et sert en HTTP/1.1 local. Échec upstream → 302 vers l'URL d'origine
   (dégradation gracieuse, le navigateur tente le direct). ------------------ */
const IMG_CACHE_DIR = path.join(__dirname, '_img_cache');
const IMG_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
try { fs.mkdirSync(IMG_CACHE_DIR, { recursive: true }); } catch (e) {}

function serveImgProxy(requestUrl, res) {
    const target = requestUrl.searchParams.get('u') || '';
    let parsed = null;
    try { parsed = new URL(target); } catch (e) { /* invalide */ }
    if (!parsed || parsed.hostname !== 'image.tmdb.org' || !/^https?:$/.test(parsed.protocol)) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('URL image.tmdb.org requise');
        return;
    }
    const key = crypto.createHash('md5').update(parsed.href).digest('hex');
    const extMatch = parsed.pathname.match(/\.(jpg|jpeg|png|webp|gif)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    const cachePath = path.join(IMG_CACHE_DIR, key + '.' + ext);
    try {
        const st = fs.statSync(cachePath);
        if (Date.now() - st.mtimeMs < IMG_CACHE_TTL_MS && st.size > 0) {
            res.writeHead(200, { 'Content-Type': ext === 'png' ? 'image/png' : 'image/jpeg',
                                 'Cache-Control': 'public, max-age=604800' });
            fs.createReadStream(cachePath).pipe(res);
            return;
        }
    } catch (e) { /* pas en cache — fetch ci-dessous */ }
    fetch(parsed.href, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'Accept': 'image/*' },
        redirect: 'follow', signal: AbortSignal.timeout(30000),
    }).then((up) => {
        if (!up.ok) throw new Error('upstream ' + up.status);
        return up.arrayBuffer().then((buf) => {
            try { fs.writeFileSync(cachePath, Buffer.from(buf)); } catch (e) {}
            res.writeHead(200, { 'Content-Type': up.headers.get('content-type') || 'image/jpeg',
                                 'Cache-Control': 'public, max-age=604800' });
            res.end(Buffer.from(buf));
        });
    }).catch(() => {
        res.writeHead(302, { Location: parsed.href });
        res.end();
    });
}

const mimeTypes = {
    '.json': 'application/json',
    '.js': 'application/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.html': 'text/html',
    '.css': 'text/css',
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
};

const server = http.createServer(async (req, res) => {
    console.log(`${req.method} ${req.url}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (requestUrl.pathname === '/nox') {
        res.writeHead(301, { Location: '/nox/' });
        res.end();
        return;
    }
    if (requestUrl.pathname === '/nox/') {
        requestUrl.pathname = '/nox/index.html';
    }
    if (requestUrl.pathname === '/vproxy') {
        const target = requestUrl.searchParams.get('url') || '';
        proxyVideo(target, res, req, requestUrl.searchParams.get('referer') || '');
        return;
    }
    if (requestUrl.pathname === '/imgproxy') {
        serveImgProxy(requestUrl, res);
        return;
    }
    if (requestUrl.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
    }
    /* --- API d'authentification (portail de connexion) --- */
    if (requestUrl.pathname.startsWith('/api/auth/')) {
        handleAuthApi(requestUrl.pathname, requestUrl.searchParams, req, res);
        return;
    }
    // Health check endpoint - local, no auth required
    if (requestUrl.pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({
            ok: true,
            service: 'french-nexora-api',
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: '1.0.0'
        }));
    }
    if (requestUrl.pathname.startsWith('/api/drama/')) {
        // API ReelShort — proxy same-origin vers le service drama standalone (port 5002)
        // Mapping : /api/drama/xyz → /api/v1/reelshort/xyz (routes flask_restx de reelshort.py)
        // sauf /health qui est monté sur la racine Flask (sonde guardian).
        const dramaPath = requestUrl.pathname.replace(/^\/api\/drama/, '');
        const target = dramaPath === '/health'
            ? DRAMA_API_BASE + '/health'
            : DRAMA_API_BASE + '/api/v1/reelshort' + dramaPath + requestUrl.search;
        console.log(`[proxy-drama] ${req.method} ${requestUrl.pathname} → ${target}`, flush=true);
        const init = { method: req.method, headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(130000) };
        if (req.method === 'GET' || req.method === 'HEAD') {
            proxyDramaApi(target, init, res);
        } else {
            const chunks = [];
            req.on('data', c => chunks.push(c));
            req.on('end', () => {
                init.body = Buffer.concat(chunks);
                init.headers['Content-Type'] = req.headers['content-type'] || 'application/json';
                proxyDramaApi(target, init, res);
            });
        }
        return;
    }
    if (requestUrl.pathname.startsWith('/api/anime/')) {
        // Anime-Sama API — proxy same-origin vers le service anime standalone (port 5001)
        // Mapping : /api/anime/v1/... → /api/v1/... (l'API anime expose /api/v1/...)
        const animePath = requestUrl.pathname.replace(/^\/api\/anime/, '') || '/health';
        const target = ANIME_API_BASE + animePath + requestUrl.search;
        console.log(`[proxy-anime] ${req.method} ${requestUrl.pathname} → ${target}`, flush=true);
        const init = { method: req.method, headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(130000) };
        if (req.method === 'GET' || req.method === 'HEAD') {
            proxyAnimeApi(target, init, res);
        } else {
            const chunks = [];
            req.on('data', c => chunks.push(c));
            req.on('end', () => {
                init.body = Buffer.concat(chunks);
                init.headers['Content-Type'] = req.headers['content-type'] || 'application/json';
                proxyAnimeApi(target, init, res);
            });
        }
        return;
    }
    if (requestUrl.pathname.startsWith('/api/')) {
        // Vérification d'authentification pour toutes les routes API sauf /api/auth/*
        if (!requestUrl.pathname.startsWith('/api/auth/')) {
            const authHeader = req.headers.authorization || '';
            const codeHeader = req.headers['x-nox-code'] || '';
            const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
            const code = codeHeader || token;
            
            if (!code) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Non authentifié (code requis)' }));
            }
            
            const db = loadAuthDb();
            const normalizedCode = normalizeCode(code);
            const st = authCodeState(db, normalizedCode);
            if (!st.ok) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Code invalide ou expiré', reason: st.reason }));
            }
            // Session glissante : prolonge la session tant que le code est valide
            db.sessions[normalizedCode] = Date.now() + 30 * 86400000;
            saveAuthDb(db);
        }

        // Routes flux vidéo → Combiner Node API (Puppeteer) + QuickJS API (20+ providers)
        const isStreams = requestUrl.pathname === '/api/streams' || requestUrl.pathname.startsWith('/api/streams/');
        const isProviders = requestUrl.pathname === '/api/providers';
        const isVideoApi = isStreams || isProviders;

        if (isVideoApi) {
            return handleVideoApiRequest(requestUrl, req, res);
        }

        // Autres routes API → Content-Nexora
        const target = CONTENT_NEXORA_BASE + requestUrl.pathname + requestUrl.search;
        const init = { method: req.method, headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(130000) };
        
        if (req.method === 'GET' || req.method === 'HEAD') {
            proxyContentNexora(target, init, res);
        } else {
            const chunks = [];
            req.on('data', c => chunks.push(c));
            req.on('end', () => {
                init.body = Buffer.concat(chunks);
                init.headers['Content-Type'] = req.headers['content-type'] || 'application/json';
                proxyContentNexora(target, init, res);
            });
        }
        return;
    }

    let filePath = path.join(__dirname, requestUrl.pathname === '/' ? 'index.html' : requestUrl.pathname);

    if (!filePath.startsWith(__dirname)) {
        res.setHeader('Content-Type', 'text/plain');
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const extname = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[extname] || 'application/octet-stream';
    const isText = textTypes.includes(contentType);

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.setHeader('Content-Type', 'text/plain');
            if (err.code === 'ENOENT') {
                if (requestUrl.pathname === '/') {
                    res.writeHead(200);
                    res.end('Nuvio Providers Server Running. Access /manifest.json to see the manifest.');
                } else {
                    res.writeHead(404);
                    res.end(`File not found: ${req.url}`);
                }
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${err.code}`);
            }
            return;
        }

        res.writeHead(200, {
            'Content-Type': contentType,
            /* Pas de cache : évite qu'un ancien script.js/css masque les
               mises à jour de l'interface NOX après un redéploiement. */
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
        });
        res.end(isText ? content.toString('utf-8') : content);
    });
});

server.listen(PORT, HOST, () => {
    const ip = getLocalIp();
    console.log(`\n🚀 Server running at: http://${ip}:${PORT}/`);
    console.log(`🎬 Site NOX:          http://${ip}:${PORT}/nox/`);
    console.log(`🔌 Flux vidéo (streams/providers):  French Nexora Node API → ${NODE_API_BASE}  +  QuickJS API → ${QUICKJS_API_BASE}`);
    console.log(`📚 Métadonnées/catalogue/recherche: Content-Nexora → ${CONTENT_NEXORA_BASE}`);
    console.log(`🎌 API Anime-Sama:    http://${ip}:${PORT}/api/anime/ (proxy → ${ANIME_API_BASE})`);
    console.log(`🎭 API ReelShort:      http://${ip}:${PORT}/api/drama/ (proxy → ${DRAMA_API_BASE})`);
    console.log(`📡 Listening on:     ${HOST}:${PORT}`);
    console.log('Press Ctrl+C to stop\n');
});

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});
