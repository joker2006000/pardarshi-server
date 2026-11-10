require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');

const app = require('./app');
const db = require('./config/db'); 
require('./services/push.worker');
require('./services/alert.cron');
const cashfreeService = require('./services/cashfree.service');
const aiController = require('./controllers/ai.controller');

const PORT = process.env.PORT || 3000;

// ==========================================
// 1. INITIALIZE HTTP & SOCKET.IO
// ==========================================
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

app.set('io', io);

// ==========================================
// 2. SOCKET.IO ROOM LOGIC (For Report Chats)
// ==========================================
io.on('connection', (socket) => {
    console.log(`🔌 New Socket.io client connected: ${socket.id}`);

    socket.on('join_report', (reportId) => {
        const roomName = `report_${reportId}`;
        socket.join(roomName);
        console.log(`User joined room: ${roomName}`);
    });

    socket.on('disconnect', () => {
        console.log(`❌ Socket.io client disconnected: ${socket.id}`);
    });
});

// ==========================================
// 3. RAW WEBSOCKET SERVER (For Gemini Live AI)
// ==========================================
// Using { noServer: true } prevents 'ws' from breaking Socket.io's upgrade listener
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, req) => {
    aiController.handleAiWebSocketConnection(ws, req);
});

// Intercept HTTP Upgrade requests ONLY for '/ai-stream'
server.on('upgrade', (request, socket, head) => {
    const rawPath = request.url.split('?')[0];
    const pathname = rawPath.endsWith('/') && rawPath.length > 1 ? rawPath.slice(0, -1) : rawPath;

    if (pathname === '/ai-stream') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    }
    // Note: If pathname is '/socket.io/', we do nothing here so Socket.io handles it natively!
});

// ==========================================
// 4. SERVER STARTUP
// ==========================================
const startServer = async () => {
    try {
        console.log("Starting server checks...");

        const connection = await db.getConnection();
        console.log("✅ Database connected successfully.");
        connection.release();

        await cashfreeService.verifyConnection();
        console.log("✅ Cashfree payment system verified and ready.");

        server.listen(PORT, () => {
            console.log(`🚀 PARDARSHI API & WebSockets running live on port ${PORT}`);
            console.log(`💬 Socket.io active on /socket.io/`);
            console.log(`🎙️ Gemini Live AI active on /ai-stream`);
        });

    } catch (error) {
        console.error("❌ Server startup failed:");
        console.error(error.message);
        process.exit(1); 
    }
};

startServer();