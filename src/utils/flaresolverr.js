/**
 * Client FlareSolverr — solution de secours anti-bot (navigateur headless).
 *
 * FlareSolverr est un proxy qui exécute un vrai Chromium pour résoudre les
 * challenges Cloudflare/BotBlocker/Turnstile, puis retourne le HTML final.
 *
 * API : POST {base}/v1 avec {"cmd":"request.get","url":..., "maxTimeout":60000}
 * Réponse : {"status":"ok","solution":{"response": "<html>", "status": 200}}
 *
 * Activation : variable d'env FLARESOLVERR_URL (ex. http://flaresolverr.railway.internal:8191).
 * Sans cette variable, tout est un no-op quasi gratuit (les providers utilisent
 * leur chemin classique). Pour les tests locaux : FLARESOLVERR_URL=http://localhost:8191
 */

function flaresolverrBase() {
    if (typeof process === 'undefined' || !process.env) return '';
    return String(process.env.FLARESOLVERR_URL || '').trim().replace(/\/+$/, '');
}

export function flaresolverrEnabled() {
    return Boolean(flaresolverrBase());
}

/**
 * Récupère une page via FlareSolverr. Retourne le HTML (string) ou null.
 * @param {string} url URL absolue à récupérer
 * @param {{maxTimeout?: number, returnOnlyCookies?: boolean}} [opts]
 */
export async function flareFetchText(url, opts = {}) {
    const base = flaresolverrBase();
    if (!base) return null;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), (opts.maxTimeout || 60000) + 5000);
        const res = await fetch(base + '/v1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cmd: 'request.get',
                url,
                maxTimeout: opts.maxTimeout || 60000,
                returnOnlyCookies: Boolean(opts.returnOnlyCookies),
            }),
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
            console.log(`[FlareSolverr] HTTP ${res.status} pour ${url}`);
            return null;
        }
        const data = await res.json();
        if (data.status !== 'ok' || !data.solution) {
            console.log(`[FlareSolverr] Échec (${data.status}) pour ${url}`);
            return null;
        }
        return String(data.solution.response || '');
    } catch (e) {
        console.log(`[FlareSolverr] Erreur pour ${url}: ${e.message}`);
        return null;
    }
}

/**
 * GET "normal" via FlareSolverr, même forme de retour que safeFetch()
 * ({ ok, status, text }) pour s'insérer dans les http.js existants.
 */
export async function flareFetchResponse(url, opts = {}) {
    const html = await flareFetchText(url, opts);
    if (!html) return null;
    return {
        ok: true,
        status: 200,
        text: () => Promise.resolve(html),
    };
}
