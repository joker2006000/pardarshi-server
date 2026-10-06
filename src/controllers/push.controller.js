const db = require('../config/db');

exports.subscribe = async (req, res) => {
    const { guest_token, org_slug, fcm_token } = req.body;
    
    try {
        const [orgs] = await db.query(`SELECT organization_id FROM organizations WHERE slug = ?`, [org_slug]);
        if (orgs.length === 0) return res.status(404).json({ error: 'Organization not found' });
        
        const organization_id = orgs[0].organization_id;

        if (fcm_token) {
            await db.query(
                `INSERT INTO push_subscriptions (guest_token, organization_id, fcm_token) 
                 VALUES (?, ?, ?) 
                 ON DUPLICATE KEY UPDATE fcm_token = VALUES(fcm_token)`,
                [guest_token, organization_id, fcm_token]
            );
            return res.status(201).json({ success: true, mode: 'fcm' });
        }
    } catch (error) {
        console.error("Push Subscribe Error:", error);
        res.status(500).json({ error: 'Failed to subscribe' });
    }
};