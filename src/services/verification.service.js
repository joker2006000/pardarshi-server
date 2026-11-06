const db = require('../config/db');
const documentProcessor = require('../utils/documentProcessor');
const aiService = require('./ai.service');

exports.runDocumentVerification = async ({ 
    expenseId, organizationId, projectId, primaryFile, 
    claimedAmount, title, description, createdBy 
}) => {
    const asyncDb = await db.getConnection();
    try {
        const docData = await documentProcessor.processDocument(primaryFile.key);
        
        const [dupCheck] = await asyncDb.query(`SELECT document_id FROM expense_documents WHERE file_hash = ?`, [docData.fileHash]);
        if (dupCheck.length > 0) {
            await asyncDb.query(
                `INSERT INTO anomaly_detections (organization_id, project_id, expense_id, proof_url, anomaly_text, verification_status, alert_message_status) 
                 VALUES (?, ?, ?, ?, 'DUPLICATE_RECEIPT', 'pending', 'pending')`, 
                [organizationId, projectId, expenseId, primaryFile.location]
            );
            return; 
        }

        await asyncDb.query(
            `UPDATE expense_documents SET file_hash = ?, delivery_latitude = ?, delivery_longitude = ? WHERE file_url = ?`, 
            [docData.fileHash, docData.latitude, docData.longitude, primaryFile.location]
        );

        if (docData.isForged) {
            await asyncDb.query(
                `INSERT INTO anomaly_detections (organization_id, project_id, expense_id, proof_url, anomaly_text, verification_status, alert_message_status) 
                 VALUES (?, ?, ?, ?, 'FORGERY_DETECTED', 'pending', 'pending')`, 
                [organizationId, projectId, expenseId, primaryFile.location]
            );
        }

        const aiResult = await aiService.analyzeReceipt(docData.buffer, primaryFile.mimetype, title, description);
        
        await asyncDb.query(
            `INSERT INTO verified_proofs_data (organization_id, project_id, expense_id, document_id, information) 
             VALUES (?, ?, ?, (SELECT document_id FROM expense_documents WHERE file_url = ? LIMIT 1), ?)`, 
            [organizationId, projectId, expenseId, primaryFile.location, JSON.stringify(aiResult)]
        );

        const parsedClaimedAmount = parseFloat(claimedAmount);
        const extractedAmount = parseFloat(aiResult.total_amount || 0);
        
        if (Math.abs(parsedClaimedAmount - extractedAmount) > 1.0) {
             await asyncDb.query(
                 `INSERT INTO anomaly_detections (organization_id, project_id, expense_id, proof_url, anomaly_text, proof_details, verification_status, alert_message_status) 
                  VALUES (?, ?, ?, ?, 'PRICE_MISMATCH', ?, 'pending', 'pending')`, 
                 [organizationId, projectId, expenseId, primaryFile.location, JSON.stringify({ claimed: parsedClaimedAmount, receipt_total: extractedAmount })]
             );
        } else if (aiResult.context_match === false) {
             await asyncDb.query(
                 `INSERT INTO anomaly_detections (organization_id, project_id, expense_id, proof_url, anomaly_text, proof_details, verification_status, alert_message_status) 
                  VALUES (?, ?, ?, ?, 'CONTEXT_MISMATCH', ?, 'pending', 'pending')`, 
                 [organizationId, projectId, expenseId, primaryFile.location, JSON.stringify({ reason: aiResult.anomaly_reason })]
             );
        } else if (aiResult.maps_vendor_found === false) {
            await asyncDb.query(
                `INSERT INTO anomaly_detections (organization_id, project_id, expense_id, proof_url, anomaly_text, proof_details, verification_status, alert_message_status) 
                 VALUES (?, ?, ?, ?, 'FAKE_VENDOR_DETECTED', ?, 'pending', 'pending')`, 
                [organizationId, projectId, expenseId, primaryFile.location, JSON.stringify({ reason: "Vendor shop could not be verified on Google Maps." })]
            );
        } else if (aiResult.maps_address_match === false) {
            await asyncDb.query(
                `INSERT INTO anomaly_detections (organization_id, project_id, expense_id, proof_url, anomaly_text, proof_details, verification_status, alert_message_status) 
                 VALUES (?, ?, ?, ?, 'VENDOR_ADDRESS_MISMATCH', ?, 'pending', 'pending')`, 
                [organizationId, projectId, expenseId, primaryFile.location, JSON.stringify({ reason: "Receipt address does not match the official Google Maps location." })]
            );
        } else if (!docData.isForged) {
             await asyncDb.query(`UPDATE expenses SET status = 'approved' WHERE expense_id = ?`, [expenseId]);
             await asyncDb.query(`
                INSERT INTO announcements (organization_id, project_id, expense_id, verified_proof_id, text_information, status, created_by) 
                VALUES (?, ?, ?, (SELECT verified_proof_id FROM verified_proofs_data WHERE expense_id = ? ORDER BY created_at DESC LIMIT 1), 'Automated Verification Completed', 'show', ?)
             `, [organizationId, projectId, expenseId, expenseId, createdBy]);
        }

    } catch (err) {
        console.error("Verification Service Error:", err);
    } finally {
        asyncDb.release();
    }
};