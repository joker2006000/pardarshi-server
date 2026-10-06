const admin = require('firebase-admin');
const db = require('../config/db');
const fs = require('fs');

// Initialize Firebase Admin (Smart Path Detection)
if (!admin.apps.length) {
    let serviceAccount;
    
    // Check if running on the live Render server
    if (fs.existsSync('/etc/secrets/firebase-service-account.json')) {
        serviceAccount = require('/etc/secrets/firebase-service-account.json');
    } 
    // Fallback for your local computer
    else {
        serviceAccount = require('../config/firebase-service-account.json');
    }

    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

// ... (keep the rest of your processPushQueue code exactly the same below here)

const processPushQueue = async () => {
    try {
        const [tasks] = await db.query(`SELECT * FROM notification_queue WHERE status = 'pending' LIMIT 50`);
        if (tasks.length === 0) return;

        for (const task of tasks) {
            let query = `SELECT fcm_token FROM push_subscriptions WHERE organization_id = ? AND fcm_token IS NOT NULL`;
            let params = [task.organization_id];
            
            if (task.guest_token) {
                query += ` AND guest_token = ?`;
                params.push(task.guest_token);
            }

            const [subs] = await db.query(query, params);
            const tokens = subs.map(sub => sub.fcm_token).filter(Boolean);

            if (tokens.length > 0) {
                await admin.messaging().sendEachForMulticast({
                    tokens: tokens,
                    notification: { title: task.title, body: task.body },
                    android: {
                        priority: 'high',
                        notification: { channelId: 'default', sound: 'default', visibility: 'public', priority: 'max' }
                    },
                    data: { url: task.url || '/mobile-start' }
                });
            }

            await db.query(`UPDATE notification_queue SET status = 'processed' WHERE id = ?`, [task.id]);
        }
    } catch (error) {
        console.error("Native Push Worker Error:", error);
    }
};

setInterval(processPushQueue, 10000);