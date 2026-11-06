const db = require('../config/db');
const verificationService = require('../services/verification.service'); // <-- ADD THIS IMPORT

// Helper function to generate date filter SQL
const getDateFilterSQL = (filterType, dateColumn) => {
    switch (filterType) {
        case 'today': return `AND DATE(${dateColumn}) = CURDATE()`;
        case '7days': return `AND ${dateColumn} >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)`;
        case '1month': return `AND ${dateColumn} >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)`;
        case '6months': return `AND ${dateColumn} >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)`;
        case '1year': return `AND ${dateColumn} >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)`;
        case 'all': default: return ''; // No filter
    }
};

// ==========================================
// 1. GET TRANSACTIONS (Filtered & Grouped)
// ==========================================
exports.getTransactions = async (req, res) => {
    const { organization_id } = req.params;
    const { project_id, date_filter } = req.query;

    try {
        let totals = {};
        let projectFilter = project_id ? `AND e.project_id = ${db.escape(project_id)}` : '';
        let contProjectFilter = project_id ? `AND project_id = ${db.escape(project_id)}` : '';
        
        // 1. Fetch Totals (Either Organization or Project level)
        if (project_id) {
            const [projData] = await db.query(`SELECT total_received, total_expenses, remaining_balance FROM organization_projects WHERE project_id = ?`, [project_id]);
            if (projData.length > 0) totals = projData[0];
        } else {
            const [orgData] = await db.query(`SELECT total_received, total_expenses, remaining_balance FROM organizations WHERE organization_id = ?`, [organization_id]);
            if (orgData.length > 0) totals = orgData[0];
        }

        // 2. Fetch Contributions with dynamic date filter
        const contDateSql = getDateFilterSQL(date_filter, 'created_at');
        const [contributions] = await db.query(`
            SELECT * FROM contributions 
            WHERE organization_id = ? ${contProjectFilter} ${contDateSql}
            ORDER BY created_at DESC
        `, [organization_id]);

        // 3. Fetch Expenses with dynamic date filter AND Creator Details
        const expDateSql = getDateFilterSQL(date_filter, 'e.expense_date');
        const [expenses] = await db.query(`
            SELECT e.*, 
                   u.name AS creator_name,
                   u.email AS creator_email,
                   u.profile_pic_url AS creator_picture,
                   (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', d.document_id, 'url', d.file_url, 'name', d.file_name)) 
                    FROM expense_documents d WHERE d.expense_id = e.expense_id) as proofs
            FROM expenses e
            LEFT JOIN users u ON e.created_by = u.user_id
            WHERE e.organization_id = ? ${projectFilter} ${expDateSql}
            ORDER BY e.expense_date DESC, e.created_at DESC
        `, [organization_id]);

        res.status(200).json({ success: true, totals, contributions, expenses });
    } catch (error) {
        console.error("Fetch Transactions Error:", error);
        res.status(500).json({ error: "Failed to fetch transactions." });
    }
};

// ==========================================
// 2. ADD OFFLINE EXPENSE 
// ==========================================
exports.addOfflineExpense = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { organization_id, project_id, title, description, amount, expense_date, category, created_by } = req.body;
        const validProjectId = project_id ? project_id : null;

        // Strict Insufficient Funds Check[cite: 10]
        if (validProjectId) {
            const [projCheck] = await connection.query(`SELECT remaining_balance FROM organization_projects WHERE project_id = ?`, [validProjectId]);
            if (projCheck.length > 0 && parseFloat(amount) > parseFloat(projCheck[0].remaining_balance)) {
                return res.status(400).json({ error: `Insufficient funds. This project only has ₹${projCheck[0].remaining_balance} remaining.` });
            }
        }

        await connection.beginTransaction();

        // Insert Expense (Default to paid for offline)[cite: 10]
        const [expenseResult] = await connection.query(`
            INSERT INTO expenses (organization_id, project_id, title, description, amount, expense_date, category, payment_mode, payment_status, status, is_online_payment, created_by, paid_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'offline', 'success', 'pending', FALSE, ?, NOW())
        `, [organization_id, validProjectId, title, description, amount, expense_date, category, created_by]);
        
        const expenseId = expenseResult.insertId;

        // Save S3 Documents[cite: 10]
        let uploadedPrimaryFile = null;
        if (req.files && req.files.length > 0) {
            uploadedPrimaryFile = req.files[0];
            const documentQueries = req.files.map(file => {
                return connection.query(`INSERT INTO expense_documents (expense_id, file_url, file_name, file_type) VALUES (?, ?, ?, ?)`, 
                [expenseId, file.location, file.originalname, file.mimetype]);
            });
            await Promise.all(documentQueries);
        }

        // Update Math[cite: 10]
        await connection.query(`UPDATE organizations SET total_expenses = total_expenses + ?, remaining_balance = remaining_balance - ? WHERE organization_id = ?`, [amount, amount, organization_id]);
        if (validProjectId) await connection.query(`UPDATE organization_projects SET total_expenses = total_expenses + ?, remaining_balance = remaining_balance - ? WHERE project_id = ?`, [amount, amount, validProjectId]);

        await connection.commit();
        res.status(200).json({ success: true, message: "Offline expense added. AI Verification pending." });

        // Trigger AI Verification in Background
        if (uploadedPrimaryFile) {
            setImmediate(() => {
                verificationService.runDocumentVerification({
                    expenseId, organizationId: organization_id, projectId: validProjectId,
                    primaryFile: uploadedPrimaryFile, claimedAmount: amount, title, description, createdBy: created_by
                });
            });
        }
    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Add Offline Expense Error:", error);
        res.status(500).json({ error: "Failed to add offline expense." });
    } finally {
        if (connection) connection.release();
    }
};

// ==========================================
// 3. EDIT EXPENSE (Updates Title, Desc, Project, Math & Triggers AI Replacement)
// ==========================================
exports.editExpense = async (req, res) => {
    const { expense_id } = req.params;
    const connection = await db.getConnection();
    try {
        const { title, description, new_project_id, amount } = req.body;
        const validNewProjectId = new_project_id ? new_project_id : null;

        await connection.beginTransaction();

        const [existing] = await connection.query(`SELECT organization_id, amount, project_id, payment_status, is_online_payment FROM expenses WHERE expense_id = ?`, [expense_id]);
        if (existing.length === 0) throw new Error("Expense not found");
        
        const expense = existing[0];
        const oldProjectId = expense.project_id;
        const oldAmount = parseFloat(expense.amount);
        const newAmount = amount ? parseFloat(amount) : oldAmount;

        if (expense.is_online_payment && newAmount !== oldAmount) {
            await connection.rollback();
            return res.status(403).json({ error: "Cannot edit amount of a verified online transaction." });
        }

        await connection.query(`UPDATE expenses SET title = ?, description = ?, project_id = ?, amount = ? WHERE expense_id = ?`, [title, description, validNewProjectId, newAmount, expense_id]);

        if (expense.payment_status === 'paid' || expense.payment_status === 'success') {
            await connection.query(`UPDATE organizations SET total_expenses = total_expenses - ?, remaining_balance = remaining_balance + ? WHERE organization_id = ?`, [oldAmount, oldAmount, expense.organization_id]);
            if (oldProjectId) await connection.query(`UPDATE organization_projects SET total_expenses = total_expenses - ?, remaining_balance = remaining_balance + ? WHERE project_id = ?`, [oldAmount, oldAmount, oldProjectId]);

            await connection.query(`UPDATE organizations SET total_expenses = total_expenses + ?, remaining_balance = remaining_balance - ? WHERE organization_id = ?`, [newAmount, newAmount, expense.organization_id]);
            if (validNewProjectId) await connection.query(`UPDATE organization_projects SET total_expenses = total_expenses + ?, remaining_balance = remaining_balance - ? WHERE project_id = ?`, [newAmount, newAmount, validNewProjectId]);
        }

        // ==========================================
        // 5. REPLACE DOCUMENT & ARCHIVE OLD ANOMALIES (History Preservation)
        // ==========================================
        let uploadedPrimaryFile = null;
        
        if (req.files && req.files.length > 0) {
            uploadedPrimaryFile = req.files[0]; 
            
            // A. ARCHIVE OLD ALERTS (Do NOT delete): 
            // Mark older anomalies as verified/sent. They remain in the database for historical 
            // records but will no longer trigger dashboard alerts or cron job push notifications.
            await connection.query(
                `UPDATE anomaly_detections 
                 SET verification_status = 'verified', alert_message_status = 'sent' 
                 WHERE expense_id = ? AND verification_status = 'pending'`, 
                [expense_id]
            );

            // B. RESET EXPENSE STATUS: Put the expense back into 'pending' mode for the AI
            await connection.query(
                `UPDATE expenses SET status = 'pending' WHERE expense_id = ?`, 
                [expense_id]
            );

            // C. CLEAN OLD DOCUMENTS: Remove the old rejected receipt so the gallery only shows the new one
            await connection.query(
                `DELETE FROM expense_documents WHERE expense_id = ?`, 
                [expense_id]
            );

            // D. INSERT NEW DOCUMENT PROOF
            const documentQueries = req.files.map(file => {
                return connection.query(`INSERT INTO expense_documents (expense_id, file_url, file_name, file_type) VALUES (?, ?, ?, ?)`, 
                [expense_id, file.location, file.originalname, file.mimetype]);
            });
            await Promise.all(documentQueries);
        }

        await connection.commit();
        res.status(200).json({ success: true, message: "Expense updated." });

        // ==========================================
        // 6. ASYNC AI VERIFICATION PIPELINE (Runs on the NEW document)
        // ==========================================
        if (uploadedPrimaryFile) {
            setImmediate(() => {
                verificationService.runDocumentVerification({
                    expenseId: expense_id, 
                    organizationId: expense.organization_id, 
                    projectId: validNewProjectId || oldProjectId,
                    primaryFile: uploadedPrimaryFile, 
                    claimedAmount: newAmount, 
                    title: title, 
                    description: description,
                    createdBy: req.user ? req.user.user_id : 1 
                });
            });
        }
    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Edit Expense Error:", error);
        res.status(500).json({ error: "Failed to update expense." });
    } finally {
        if (connection) connection.release();
    }
};

// ==========================================
// 4. ADD OFFLINE CONTRIBUTION
// ==========================================
exports.addOfflineContribution = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { organization_id, project_id, contributor_name, amount } = req.body;
        const validProjectId = project_id ? project_id : null;
        const parsedAmount = parseFloat(amount);

        await connection.beginTransaction();

        // 1. Insert Contribution
        const [contribResult] = await connection.query(`
            INSERT INTO contributions (organization_id, project_id, contributor_name, amount, payment_status, payment_gateway, payment_method)
            VALUES (?, ?, ?, ?, 'success', 'offline', 'offline')
        `, [organization_id, validProjectId, contributor_name, parsedAmount]);

        // Note: If you eventually create a 'contribution_documents' table, 
        // you would handle req.files here just like in addOfflineExpense.

        // 2. Update Organization Math (Money comes IN)
        await connection.query(`UPDATE organizations SET total_received = total_received + ?, remaining_balance = remaining_balance + ? WHERE organization_id = ?`, [parsedAmount, parsedAmount, organization_id]);
        
        // 3. Update Project Math (Money comes IN)
        if (validProjectId) {
            await connection.query(`UPDATE organization_projects SET total_received = total_received + ?, remaining_balance = remaining_balance + ? WHERE project_id = ?`, [parsedAmount, parsedAmount, validProjectId]);
        }

        await connection.commit();
        res.status(200).json({ success: true, message: "Offline contribution added successfully." });
    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Add Offline Contribution Error:", error);
        res.status(500).json({ error: "Failed to add offline contribution." });
    } finally {
        if (connection) connection.release();
    }
};

// ==========================================
// 5. EDIT CONTRIBUTION (Updates Name, Project & Math)
// ==========================================
exports.editContribution = async (req, res) => {
    const { contribution_id } = req.params;
    const connection = await db.getConnection();
    try {
        const { contributor_name, new_project_id, amount } = req.body;
        const validNewProjectId = new_project_id ? new_project_id : null;

        await connection.beginTransaction();

        // 1. Get current contribution data
        const [existing] = await connection.query(`
            SELECT organization_id, amount, project_id, payment_gateway 
            FROM contributions WHERE contribution_id = ?
        `, [contribution_id]);
        
        if (existing.length === 0) throw new Error("Contribution not found");
        
        const contrib = existing[0];
        const oldProjectId = contrib.project_id;
        const oldAmount = parseFloat(contrib.amount);
        const newAmount = amount ? parseFloat(amount) : oldAmount;

        // 2. STRICT SECURITY: Block amount changes for online payments
        if (contrib.payment_gateway !== 'offline' && newAmount !== oldAmount) {
            await connection.rollback();
            return res.status(403).json({ error: "Security Restriction: You cannot edit the amount of a verified online contribution." });
        }

        // 3. Update Database Record
        await connection.query(`
            UPDATE contributions SET contributor_name = ?, project_id = ?, amount = ? 
            WHERE contribution_id = ?
        `, [contributor_name, validNewProjectId, newAmount, contribution_id]);

        // 4. Perfect Math Correction
        if (newAmount !== oldAmount || oldProjectId !== validNewProjectId) {
            // First, completely reverse the old transaction math...
            await connection.query(`UPDATE organizations SET total_received = total_received - ?, remaining_balance = remaining_balance - ? WHERE organization_id = ?`, [oldAmount, oldAmount, contrib.organization_id]);
            if (oldProjectId) {
                await connection.query(`UPDATE organization_projects SET total_received = total_received - ?, remaining_balance = remaining_balance - ? WHERE project_id = ?`, [oldAmount, oldAmount, oldProjectId]);
            }

            // ...Then, apply the new transaction math.
            await connection.query(`UPDATE organizations SET total_received = total_received + ?, remaining_balance = remaining_balance + ? WHERE organization_id = ?`, [newAmount, newAmount, contrib.organization_id]);
            if (validNewProjectId) {
                await connection.query(`UPDATE organization_projects SET total_received = total_received + ?, remaining_balance = remaining_balance + ? WHERE project_id = ?`, [newAmount, newAmount, validNewProjectId]);
            }
        }

        await connection.commit();
        res.status(200).json({ success: true, message: "Contribution updated successfully." });
    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Edit Contribution Error:", error);
        res.status(500).json({ error: "Failed to update contribution." });
    } finally {
        if (connection) connection.release();
    }
};


// ==========================================
// 6. GET EXPENSE DOCUMENTS (For Gallery Modal)
// ==========================================
exports.getExpenseDocuments = async (req, res) => {
    try {
        const { expense_id } = req.params;
        
        // Fetch all documents associated with this specific expense
        const [documents] = await db.query(
            `SELECT document_id, file_url, file_name, file_type 
             FROM expense_documents 
             WHERE expense_id = ?`, 
            [expense_id]
        );
        
        res.status(200).json({ success: true, data: documents });
    } catch (error) {
        console.error("Fetch Expense Documents Error:", error);
        res.status(500).json({ error: "Failed to fetch documents." });
    }
};