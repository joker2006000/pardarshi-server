const express = require('express');
const router = express.Router();
const db = require('../config/db');

router.post('/simulate-deduction', async (req, res) => {
    const { organization_id, project_id, amount } = req.body;
    try {
        const pushTitle = "⚠️ दखल घ्या (Alert)";
        const [orgs] = await db.query(`SELECT name, slug FROM organizations WHERE organization_id = ?`, [organization_id]);
        if (orgs.length === 0) return res.status(404).json({ error: "Organization not found" });
        
        const orgName = orgs[0].name;
        const orgSlug = orgs[0].slug;
        const pushUrl = project_id ? `/project?org=${orgSlug}` : `/org?org=${orgSlug}`;
        const pushBody = `${orgName} च्या बँक खात्यातून ₹${amount} कट (वजा) झाले आहेत, पण त्याची सिस्टीममध्ये नोंद नाही. कारण: पैसे खात्यातून गेले आहेत, पण यासाठी कोणताही खर्च किंवा पावती अपलोड केलेली नाही.`;

        await db.query(`INSERT INTO notification_queue (organization_id, guest_token, title, body, url, status) VALUES (?, 'BROADCAST', ?, ?, ?, 'pending')`, [organization_id, pushTitle, pushBody, pushUrl]);
        res.status(200).json({ success: true, message: "Simulated deduction queued." });
    } catch (error) {
        res.status(500).json({ success: false, error: "Server Error" });
    }
});

module.exports = router;