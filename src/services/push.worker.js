const webpush = require('web-push');
const db = require('../config/db');

// You must generate these in your terminal via `npx web-push generate-vapid-keys` and add to your .env
webpush.setVapidDetails('mailto:admin@pardarshi.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

const processPushQueue = async () => {
    try {
        // Find pending notifications
        const [tasks] = await db.query(`SELECT * FROM notification_queue WHERE status = 'pending' LIMIT 50`);
        if (tasks.length === 0) return;

        for (const task of tasks) {
            // Find targets (either a specific guest token, or all subscribers for the org)
            let query = `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE organization_id = ?`;
            let params = [task.organization_id];
            if (task.guest_token) {
                query += ` AND guest_token = ?`;
                params.push(task.guest_token);
            }

            const [subs] = await db.query(query, params);
            const payload = JSON.stringify({ title: task.title, body: task.body });

            const pushPromises = subs.map(sub => 
                webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload)
                .catch(err => {
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        db.query(`DELETE FROM push_subscriptions WHERE endpoint = ?`, [sub.endpoint]);
                    }
                })
            );

            await Promise.all(pushPromises);
            await db.query(`UPDATE notification_queue SET status = 'processed' WHERE id = ?`, [task.id]);
        }
    } catch (error) {
        console.error("Push Worker Error:", error);
    }
};

// Sweep the database every 10 seconds silently
setInterval(processPushQueue, 10000);