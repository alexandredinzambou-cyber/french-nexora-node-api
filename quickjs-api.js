'use strict';

/**
 * QuickJS API Server - serves the 20+ QuickJS providers (anime-sama, frenchstream, etc.)
 * Runs on port 3300 by default.
 * Used by NOX server to combine with French Nexora Node API providers.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleApiRequest, handleProxyRequest } = require('./api.js');

const PORT = process.env.PORT || 3300;
const HOST = '0.0.0.0';

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    
    // CORS headers for same-origin calls from NOX
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-NOX-Code');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }
    
    // Handle API routes
    if (url.pathname.startsWith('/api/')) {
        const handled = await handleApiRequest(req, res, url);
        if (handled !== false) return;
        
        // Fallback for proxy requests
        await handleProxyRequest(req, res, url);
        return;
    }
    
    // Health check
    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ 
            status: 'ok', 
            service: 'QuickJS API',
            providers: require('./api.js').providers.size 
        }));
    }
    
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, HOST, () => {
    const ip = require('os').networkInterfaces();
    let localIp = 'localhost';
    for (const name of Object.keys(ip)) {
        for (const iface of ip[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                localIp = iface.address;
                break;
            }
        }
    }
    console.log(`\n🚀 QuickJS API Server running at: http://${localIp}:${PORT}/`);
    console.log(`📡 Providers: ${require('./api.js').providers.size} QuickJS providers loaded`);
    console.log(`🔗 Endpoints: /api/providers, /api/streams, /api/streams/:provider`);
    console.log('Press Ctrl+C to stop\n');
});

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down QuickJS API...');
    server.close(() => {
        console.log('✅ QuickJS API closed');
        process.exit(0);
    });
});

module.exports = { server };