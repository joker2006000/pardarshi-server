const db = require('../config/db');
const documentProcessor = require('../utils/documentProcessor');
const aiService = require('./ai.service');

exports.runDocumentVerification = async ({ 
    expenseId, organizationId, projectId, primaryFile, 
    claimedAmount, title, description, createdBy 
}) => {
    const asyncDb = await db.getConnection();
    try {
        // 1. Extract file metadata, hashes, and EXIF GPS/Forgery data
        const docData = await documentProcessor.processDocument(primaryFile.key);
        
        // 2. Duplicate Receipt Check
        const [dupCheck] = await asyncDb.query(`SELECT document_id FROM expense_documents WHERE file_hash = ?`, [docData.fileHash]);
        if (dupCheck.length > 0) {
            await asyncDb.query(
                `INSERT INTO anomaly_detections (organization_id, project_id, expense_id, proof_url, anomaly_text, verification_status, alert_message_status) 
                 VALUES (?, ?, ?, ?, 'DUPLICATE_RECEIPT', 'pending', 'pending')`, 
                [organizationId, projectId, expenseId, primaryFile.location]
            );
            return; // Stop processing if it's an exact duplicate file
        }

        // 3. Update the document record with the extracted hash and GPS coordinates
        await asyncDb.query(
            `UPDATE expense_documents SET file_hash = ?, delivery_latitude = ?, delivery_longitude = ? WHERE file_url = ?`, 
            [docData.fileHash, docData.latitude, docData.longitude, primaryFile.location]
        );

        // 4. Digital Forgery Check
        if (docData.isForged) {
            await asyncDb.query(
                `INSERT INTO anomaly_detections (organization_id, project_id, expense_id, proof_url, anomaly_text, verification_status, alert_message_status) 
                 VALUES (?, ?, ?, ?, 'FORGERY_DETECTED', 'pending', 'pending')`, 
                [organizationId, projectId, expenseId, primaryFile.location]
            );
        }

        // 5. Run the Gemini AI Audit
        const aiResult = await aiService.analyzeReceipt(docData.buffer, primaryFile.mimetype, title, description);
        
        const parsedClaimedAmount = parseFloat(claimedAmount);
        const extractedAmount = parseFloat(aiResult.total_amount || 0);

        // Store the COMPLETE AI JSON output into a variable for the database
        const fullProofDetails = JSON.stringify(aiResult);
        let hasAnomaly = false;

        // 6. INDEPENDENT ANOMALY CHECKS (Catches multiple errors simultaneously)
        
        if (Math.abs(parsedClaimedAmount - extractedAmount) > 1.0) {
             hasAnomaly = true;
             await asyncDb.query(
                 `INSERT INTO anomaly_detections (organization_id, project_id, expense_id, proof_url, anomaly_text, proof_details, verification_status, alert_message_status) 
                  VALUES (?, ?, ?, ?, 'PRICE_MISMATCH', ?, 'pending', 'pending')`, 
                 [organizationId, projectId, expenseId, primaryFile.location, fullProofDetails]
             );
        }

        if (aiResult.context_match === false) {
             hasAnomaly = true;
             await asyncDb.query(
                 `INSERT INTO anomaly_detections (organization_id, project_id, expense_id, proof_url, anomaly_text, proof_details, verification_status, alert_message_status) 
                  VALUES (?, ?, ?, ?, 'CONTEXT_MISMATCH', ?, 'pending', 'pending')`, 
                 [organizationId, projectId, expenseId, primaryFile.location, fullProofDetails]
             );
        }

        if (aiResult.maps_vendor_found === false) {
            hasAnomaly = true;
            await asyncDb.query(
                `INSERT INTO anomaly_detections (organization_id, project_id, expense_id, proof_url, anomaly_text, proof_details, verification_status, alert_message_status) 
                 VALUES (?, ?, ?, ?, 'FAKE_VENDOR_DETECTED', ?, 'pending', 'pending')`, 
                [organizationId, projectId, expenseId, primaryFile.location, fullProofDetails]
            );
        }

        if (aiResult.maps_address_match === false) {
            hasAnomaly = true;
            await asyncDb.query(
                `INSERT INTO anomaly_detections (organization_id, project_id, expense_id, proof_url, anomaly_text, proof_details, verification_status, alert_message_status) 
                 VALUES (?, ?, ?, ?, 'VENDOR_ADDRESS_MISMATCH', ?, 'pending', 'pending')`, 
                [organizationId, projectId, expenseId, primaryFile.location, fullProofDetails]
            );
        }

        // 7. STRICT VERIFICATION RULE
        // Only approve and store in verified_proofs_data if there are 0 anomalies and 0 forgery
        if (!hasAnomaly && !docData.isForged) {
             await asyncDb.query(`UPDATE expenses SET status = 'approved' WHERE expense_id = ?`, [expenseId]);
             
             await asyncDb.query(
                 `INSERT INTO verified_proofs_data (organization_id, project_id, expense_id, document_id, information) 
                  VALUES (?, ?, ?, (SELECT document_id FROM expense_documents WHERE file_url = ? LIMIT 1), ?)`, 
                 [organizationId, projectId, expenseId, primaryFile.location, fullProofDetails]
             );
        }

    } catch (err) {
        console.error("Verification Service Error:", err);
    } finally {
        asyncDb.release();
    }
};