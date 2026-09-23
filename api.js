'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
const providers = new Map();

for (const entry of manifest.scrapers || []) {
    if (!entry.enabled) continue;

    const filename = path.join(__dirname, entry.filename);
    try {
        const implementation = require(filename);
        if (typeof implementation.getStreams === 'function') {
            providers.set(entry.id, { ...entry, implementation });
        }
    } catch (error) {
        console.warn(`[api] Provider ${entry.id} indisponible: ${error.message}`);
    }
}

const DEFAULT_TIMEOUT_MS = Number(process.env.API_PROVIDER_TIMEOUT_MS || 55000);
const RESOLVE_TIMEOUT_MS = Number(process.env.API_RESOLVE_TIMEOUT_MS || 15000);
/* Deadline GLOBALE pour une requête /api/streams : Railway coupe la passerelle
   vers 30s si rien ne répond → 502. On borné tout le traitement (providers +
   résolution des embeds) pour répondre à temps, quitte à revenir partiel. */
const GLOBAL_TIMEOUT_MS = Number(process.env.API_GLOBAL_TIMEOUT_MS || 15000);

/* Race une promesse contre une deadline : à l'échéance, on garde la valeur
   déjà calculée (ou fallback) sans faire planter la requête entière. */
function withGlobalDeadline(promise, ms, fallback) {
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* Résolveur partagé (src/utils/resolvers.js, module ES) — dispo en require() sur Node ≥ 22.
   Sert de deuxième passe pour les embeds HTML que les providers n'ont pas su résoudre. */
let sharedResolveStream = null;
try {
    sharedResolveStream = require('./src/utils/resolvers.js').resolveStream;
    if (typeof sharedResolveStream !== 'function') sharedResolveStream = null;
} catch (error) {
    console.warn(`[api] Résolveur partagé indisponible (les embeds resteront des iframes): ${error.message}`);
}

const VIDEO_EXT_RE = /\.(m3u8|mpd|mp4|m4v|webm|mkv|ts)(?:[?#]|$)/i;
const EMBED_HOST_RE = /(vidmoly|uqload|oneupload|sendvid|sibnet|streamtape|stape\.|dood|ds2play|ds2host|voe\.|-voe-|myvi\.|mytv\.|younetu|netu\.|vidoza|filemoon|moonplayer|luluvdo|luluvid|lulustream|fsvid\.|vidzy|up4fun|vidhsareup|hgcloud|savefiles|weneverbeenfree|maryspecialwatch|charlestoughrace|sandratableother|bigwar5|getvid|vidstream|vidcdn|lecteurvideo|down-paradise|wishonly|veev\.|kakaflix|daisukianime)/i;
const EMBED_PAGE_RE = /(\.html?(?:[?#]|$)|\/embed(\/|-|\?|$)|\/e\/[\w-]+|\/player(\/|\?|$)|\/download\/|\/d\/[\w-]+)/i;

function classifyStream(stream) {
    const url = String(stream && stream.url || '');
    if (!url) return 'invalid';
    if (VIDEO_EXT_RE.test(url)) return 'video';
    if (stream.type === 'iframe' || stream.type === 'embed') return 'iframe';
    const lower = url.toLowerCase();
    if (EMBED_HOST_RE.test(lower)) {
        if (/\/hls2?\//.test(lower) || /\/pass_md5\//.test(lower)) return 'video';
        return 'iframe';
    }
    if (EMBED_PAGE_RE.test(lower)) return 'iframe';
    if (stream.type === 'hls' || stream.type === 'file' || stream.type === 'direct') return 'video';
    return 'video';
}

async function finalizeStream(stream) {
    const kind = classifyStream(stream);
    if (kind === 'invalid') return null;
    const out = { ...stream };
    if (kind === 'video') {
        out.type = out.type === 'hls' || /\.m3u8(?:[?#]|$)/i.test(out.url) ? 'hls' : 'file';
        return out;
    }
    out.type = 'iframe';
    if (!sharedResolveStream) return out;
    try {
        const resolved = await withTimeout(
            sharedResolveStream({ url: out.url, headers: out.headers || {} }),
            RESOLVE_TIMEOUT_MS,
            `Résolution embed ${out.provider || ''}`
        );
        if (resolved && resolved.isDirect && resolved.url && resolved.url !== out.url && VIDEO_EXT_RE.test(resolved.url)) {
            return {
                ...out,
                url: resolved.url,
                headers: { ...(out.headers || {}), ...(resolved.headers || {}) },
                type: /\.m3u8(?:[?#]|$)/i.test(resolved.url) ? 'hls' : 'file',
                originalUrl: out.url,
            };
        }
    } catch (_) { /* embed non résoluble → conservé en iframe */ }
    return out;
}

async function finalizeStreams(streams) {
    const finalized = await Promise.all((streams || []).map(finalizeStream));
    const seen = new Set();
    const out = [];
    for (const stream of finalized) {
        if (!stream || !stream.url || seen.has(stream.url)) continue;
        seen.add(stream.url);
        out.push(stream);
    }
    return out;
}

const TMDB_API_KEY = process.env.TMDB_API_KEY || '8265bd1679663a7ea12ac168da84d2e8';
const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_ALLOWED_PATHS = /^(search\/(multi|movie|tv)|discover\/(movie|tv)|trending\/(all|movie|tv)\/(day|week)|genre\/(movie|tv)\/list|movie\/\d+(\/(credits|recommendations|similar))?|tv\/\d+(\/(credits|season\/\d+|recommendations|similar))?|movie\/(popular|top_rated|now_playing|upcoming)|tv\/(popular|top_rated|on_the_air|airing_today))$/;
const tmdbCache = new Map();
const TMDB_CACHE_TTL_MS = 10 * 60 * 1000;

async function handleTmdbRequest(req, res, url) {
    if (req.method !== 'GET' || url.pathname !== '/api/tmdb') return false;
    if (!TMDB_API_KEY) return json(res, 503, { error: 'Clé TMDB non configurée (TMDB_API_KEY).' });

    const tmdbPath = (url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
    if (!tmdbPath || !TMDB_ALLOWED_PATHS.test(tmdbPath)) {
        return json(res, 400, { error: 'Chemin TMDB non autorisé.' });
    }

    const params = new URLSearchParams(url.searchParams);
    params.delete('path');
    params.set('api_key', TMDB_API_KEY);
    if (!params.get('language')) params.set('language', 'fr-FR');

    const cacheKey = `${tmdbPath}?${params.toString()}`;
    const cached = tmdbCache.get(cacheKey);
    if (cached && Date.now() - cached.t < TMDB_CACHE_TTL_MS) return json(res, 200, cached.d);

    try {
        const response = await fetchRemote(`${TMDB_API_BASE}/${tmdbPath}?${params}`, { headers: { accept: 'application/json' } });
        if (!response.ok) return json(res, response.status, { error: `TMDB: HTTP ${response.status}` });
        const data = await response.json();
        tmdbCache.set(cacheKey, { t: Date.now(), d: data });
        if (tmdbCache.size > 300) tmdbCache.delete(tmdbCache.keys().next().value);
        return json(res, 200, data);
    } catch (error) {
        return json(res, 502, { error: `TMDB injoignable: ${error.message}` });
    }
}

function isUnsafeProxyHost(hostname) {
    const host = hostname.toLowerCase();
    return host === 'localhost' || host === '::1' || host === '0.0.0.0'
        || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.')
        || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

function proxyUrl(baseUrl, target, headers = {}) {
    const params = new URLSearchParams({ url: target });
    if (Object.keys(headers).length) params.set('headers', JSON.stringify(headers));
    return `${baseUrl}/api/proxy?${params}`;
}

async function fetchRemote(url, options) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const response = await fetch(url, options);
            if (response.status < 500 || attempt === 2) return response;
            await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        } catch (error) {
            lastError = error;
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
    }
    throw lastError || new Error('Source distante indisponible');
}

async function handleProxyRequest(req, res, url) {
    if (req.method !== 'GET' || url.pathname !== '/api/proxy') return false;

    let target;
    try {
        target = new URL(url.searchParams.get('url') || '');
        if (!['http:', 'https:'].includes(target.protocol) || isUnsafeProxyHost(target.hostname)) throw new Error('URL refusée');
    } catch (_) {
        return json(res, 400, { error: 'URL de source invalide.' });
    }

    let headers = {};
    try {
        headers = JSON.parse(url.searchParams.get('headers') || '{}');
        headers = Object.fromEntries(Object.entries(headers).filter(([key, value]) =>
            ['referer', 'origin', 'user-agent', 'accept', 'accept-language', 'cookie'].includes(key.toLowerCase()) && typeof value === 'string'
        ));
    } catch (_) {
        headers = {};
    }
    headers['User-Agent'] = headers['User-Agent'] || 'Mozilla/5.0';
    if (req.headers.range) headers.Range = req.headers.range;

    try {
        const response = await fetchRemote(target, { headers, redirect: 'follow' });
        if (!response.ok) return json(res, response.status, { error: `Source distante: HTTP ${response.status}` });
        const contentType = response.headers.get('content-type') || '';
        const isPlaylist = contentType.includes('mpegurl') || /\.m3u8(?:$|\?)/i.test(response.url || target.href);

        /* Les pages HTML ne sont pas des flux vidéo — mais ne pas rejeter une requête
           Range (reprise/seek) : certains hébergeurs répondent HTML sur un Range invalide. */
        if (contentType.includes('text/html') && !req.headers.range) {
            return json(res, 502, { error: 'La source a renvoyé une page HTML au lieu d’un flux vidéo.' });
        }

        if (isPlaylist) {
            let playlist = await response.text();
            const base = new URL(response.url || target.href);
            playlist = playlist.split(/\r?\n/).map(line => {
                const uriMatch = line.match(/URI="([^"]+)"/);
                const raw = uriMatch ? uriMatch[1] : (!line.startsWith('#') && line.trim() ? line.trim() : null);
                if (!raw) return line;
                const absolute = new URL(raw, base).href;
                const rewritten = proxyUrl('', absolute, headers);
                return uriMatch ? line.replace(uriMatch[1], rewritten) : rewritten;
            }).join('\n');
            const playlistHeaders = {
                'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
                'Cache-Control': 'no-store',
            };
            /* VOD : autoriser le seek sur la playlist elle-même (requêtes Range) */
            if (req.headers.range) {
                const rangeHeader = req.headers.range;
                const playlistBuffer = Buffer.from(playlist, 'utf8');
                const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
                if (match) {
                    const start = match[1] ? parseInt(match[1], 10) : playlistBuffer.length - parseInt(match[2], 10);
                    const end = match[2] && match[1] ? Math.min(parseInt(match[2], 10), playlistBuffer.length - 1) : playlistBuffer.length - 1;
                    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && start < playlistBuffer.length) {
                        playlistHeaders['Content-Range'] = `bytes ${start}-${end}/${playlistBuffer.length}`;
                        playlistHeaders['Content-Length'] = String(end - start + 1);
                        playlistHeaders['Accept-Ranges'] = 'bytes';
                        res.writeHead(206, playlistHeaders);
                        res.end(playlistBuffer.subarray(start, end + 1));
                        return true;
                    }
                }
            }
            playlistHeaders['Accept-Ranges'] = 'bytes';
            playlistHeaders['Content-Length'] = String(Buffer.byteLength(playlist, 'utf8'));
            res.writeHead(200, playlistHeaders);
            res.end(playlist);
            return true;
        }

        const responseHeaders = {
            'Content-Type': contentType || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'Accept-Ranges': response.headers.get('accept-ranges') || 'bytes',
        };
        for (const name of ['content-length', 'content-range', 'last-modified', 'etag']) {
            const value = response.headers.get(name);
            if (value) responseHeaders[name] = value;
        }
        res.writeHead(response.status === 206 ? 206 : 200, responseHeaders);
        if (response.body) Readable.fromWeb(response.body).pipe(res);
        else res.end();
        return true;
    } catch (error) {
        console.error(`[proxy] ${target.href}: ${error.message}`);
        return json(res, 502, { error: 'Impossible de joindre la source distante.' });
    }
}

function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(payload);
}

function withTimeout(promise, timeoutMs) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timeout après ${timeoutMs} ms`)), timeoutMs);
            timer.unref?.();
        }),
    ]);
}

function providerInfo(provider) {
    return {
        id: provider.id,
        name: provider.name,
        description: provider.description,
        supportedTypes: provider.supportedTypes,
        contentLanguage: provider.contentLanguage,
        formats: provider.formats,
        logo: provider.logo,
    };
}

function normalizeStream(stream, provider) {
    return {
        url: stream.url,
        title: stream.title || stream.name || `${provider.name} (FR)`,
        quality: stream.quality || null,
        type: stream.type || null,
        language: stream.language || 'fr',
        provider: provider.id,
        providerName: provider.name,
        headers: stream.headers || undefined,
    };
}

function hosterFromStream(stream) {
    const url = stream.url;
    const isHls = stream.type === 'hls' || /\.m3u8(?:[?#]|$)/i.test(url);
    return {
        provider: stream.provider,
        name: stream.providerName,
        nom: stream.providerName,
        title: stream.title,
        quality: stream.quality,
        language: stream.language,
        lang: stream.language,
        type: isHls ? 'hls' : (stream.type || 'direct'),
        headers: stream.headers,
        ...(isHls ? { m3u8: url } : { directUrl: url }),
        videoUrl: url,
    };
}

function validateQuery(url) {
    const tmdbId = url.searchParams.get('tmdbId');
    const mediaType = url.searchParams.get('mediaType') || 'movie';
    const season = url.searchParams.get('season');
    const episode = url.searchParams.get('episode');

    if (!tmdbId || !/^[a-zA-Z0-9_-]+$/.test(tmdbId)) {
        return { error: 'Le paramètre tmdbId est obligatoire.' };
    }
    if (!['movie', 'tv'].includes(mediaType)) {
        return { error: 'mediaType doit être « movie » ou « tv ».' };
    }
    if (mediaType === 'tv' && (!/^\d+$/.test(season || '') || !/^\d+$/.test(episode || ''))) {
        return { error: 'season et episode sont obligatoires pour une série TV.' };
    }

    return { tmdbId, mediaType, season: season || undefined, episode: episode || undefined };
}

async function getProviderStreams(provider, query) {
    try {
        const streams = await withTimeout(
            provider.implementation.getStreams(query.tmdbId, query.mediaType, query.season, query.episode),
            DEFAULT_TIMEOUT_MS
        );
        return {
            provider: providerInfo(provider),
            status: 'ok',
            streams: Array.isArray(streams)
                ? streams.filter(stream => stream && typeof stream.url === 'string' && stream.url.trim())
                    .map(stream => normalizeStream(stream, provider))
                : [],
        };
    } catch (error) {
        return {
            provider: providerInfo(provider),
            status: 'error',
            error: error.message,
            streams: [],
        };
    }
}

/* Cache de succès par (type, tmdbId, saison/épisode) : quand une requête /api/streams
   n'a rien trouvé dans la fenêtre de deadline, on retient la promesse du fond pour
   servir le résultat dès le rappel suivant. */
const streamSuccessCache = new Map();
/* Stats de vitesse par provider : les gagnants passent en tête de file au prochain
   appel → la fenêtre de deadline capture d'abord les sites réactifs. */
const providerSpeed = new Map();
function providerPriority(id) { return (providerSpeed.get(id) || { wins: 0 }).wins; }
async function handleApiRequest(req, res, url) {
    if (req.method !== 'GET') {
        return json(res, 405, { error: 'Méthode non autorisée.' });
    }

    if (url.pathname === '/api/tmdb') return handleTmdbRequest(req, res, url);

    if (url.pathname === '/api/health') {
        return json(res, 200, {
            status: 'ok',
            language: 'fr',
            providers: providers.size,
            timestamp: new Date().toISOString(),
        });
    }

    if (url.pathname === '/api/providers') {
        return json(res, 200, {
            language: 'fr',
            count: providers.size,
            providers: [...providers.values()].map(providerInfo),
        });
    }

    const providerMatch = url.pathname.match(/^\/api\/streams\/([^/]+)$/);
    if (providerMatch || url.pathname === '/api/streams') {
        const query = validateQuery(url);
        if (query.error) return json(res, 400, { error: query.error });

        const requested = providerMatch ? providerMatch[1] : (url.searchParams.get('provider') || 'all');
        const selected = requested === 'all'
            ? [...providers.values()].filter(candidate => candidate.supportedTypes?.includes(query.mediaType))
            : [providers.get(requested)].filter(Boolean);

        if (!selected.length) return json(res, 404, { error: `Provider inconnu: ${requested}` });

        /* Course INDIVIDUELLE par provider contre la deadline, avec LIMITATION DE
           CONCURRENCE : lancer 18 scrapers en parallèle sature le CPU des petits
           conteneurs Railway → tous dépassent la deadline. Un pool limite le
           nombre de sites interrogés simultanément pour que les rapides finissent. */
        /* Cache de fond : si une requête précédente pour le même média n'a pas eu
           le temps de répondre, ses scrapers ont continué en arrière-plan. On sert
           d'abord leurs résultats tardifs (rappel quasi instantané). */
        const cacheKey = `streams:${query.mediaType}:${query.tmdbId}:${query.season || ''}x${query.episode || ''}`;
        const cached = streamSuccessCache.get(cacheKey);
        if (cached) {
            await Promise.race([cached.done, new Promise(resolve => setTimeout(resolve, 2500))]);
            const cachedStreams = cached.results.flatMap(result => (result && result.streams) || []);
            if (cachedStreams.length) {
                const streams = await withGlobalDeadline(finalizeStreams(cachedStreams), GLOBAL_TIMEOUT_MS, cachedStreams);
                return json(res, 200, {
                    language: 'fr',
                    query,
                    provider: requested,
                    total: streams.length,
                    streams,
                    hosters: streams.map(hosterFromStream),
                    providers: cached.results.map(result => ({
                        id: result.provider.id,
                        name: result.provider.name,
                        status: result.status,
                        count: result.streams.length,
                        error: result.error,
                    })),
                });
            }
        }
        const startedAt = Date.now();
        const providerDeadline = Math.max(5000, GLOBAL_TIMEOUT_MS - 5000); // réserve du temps pour la finalisation
        const MAX_CONCURRENCY = Number(process.env.API_MAX_CONCURRENCY || 8);
        const results = [];
        const backgrounds = [];
        const pending = new Set();
        const queue = [...selected].sort((a, b) => providerPriority(b.id) - providerPriority(a.id));
        const launches = [];
        let doneResolve;
        const done = new Promise(resolve => { doneResolve = resolve; });
        streamSuccessCache.set(cacheKey, { at: Date.now(), results, done });
        if (streamSuccessCache.size > 200) streamSuccessCache.delete(streamSuccessCache.keys().next().value);
        while (queue.length || pending.size) {
            while (queue.length && pending.size < MAX_CONCURRENCY) {
                const provider = queue.shift();
                /* Deadline ABSOLUE : un provider lancé tardivement hérite du temps
                   restant, jamais d'un créneau complet (sinon on dépasse la borne). */
                const remainingForProvider = Math.max(2000, startedAt + providerDeadline - Date.now());
                /* Le scraping réel continue en arrière-plan et alimente `results`
                   même après la deadline → récupéré par le prochain rappel (cache). */
                const providerStart = Date.now();
                const real = getProviderStreams(provider, query).then(result => {
                    results.push(result);
                    if (result.streams.length) {
                        const stat = providerSpeed.get(provider.id) || { wins: 0 };
                        stat.wins = Math.min(50, stat.wins + 1);
                        providerSpeed.set(provider.id, stat);
                    }
                    return result;
                });
                backgrounds.push(real);
                const task = withGlobalDeadline(real, remainingForProvider, null)
                    .catch(() => null)
                    .finally(() => { pending.delete(task); });
                pending.add(task);
                launches.push(task);
            }
            if (pending.size) await Promise.race(pending);
        }
        await Promise.all(launches);
        doneResolve(Promise.all(backgrounds).catch(() => []));
        /* Les providers encore en cours au moment de la deadline sont marqués timeout. */
        const doneIds = new Set(results.map(result => result.provider.id));
        const timedOut = selected
            .filter(provider => !doneIds.has(provider.id))
            .map(provider => ({ id: provider.id, name: provider.name, status: 'timeout', count: 0, error: 'Délai global dépassé' }));
        const remaining = Math.max(3000, GLOBAL_TIMEOUT_MS - (Date.now() - startedAt));
        const streams = await withGlobalDeadline(
            finalizeStreams(results.flatMap(result => result.streams)),
            remaining,
            results.flatMap(result => result.streams)
        );
        return json(res, 200, {
            language: 'fr',
            query,
            provider: requested,
            total: streams.length,
            streams,
            hosters: streams.map(hosterFromStream),
            providers: [
                ...results.map(result => ({
                    id: result.provider.id,
                    name: result.provider.name,
                    status: result.status,
                    count: result.streams.length,
                    error: result.error,
                })),
                ...timedOut,
            ],
        });
    }

    return false;
}

module.exports = { handleApiRequest, handleProxyRequest, providers, classifyStream, finalizeStreams };
