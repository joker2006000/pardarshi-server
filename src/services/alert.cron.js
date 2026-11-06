const cron = require('node-cron');
const db = require('../config/db');

const anomalyTranslations = {
    'PRICE_MISMATCH': "नोंदवलेली खर्चाची रक्कम आणि पावतीवरील एकूण रक्कम जुळत नाही.",
    'CONTEXT_MISMATCH': "पावतीवर खरेदी केलेल्या वस्तू आणि खर्चाचे दिलेले कारण एकमेकांशी विसंगत आहेत.",
    'FORGERY_DETECTED': "अपलोड केलेल्या पावतीमध्ये डिजिटल छेडछाड (Editing) झाल्याचा संशय आहे.",
    'CALCULATION_ERROR': "पावतीवरील एकूण रक्कम आणि त्यावरील वस्तूंच्या किमतीची बेरीज चुकीची आहे.",
    'DUPLICATE_RECEIPT': "ही पावती यापूर्वीच दुसऱ्या खर्चासाठी वापरण्यात आली आहे.",
    'MISSING_DELIVERY_PHOTO': "सामान मिळाल्याचा पुरावा जोडलेला नाही.",
    'DELIVERY_PHOTO_MISMATCH': "पावतीवर लिहिलेले सामान आणि डिलिव्हरी नंतर काढलेल्या फोटोमधील सामान वेगळे दिसत आहे.",
    'FAKE_VENDOR_DETECTED': "पावतीवरील दुकान/संस्था गुगल मॅप्स (Google Maps) वर अस्तित्वात नसल्याचे निदर्शनास आले आहे.",
    'VENDOR_ADDRESS_MISMATCH': "पावतीवरील दुकानाचा पत्ता आणि गुगल मॅप्स (Google Maps) वरील अधिकृत पत्ता जुळत नाही."
};

cron.schedule('*/5 * * * * *', async () => {
    const connection = await db.getConnection();
    try {
        const [anomalies] = await connection.query(`
            SELECT 
                ad.anomaly_id, ad.anomaly_text, ad.organization_id, ad.project_id,
                o.name AS organization_name, o.slug AS org_slug,
                COALESCE(op.name, 'General Account') AS project_name,
                e.title AS expense_title, e.amount AS expense_amount
            FROM anomaly_detections ad
            JOIN organizations o ON ad.organization_id = o.organization_id
            LEFT JOIN organization_projects op ON ad.project_id = op.project_id
            JOIN expenses e ON ad.expense_id = e.expense_id
            WHERE ad.alert_message_status = 'pending' 
            AND ad.created_at <= NOW() - INTERVAL 15 SECOND
        `);

        for (const anomaly of anomalies) {
            const marathiReason = anomalyTranslations[anomaly.anomaly_text] || "अज्ञात त्रुटी.";
            
            const pushTitle = "⚠️ दखल घ्या (Alert)";
            const pushBody = `${anomaly.organization_name} च्या '${anomaly.project_name}' मधील ₹${anomaly.expense_amount} च्या '${anomaly.expense_title}' खर्चामध्ये त्रुटी आढळली आहे. कारण: ${marathiReason}`;
            const pushUrl = anomaly.project_id ? `/project?org=${anomaly.org_slug}` : `/org?org=${anomaly.org_slug}`;

            await connection.query(
                `INSERT INTO notification_queue (organization_id, guest_token, title, body, url, status) 
                 VALUES (?, 'BROADCAST', ?, ?, ?, 'pending')`,
                [anomaly.organization_id, pushTitle, pushBody, pushUrl]
            );

            await connection.query(`UPDATE anomaly_detections SET alert_message_status = 'sent' WHERE anomaly_id = ?`, [anomaly.anomaly_id]);
        }
    } catch (error) {
        console.error("Alert Cron Job Error:", error);
    } finally {
        connection.release();
    }
});