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
        const [groupedAnomalies] = await connection.query(`
            SELECT 
                ad.expense_id, ad.organization_id, ad.project_id,
                o.name AS organization_name, o.slug AS org_slug,
                COALESCE(op.name, 'General Account') AS project_name,
                e.title AS expense_title, e.amount AS expense_amount,
                GROUP_CONCAT(ad.anomaly_id) AS anomaly_ids,
                GROUP_CONCAT(ad.anomaly_text) AS anomaly_texts
            FROM anomaly_detections ad
            JOIN organizations o ON ad.organization_id = o.organization_id
            LEFT JOIN organization_projects op ON ad.project_id = op.project_id
            JOIN expenses e ON ad.expense_id = e.expense_id
            WHERE ad.alert_message_status = 'pending' 
            AND ad.created_at <= NOW() - INTERVAL 15 SECOND
            GROUP BY ad.expense_id, ad.organization_id, ad.project_id, o.name, o.slug, op.name, e.title, e.amount
        `);

        for (const alertGroup of groupedAnomalies) {
            const anomalyTypes = [...new Set(alertGroup.anomaly_texts.split(','))]; 
            const anomalyIds = alertGroup.anomaly_ids.split(',');
            
            // Format into a numbered list separated by newlines
            const marathiReasons = anomalyTypes
                .map((type, index) => `${index + 1}. ${anomalyTranslations[type] || "अज्ञात त्रुटी."}`)
                .join("\n");
            
            const pushTitle = "⚠️ दखल घ्या (Alert)";
            // Add a newline before the list starts
            const pushBody = `${alertGroup.organization_name} च्या '${alertGroup.project_name}' मधील ₹${alertGroup.expense_amount} च्या '${alertGroup.expense_title}' खर्चामध्ये खालील त्रुटी आढळल्या आहेत:\n${marathiReasons}`;
            const pushUrl = alertGroup.project_id ? `/project?org=${alertGroup.org_slug}` : `/org?org=${alertGroup.org_slug}`;

            await connection.query(
                `INSERT INTO notification_queue (organization_id, guest_token, title, body, url, status) 
                 VALUES (?, 'BROADCAST', ?, ?, ?, 'pending')`,
                [alertGroup.organization_id, pushTitle, pushBody, pushUrl]
            );

            await connection.query(
                `UPDATE anomaly_detections SET alert_message_status = 'sent' WHERE anomaly_id IN (?)`, 
                [anomalyIds]
            );
        }
    } catch (error) {
        console.error("Alert Cron Job Error:", error);
    } finally {
        connection.release();
    }
});