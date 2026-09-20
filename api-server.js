/* Petit serveur dédié à l'API French Nexora — port 3200 par défaut.
   Ne touche ni au site NOX (server.js, port 3100) ni à l'API Nexora Node (port 3000).
   Usage : node api-server.js   (PORT=xxxx node api-server.js pour changer le port) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleApiRequest, handleProxyRequest } = require('./api');

const PORT = process.env.PORT || 3200;
const HOST = '0.0.0.0';

const server = http.createServer((req, res) => {
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

    // Page de test HTML sur /
    if (requestUrl.pathname === '/') {
        const page = path.join(__dirname, 'index.html');
        fs.readFile(page, (err, content) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Page de test introuvable. Endpoints : /api/health, /api/providers, /api/streams, /api/tmdb, /api/proxy');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        });
        return;
    }

    if (!requestUrl.pathname.startsWith('/api/')) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Route inconnue. Ce serveur ne sert que /api/* et la page de test sur /.' }));
        return;
    }

    handleProxyRequest(req, res, requestUrl).then((proxied) => {
        if (proxied) return true;
        return handleApiRequest(req, res, requestUrl);
    }).then((handled) => {
        if (handled === false && !res.writableEnded) {
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Route API introuvable.' }));
        }
    }).catch((error) => {
        console.error('[api]', error);
        if (!res.writableEnded) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Erreur interne du serveur.' }));
        }
    });
});

server.listen(PORT, HOST, () => {
    console.log(`\n🚀 French Nexora API (petit serveur de test) : http://localhost:${PORT}/`);
    console.log(`🧪 Page de test:          http://localhost:${PORT}/`);
    console.log(`📡 Endpoints:             /api/health · /api/providers · /api/streams · /api/tmdb · /api/proxy`);
    console.log('Press Ctrl+C to stop\n');
});

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    server.close(() => process.exit(0));
});