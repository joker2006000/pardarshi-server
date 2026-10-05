const db = require('../config/db');

exports.subscribe = async (req, res) => {
    const { guest_token, organization_id, subscription } = req.body;
    try {
        await db.query(
            `INSERT INTO push_subscriptions (guest_token, organization_id, endpoint, p256dh, auth) 
             VALUES (?, ?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE p256dh = VALUES(p256dh), auth = VALUES(auth)`,
            [guest_token, organization_id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
        );
        res.status(201).json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to subscribe' });
    }
};