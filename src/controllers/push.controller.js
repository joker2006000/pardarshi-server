const db = require('../config/db');

exports.subscribe = async (req, res) => {
    // We now expect org_slug instead of organization_id
    const { guest_token, org_slug, subscription } = req.body;
    
    try {
        // 1. Look up the real organization ID
        const [orgs] = await db.query(`SELECT organization_id FROM organizations WHERE slug = ?`, [org_slug]);
        
        if (orgs.length === 0) {
            return res.status(404).json({ error: 'Organization not found' });
        }
        
        const organization_id = orgs[0].organization_id;

        // 2. Save the subscription safely
        await db.query(
            `INSERT INTO push_subscriptions (guest_token, organization_id, endpoint, p256dh, auth) 
             VALUES (?, ?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE p256dh = VALUES(p256dh), auth = VALUES(auth)`,
            [guest_token, organization_id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
        );
        
        res.status(201).json({ success: true });
    } catch (error) {
        console.error("Push Subscribe Error:", error);
        res.status(500).json({ error: 'Failed to subscribe' });
    }
};