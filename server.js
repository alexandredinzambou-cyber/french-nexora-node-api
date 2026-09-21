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

function loadAuthDb() {
    try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')); }
    catch (e) { return { codes: {}, sessions: {} }; }
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

    json(404, { ok: false, reason: 'unknown' });
}

const textTypes = ['application/json', 'application/javascript', 'text/html', 'text/css', 'text/plain'];

const PORT = process.env.PORT || 3100; // 3100 : évite le conflit avec l'API Content-Nexora (8787)
const HOST = '0.0.0.0';

/* API Content-Nexora (autoflix-api) : source unique du contenu NOX.
   L'API Nexora Node (port 3000) est déconnectée (optionnelle via --with-node). */
const CONTENT_NEXORA_BASE = (process.env.CONTENT_NEXORA_API || 'http://127.0.0.1:8787').replace(/\/+$/, '');

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
            message: "Lancez l'API Content-Nexora (autoflix-api) sur http://127.0.0.1:8787, ou définissez CONTENT_NEXORA_API.",
            contentNexora: CONTENT_NEXORA_BASE + '/api/health',
        }));
    }
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
        // API Nexora Node déconnectée — le contenu est fourni par l'API Content-Nexora (port 8787)
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
    console.log(`🔌 Contenu fourni par l'API Content-Nexora (${CONTENT_NEXORA_BASE}) — API Nexora Node déconnectée`);
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
