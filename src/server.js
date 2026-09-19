require('dotenv').config();
const http = require('http');          // NEW: Required for WebSockets
const { Server } = require('socket.io'); // NEW: Import Socket.io

const app = require('./app');
const db = require('./config/db'); 
const cashfreeService = require('./services/cashfree.service');
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. INITIALIZE HTTP & SOCKET.IO
// ==========================================
// Wrap the Express app with Node's native HTTP server
const server = http.createServer(app);

// Attach Socket.io to the server
const io = new Server(server, {
    cors: {
        origin: "*", // Adjust to your specific frontend domains in production
        methods: ["GET", "POST"]
    }
});

// Save the 'io' instance directly into the Express app so the bridge middleware can find it
app.set('io', io);

// ==========================================
// 2. SOCKET.IO ROOM LOGIC
// ==========================================
io.on('connection', (socket) => {
    console.log(`🔌 New client connected: ${socket.id}`);

    // When a frontend loads the chat window, it emits 'join_report' with the report ID
    socket.on('join_report', (reportId) => {
        // Create an isolated, secure room specifically for this one report
        const roomName = `report_${reportId}`;
        socket.join(roomName);
        console.log(`User joined room: ${roomName}`);
    });

    socket.on('disconnect', () => {
        console.log(`❌ Client disconnected: ${socket.id}`);
    });
});

// ==========================================
// 3. SERVER STARTUP
// ==========================================
const startServer = async () => {
    try {
        console.log("Starting server checks...");

        const connection = await db.getConnection();
        console.log("✅ Database connected successfully.");
        connection.release();

        await cashfreeService.verifyConnection();
        console.log("✅ Cashfree payment system verified and ready.");

        // CRITICAL: We now use server.listen() instead of app.listen()
        server.listen(PORT, () => {
            console.log(`🚀 PARDARSHI API & WebSockets running live on port ${PORT}`);
        });

    } catch (error) {
        console.error("❌ Server startup failed:");
        console.error(error.message);
        process.exit(1); 
    }
};

startServer();