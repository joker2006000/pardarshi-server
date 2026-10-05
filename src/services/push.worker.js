const webpush = require('web-push');
const db = require('../config/db');

webpush.setVapidDetails(
    'mailto:admin@pardarshi.com', 
    process.env.VAPID_PUBLIC_KEY, 
    process.env.VAPID_PRIVATE_KEY
);

const processPushQueue = async () => {
    try {
        const [tasks] = await db.query(`SELECT * FROM notification_queue WHERE status = 'pending' LIMIT 50`);
        if (tasks.length === 0) return;

        for (const task of tasks) {
            let query = `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE organization_id = ?`;
            let params = [task.organization_id];
            if (task.guest_token) {
                query += ` AND guest_token = ?`;
                params.push(task.guest_token);
            }

            const [subs] = await db.query(query, params);
            
            // Format payload with URL routing for your dynamic pages
            const payload = JSON.stringify({ 
                title: task.title, 
                body: task.body,
                url: task.url || '/'
            });

            // CRITICAL: High urgency forces Android out of Doze mode when screen is off
            const pushOptions = {
                urgency: 'high',
                TTL: 86400
            };

            const pushPromises = subs.map(sub => 
                webpush.sendNotification(
                    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, 
                    payload, 
                    pushOptions
                )
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

setInterval(processPushQueue, 10000);