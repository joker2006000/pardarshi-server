const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const db = require('../config/db');
const fs = require('fs');

// Initialize Firebase Admin (Smart Path Detection)
if (getApps().length === 0) {
    let serviceAccount;
    
    // Check if running on the live Render server
    if (fs.existsSync('/etc/secrets/firebase-service-account.json')) {
        serviceAccount = require('/etc/secrets/firebase-service-account.json');
    } 
    // Fallback for your local computer
    else {
        serviceAccount = require('../config/firebase-service-account.json');
    }

    initializeApp({ credential: cert(serviceAccount) });
}

const processPushQueue = async () => {
    try {
        const [tasks] = await db.query(`SELECT * FROM notification_queue WHERE status = 'pending' LIMIT 50`);
        if (tasks.length === 0) return;

      for (const task of tasks) {
            let query = `SELECT fcm_token FROM push_subscriptions WHERE organization_id = ? AND fcm_token IS NOT NULL`;
            let params = [task.organization_id];
            
            // --- ROUTING LOGIC ---
            if (task.guest_token === 'BROADCAST') {
                query += ` AND guest_token IS NOT NULL`; // All contributors
            } else if (task.guest_token) {
                query += ` AND guest_token = ?`; // Specific contributor
                params.push(task.guest_token);
            } else {
                query += ` AND guest_token IS NULL`; // Admins only
            }

            const [subs] = await db.query(query, params);
            const tokens = subs.map(sub => sub.fcm_token).filter(Boolean);

            // --- FIREBASE 500-TOKEN BATCHING ---
            if (tokens.length > 0) {
                const chunkSize = 500;
                for (let i = 0; i < tokens.length; i += chunkSize) {
                    const tokenBatch = tokens.slice(i, i + chunkSize);
                    await getMessaging().sendEachForMulticast({
                        tokens: tokenBatch,
                        notification: { title: task.title, body: task.body },
                        android: {
                            priority: 'high',
                            notification: { channelId: 'default', sound: 'default', visibility: 'public', priority: 'max' }
                        },
                        data: { url: task.url || '/mobile-start' }
                    });
                }
            }
            
            await db.query(`UPDATE notification_queue SET status = 'processed' WHERE id = ?`, [task.id]);
        }
    } catch (error) {
        console.error("Native Push Worker Error:", error);
    }
};

setInterval(processPushQueue, 10000);