const https = require('https');
const http = require('http');

let cachedData = {};
let rateLimitMap = new Map();
const PORT = process.env.PORT || 20973;

const RATE_LIMIT = {
    MAX_REQUESTS: 10,
    WINDOW_MS: 60000,
    BLOCK_DURATION_MS: 300000
};

function checkRateLimit(ip) {
    const now = Date.now();
    
    if (!rateLimitMap.has(ip)) {
        rateLimitMap.set(ip, {
            requests: [],
            blockedUntil: 0
        });
    }
    
    const clientData = rateLimitMap.get(ip);
    
    if (clientData.blockedUntil > now) {
        const remainingMs = clientData.blockedUntil - now;
        return {
            allowed: false,
            blocked: true,
            remainingMs: remainingMs,
            remainingSeconds: Math.ceil(remainingMs / 1000)
        };
    }
    
    clientData.requests = clientData.requests.filter(
        timestamp => timestamp > now - RATE_LIMIT.WINDOW_MS
    );
    
    if (clientData.requests.length >= RATE_LIMIT.MAX_REQUESTS) {
        clientData.blockedUntil = now + RATE_LIMIT.BLOCK_DURATION_MS;
        return {
            allowed: false,
            blocked: true,
            remainingMs: RATE_LIMIT.BLOCK_DURATION_MS,
            remainingSeconds: Math.ceil(RATE_LIMIT.BLOCK_DURATION_MS / 1000)
        };
    }
    
    clientData.requests.push(now);
    
    return {
        allowed: true,
        blocked: false,
        remaining: RATE_LIMIT.MAX_REQUESTS - clientData.requests.length,
        resetIn: RATE_LIMIT.WINDOW_MS
    };
}

function makeRequest(url) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Request timeout'));
        }, 10000);

        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                clearTimeout(timeout);
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Parse error'));
                }
            });
        }).on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

async function getUserInfo(userId) {
    return await makeRequest(`https://users.roblox.com/v1/users/${userId}`);
}

async function getUserGames(userId) {
    const data = await makeRequest(`https://games.roblox.com/v2/users/${userId}/games?accessFilter=2&limit=50`);
    return data.data || [];
}

async function getGamepassPrice(gamepassId) {
    try {
        try {
            const productInfo = await makeRequest(`https://apis.roblox.com/game-passes/v1/game-passes/${gamepassId}/product-info`);
            
            if (productInfo) {
                if (productInfo.priceInformation && productInfo.priceInformation.defaultPriceInRobux !== undefined) {
                    const price = productInfo.priceInformation.defaultPriceInRobux;
                    if (price > 0) {
                        return { price, source: 'ProductAPI-priceInfo' };
                    }
                }
                
                if (productInfo.price !== undefined && productInfo.price !== null) {
                    const price = productInfo.price;
                    if (price > 0) {
                        return { price, source: 'ProductAPI-price' };
                    }
                }
                
                if (productInfo.PriceInRobux !== undefined && productInfo.PriceInRobux !== null) {
                    const price = productInfo.PriceInRobux;
                    if (price > 0) {
                        return { price, source: 'ProductAPI-PriceInRobux' };
                    }
                }
            }
        } catch (err) {
            // Continue to next API
        }
        
        try {
            const assetDetails = await makeRequest(`https://economy.roblox.com/v2/assets/${gamepassId}/details`);
            
            if (assetDetails) {
                if (assetDetails.priceInformation && assetDetails.priceInformation.defaultPriceInRobux !== undefined) {
                    const price = assetDetails.priceInformation.defaultPriceInRobux;
                    if (price > 0) {
                        return { price, source: 'AssetDetails' };
                    }
                }
                
                if (assetDetails.PriceInRobux !== undefined) {
                    const price = assetDetails.PriceInRobux;
                    if (price > 0) {
                        return { price, source: 'AssetDetails-old' };
                    }
                }
            }
        } catch (err) {
            // Continue
        }
        
        return null;
    } catch (error) {
        return null;
    }
}

async function getGamepassWithPrice(gamepassId, gamepassData, gameName) {
    const priceResult = await getGamepassPrice(gamepassId);
    const price = priceResult ? priceResult.price : 0;
    
    return {
        id: gamepassId,
        productId: gamepassData.productId || 0,
        name: gamepassData.name,
        displayName: gamepassData.displayName || gamepassData.name,
        price: price,
        hasPrice: price > 0,
        priceSource: priceResult ? priceResult.source : 'none',
        isForSale: gamepassData.isForSale || false,
        gameName: gameName
    };
}

async function getAllGamepassesWithPrices(games) {
    const allGamepasses = [];
    const seenIds = new Set();
    
    for (const game of games) {
        try {
            const url = `https://apis.roblox.com/game-passes/v1/universes/${game.id}/game-passes`;
            const data = await makeRequest(url);
            
            if (data.gamePasses && data.gamePasses.length > 0) {
                for (const gp of data.gamePasses) {
                    if (!seenIds.has(gp.id)) {
                        seenIds.add(gp.id);
                        allGamepasses.push({
                            gamepassData: gp,
                            gameName: game.name
                        });
                    }
                }
            }
        } catch (error) {
            continue;
        }
    }
    
    const BATCH_SIZE = 10;
    const results = [];
    
    for (let i = 0; i < allGamepasses.length; i += BATCH_SIZE) {
        const batch = allGamepasses.slice(i, i + BATCH_SIZE);
        
        const batchResults = await Promise.all(
            batch.map(({ gamepassData, gameName }) => 
                getGamepassWithPrice(gamepassData.id, gamepassData, gameName)
            )
        );
        
        results.push(...batchResults);
        
        if (i + BATCH_SIZE < allGamepasses.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    return results;
}

async function getUserCreatedTShirts(username) {
    try {
        const data = await makeRequest(
            `https://catalog.roblox.com/v1/search/items/details?Category=3&CreatorName=${encodeURIComponent(username)}&limit=50`
        );
        
        const tshirts = [];
        const seenIds = new Set();
        
        if (data.data && Array.isArray(data.data)) {
            for (const item of data.data) {
                const price = parseInt(item.price) || 0;
                if (!seenIds.has(item.id)) {
                    seenIds.add(item.id);
                    tshirts.push({
                        id: item.id,
                        name: item.name,
                        displayName: item.name,
                        price: price,
                        hasPrice: price > 0,
                        priceSource: 'catalog'
                    });
                }
            }
        }
        
        return tshirts;
    } catch (error) {
        return [];
    }
}

async function collectAllData(userId, username) {
    const startTime = Date.now();
    
    const [games, tshirts] = await Promise.all([
        getUserGames(userId),
        getUserCreatedTShirts(username)
    ]);
    
    if (games.length === 0) {
        return { 
            gamepasses: [], 
            tshirts,
            stats: { 
                fetchTime: Date.now() - startTime,
                totalGames: 0,
                totalGamepasses: 0,
                withPrice: tshirts.filter(t => t.hasPrice).length,
                totalValue: tshirts.reduce((sum, t) => sum + t.price, 0)
            }
        };
    }
    
    const gamepasses = await getAllGamepassesWithPrices(games);
    
    const fetchTime = Date.now() - startTime;
    const allItems = [...gamepasses, ...tshirts];
    const withPrice = allItems.filter(item => item.hasPrice);
    const totalValue = withPrice.reduce((sum, item) => sum + item.price, 0);
    
    return { 
        gamepasses,
        tshirts,
        stats: {
            fetchTime,
            totalGames: games.length,
            totalGamepasses: gamepasses.length,
            withPrice: withPrice.length,
            totalValue
        }
    };
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
                     req.socket.remoteAddress || 
                     'unknown';
    
    try {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        
        if (req.method === 'GET' && url.pathname.match(/^\/api\/assets\/(\d+)$/)) {
            const rateLimitCheck = checkRateLimit(clientIp);
            
            if (!rateLimitCheck.allowed) {
                res.setHeader('X-RateLimit-Blocked', 'true');
                res.setHeader('X-RateLimit-Reset', rateLimitCheck.remainingSeconds.toString());
                res.writeHead(429);
                res.end(JSON.stringify({ 
                    success: false,
                    error: 'Too Many Requests',
                    message: `Rate limit exceeded. Try again in ${rateLimitCheck.remainingSeconds} seconds.`,
                    retryAfter: rateLimitCheck.remainingSeconds
                }));
                return;
            }
            
            res.setHeader('X-RateLimit-Limit', RATE_LIMIT.MAX_REQUESTS.toString());
            res.setHeader('X-RateLimit-Remaining', rateLimitCheck.remaining.toString());
            res.setHeader('X-RateLimit-Reset', Math.ceil(rateLimitCheck.resetIn / 1000).toString());
            
            const userId = url.pathname.split('/').pop();
            
            if (cachedData[userId]) {
                res.writeHead(200, { 'X-Cache': 'HIT' });
                res.end(JSON.stringify({ ...cachedData[userId], cached: true }));
                return;
            }
            
            try {
                const userInfo = await getUserInfo(userId);
                const data = await collectAllData(userId, userInfo.name);
                
                const response = {
                    success: true,
                    userId: parseInt(userId),
                    username: userInfo.name,
                    displayName: userInfo.displayName,
                    gamepasses: data.gamepasses,
                    tshirts: data.tshirts,
                    totalItems: data.gamepasses.length + data.tshirts.length,
                    totalWithPrice: data.stats.withPrice,
                    totalValue: data.stats.totalValue,
                    fetchTime: data.stats.fetchTime,
                    timestamp: new Date().toISOString()
                };
                
                cachedData[userId] = response;
                
                res.writeHead(200, { 
                    'X-Cache': 'MISS',
                    'X-Fetch-Time': `${data.stats.fetchTime}ms`
                });
                res.end(JSON.stringify(response));
                
            } catch (error) {
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, error: error.message }));
            }
        }
        else if (req.method === 'GET' && url.pathname === '/api/status') {
            res.writeHead(200);
            res.end(JSON.stringify({
                status: 'running',
                version: '1.0.0',
                rateLimit: {
                    maxRequests: RATE_LIMIT.MAX_REQUESTS,
                    windowSeconds: RATE_LIMIT.WINDOW_MS / 1000,
                    blockDurationSeconds: RATE_LIMIT.BLOCK_DURATION_MS / 1000
                },
                cacheSize: Object.keys(cachedData).length,
                rateLimitClients: rateLimitMap.size
            }));
        }
        else if (req.method === 'DELETE' && url.pathname === '/api/cache') {
            cachedData = {};
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, message: 'Cache cleared' }));
        }
        else if (req.method === 'DELETE' && url.pathname.match(/^\/api\/cache\/(\d+)$/)) {
            const userId = url.pathname.split('/').pop();
            if (cachedData[userId]) {
                delete cachedData[userId];
                res.writeHead(200);
                res.end(JSON.stringify({ success: true, message: `Cache cleared for user ${userId}` }));
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ success: false, message: 'User not in cache' }));
            }
        }
        else {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
        }
    } catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Internal server error' }));
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
    server.close();
    process.exit(0);
});

process.on('SIGINT', () => {
    server.close();
    process.exit(0);
});