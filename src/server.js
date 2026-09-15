require('dotenv').config();
const app = require('./app');
const db = require('./config/db'); // Your database connection pool
const cashfreeService = require('./services/cashfree.service');
const PORT = process.env.PORT || 3000;

const startServer = async () => {
    try {
        console.log("Starting server checks...");

        // 1. Test Database Connection
        const connection = await db.getConnection();
        console.log("✅ Database connected successfully.");
        connection.release();

        // 2. Test Cashfree Payment System Connection
        await cashfreeService.verifyConnection();
        console.log("✅ Cashfree payment system verified and ready.");



        // 3. Start the Server
        app.listen(PORT, () => {
            console.log(`🚀 PARDARSHI API is running live on port ${PORT}`);
        });

    } catch (error) {
        console.error("❌ Server startup failed:");
        console.error(error.message);
        
        // This forces the server to stop completely if a critical system is broken
        process.exit(1); 
    }
};

startServer();