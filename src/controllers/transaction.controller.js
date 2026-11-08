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
        
        if (project_id) {
            const [projData] = await db.query(`SELECT total_received, total_expenses, remaining_balance FROM organization_projects WHERE project_id = ?`, [project_id]);
            if (projData.length > 0) totals = projData[0];
        } else {
            const [orgData] = await db.query(`SELECT total_received, total_expenses, remaining_balance FROM organizations WHERE organization_id = ?`, [organization_id]);
            if (orgData.length > 0) totals = orgData[0];
        }

        const contDateSql = getDateFilterSQL(date_filter, 'created_at');
        const [contributions] = await db.query(`
            SELECT * FROM contributions 
            WHERE organization_id = ? ${contProjectFilter} ${contDateSql}
            ORDER BY created_at DESC
        `, [organization_id]);

        // Updated Query: Combines Invoices & Delivery Pics into a single 'proofs' array
        const expDateSql = getDateFilterSQL(date_filter, 'e.expense_date');
        const [expenses] = await db.query(`
            SELECT e.*, 
                   u.name AS creator_name,
                   u.email AS creator_email,
                   u.profile_pic_url AS creator_picture,
                   (
                       SELECT JSON_ARRAYAGG(JSON_OBJECT(
                           'id', id, 
                           'url', file_url, 
                           'name', file_name, 
                           'proof_type', proof_type
                       ))
                       FROM (
                           SELECT document_id AS id, file_url, file_name, 'invoice' AS proof_type, expense_id 
                           FROM expense_documents 
                           UNION ALL 
                           SELECT delivery_id AS id, file_url, file_name, 'delivery' AS proof_type, expense_id 
                           FROM delivery_proofs
                       ) combined_proofs
                       WHERE combined_proofs.expense_id = e.expense_id
                   ) as proofs
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
                verificationService.runDocumentVerificatio({
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
// 3. EDIT EXPENSE (Strictly for Text & Math Updates)   //  No need to handel for front end for now 
// ==========================================
exports.editExpense = async (req, res) => {
    const { expense_id } = req.params;
    const connection = await db.getConnection();
    try {
        // Only handles text and numbers now. No req.files here.
        const { title, description, new_project_id, amount } = req.body;
        const validNewProjectId = new_project_id ? new_project_id : null;

        await connection.beginTransaction();

        const [existing] = await connection.query(
            `SELECT organization_id, amount, project_id, payment_status, is_online_payment 
             FROM expenses WHERE expense_id = ?`, 
            [expense_id]
        );
        if (existing.length === 0) throw new Error("Expense not found");
        
        const expense = existing[0];
        const oldProjectId = expense.project_id;
        const oldAmount = parseFloat(expense.amount);
        const newAmount = amount ? parseFloat(amount) : oldAmount;

        // Security check for online payments[cite: 11]
        if (expense.is_online_payment && newAmount !== oldAmount) {
            await connection.rollback();
            return res.status(403).json({ error: "Cannot edit amount of a verified online transaction." });
        }

        // 1. Update text data in the database[cite: 11]
        await connection.query(
            `UPDATE expenses SET title = ?, description = ?, project_id = ?, amount = ? WHERE expense_id = ?`, 
            [title, description, validNewProjectId, newAmount, expense_id]
        );

        // 2. Complex Math Correction (Reversing old, applying new)[cite: 11]
        if (expense.payment_status === 'paid' || expense.payment_status === 'success') {
            // Reverse old amounts
            await connection.query(`UPDATE organizations SET total_expenses = total_expenses - ?, remaining_balance = remaining_balance + ? WHERE organization_id = ?`, [oldAmount, oldAmount, expense.organization_id]);
            if (oldProjectId) await connection.query(`UPDATE organization_projects SET total_expenses = total_expenses - ?, remaining_balance = remaining_balance + ? WHERE project_id = ?`, [oldAmount, oldAmount, oldProjectId]);

            // Apply new amounts
            await connection.query(`UPDATE organizations SET total_expenses = total_expenses + ?, remaining_balance = remaining_balance - ? WHERE organization_id = ?`, [newAmount, newAmount, expense.organization_id]);
            if (validNewProjectId) await connection.query(`UPDATE organization_projects SET total_expenses = total_expenses + ?, remaining_balance = remaining_balance - ? WHERE project_id = ?`, [newAmount, newAmount, validNewProjectId]);
        }

        await connection.commit();
        res.status(200).json({ success: true, message: "Expense details updated successfully." });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Edit Expense Error:", error);
        res.status(500).json({ error: "Failed to update expense details." });
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
// 6. UNIFIED MASTER FUNCTION: MANAGE EXPENSE FILES
// Handles Multiple Uploads & Specific Deletions 
// ==========================================
exports.manageExpenseFile = async (req, res) => {
    const { expense_id } = req.params;
    const { action, proof_type, file_id } = req.body; 

    const connection = await db.getConnection();
    try {
        const [expenseRows] = await connection.query(
            `SELECT organization_id, project_id, amount, title, description, created_by 
             FROM expenses WHERE expense_id = ?`, 
            [expense_id]
        );
        
        if (expenseRows.length === 0) throw new Error("Expense not found");
        const exp = expenseRows[0];

        await connection.beginTransaction();

        // ---------------------------------------
        // DELETE FILE
        // ---------------------------------------
        if (action === 'delete') {
            if (!file_id) throw new Error("File ID is required for deletion");

            if (proof_type === 'delivery') {
                await connection.query(`DELETE FROM delivery_proofs WHERE delivery_id = ?`, [file_id]);
            } else {
                await connection.query(
                    `UPDATE anomaly_detections SET verification_status = 'verified', alert_message_status = 'sent' 
                     WHERE proof_url = (SELECT file_url FROM expense_documents WHERE document_id = ?)`, 
                    [file_id]
                );
                await connection.query(`DELETE FROM expense_documents WHERE document_id = ?`, [file_id]);
            }
            
            await connection.commit();
            return res.status(200).json({ success: true, message: `${proof_type} picture deleted successfully.` });
        }

        // ---------------------------------------
        // UPLOAD MULTIPLE FILES
        // ---------------------------------------
        if (action === 'upload') {
            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: "No pictures uploaded." });
            }
            
            const documentQueries = req.files.map(file => {
                if (proof_type === 'delivery') {
                    return connection.query(
                        `INSERT INTO delivery_proofs (expense_id, file_url, file_name, file_type) VALUES (?, ?, ?, ?)`, 
                        [expense_id, file.location, file.originalname, file.mimetype]
                    );
                } else {
                    return connection.query(
                        `INSERT INTO expense_documents (expense_id, file_url, file_name, file_type) VALUES (?, ?, ?, ?)`, 
                        [expense_id, file.location, file.originalname, file.mimetype]
                    );
                }
            });
            
            await Promise.all(documentQueries);
            await connection.commit();
            res.status(200).json({ success: true, message: `Successfully uploaded ${req.files.length} ${proof_type} picture(s).` });

            const primaryFile = req.files[0];
            
            if (proof_type === 'delivery') {
                /*
                setImmediate(() => {
                    verificationService.runDeliveryVerification({ ... });
                });
                */
            } else {
                setImmediate(() => {
                    verificationService.runDocumentVerification({
                        expenseId: expense_id, organizationId: exp.organization_id, projectId: exp.project_id,
                        primaryFile: primaryFile, claimedAmount: exp.amount, title: exp.title, description: exp.description, createdBy: exp.created_by
                    });
                });
            }
        }
    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Manage Expense File Error:", error);
        res.status(500).json({ error: "Failed to process picture request." });
    } finally {
        if (connection) connection.release();
    }
};

// ==========================================
// 7. CREATE ANNOUNCEMENT (With Project & Expense Detail Broadcasts)
// ==========================================
exports.createAnnouncement = async (req, res) => {
    const { organization_id } = req.params;
    const connection = await db.getConnection();
    
    try {
        const { text_information, project_id, expense_id, verified_proof_id, status } = req.body;
        const validProjectId = project_id ? project_id : null;
        const validExpenseId = expense_id ? expense_id : null;
        const validVerifiedProofId = verified_proof_id ? verified_proof_id : null;
        
        // Default to 'show'
        const displayStatus = status === 'hide' ? 'hide' : 'show';
        
        // Fetch created_by from the authenticated user
        const created_by = req.user ? req.user.user_id : 1; 

        if (!text_information) {
            return res.status(400).json({ error: "Announcement text is required." });
        }

        // Start transaction
        await connection.beginTransaction();

        // 1. Insert the Announcement
        await connection.query(`
            INSERT INTO announcements (organization_id, project_id, expense_id, verified_proof_id, text_information, status, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [organization_id, validProjectId, validExpenseId, validVerifiedProofId, text_information, displayStatus, created_by]);

        // 2. Fetch routing and context details for the Push Notification
        if (displayStatus === 'show') {
            const [orgRows] = await connection.query(`SELECT name, slug FROM organizations WHERE organization_id = ?`, [organization_id]);
            
            if (orgRows.length > 0) {
                const orgName = orgRows[0].name;
                const orgSlug = orgRows[0].slug;
                
                let pushUrl = `/org/${orgSlug}`;
                let projectName = null;
                let expenseTitle = null;
                let expenseAmount = null;

                // Fetch Project details
                if (validProjectId) {
                    const [projRows] = await connection.query(`SELECT name, slug FROM organization_projects WHERE project_id = ?`, [validProjectId]);
                    if (projRows.length > 0) {
                        pushUrl = `/org/${orgSlug}/project/${projRows[0].slug}`;
                        projectName = projRows[0].name;
                    }
                }

                // Fetch Expense details
                if (validExpenseId) {
                    const [expRows] = await connection.query(`SELECT title, amount FROM expenses WHERE expense_id = ?`, [validExpenseId]);
                    if (expRows.length > 0) {
                        expenseTitle = expRows[0].title;
                        expenseAmount = expRows[0].amount;
                    }
                }

                // Dynamically build the Marathi notification body based on available context
                let contextPrefix = "";
                if (projectName && expenseTitle) {
                    contextPrefix = `प्रोजेक्ट '${projectName}' मधील खर्च '${expenseTitle}' (₹${expenseAmount}) बाबत: `;
                } else if (projectName) {
                    contextPrefix = `प्रोजेक्ट '${projectName}' बाबत: `;
                } else if (expenseTitle) {
                    contextPrefix = `खर्च '${expenseTitle}' (₹${expenseAmount}) बाबत: `;
                }

                const pushBody = contextPrefix + text_information;
                const pushTitle = `नवीन सूचना - ${orgName}`;

                // 3. Queue the Broadcast Notification
                await connection.query(
                    `INSERT INTO notification_queue (organization_id, guest_token, title, body, url, status) 
                     VALUES (?, 'BROADCAST', ?, ?, ?, 'pending')`,
                    [organization_id, pushTitle, pushBody, pushUrl]
                );
            }
        }

        await connection.commit();
        res.status(201).json({ success: true, message: "Announcement created and users notified successfully." });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Create Announcement Error:", error);
        res.status(500).json({ error: "Failed to create announcement." });
    } finally {
        if (connection) connection.release();
    }
};
// ==========================================
// 8. GET ALL ANNOUNCEMENTS (For Org Dashboard)
// ==========================================
exports.getAnnouncements = async (req, res) => {
    const { organization_id } = req.params;
    
    try {
        const [announcements] = await db.query(`
            SELECT a.announcement_id, a.text_information, a.status, a.created_at,
                   p.project_id, p.name AS project_name,
                   e.expense_id, e.title AS expense_title, e.amount AS expense_amount,
                   u.name AS creator_name, u.profile_pic_url AS creator_picture
            FROM announcements a
            LEFT JOIN organization_projects p ON a.project_id = p.project_id
            LEFT JOIN expenses e ON a.expense_id = e.expense_id
            LEFT JOIN users u ON a.created_by = u.user_id
            WHERE a.organization_id = ?
            ORDER BY a.created_at DESC
        `, [organization_id]);

        res.status(200).json({ success: true, data: announcements });
    } catch (error) {
        console.error("Fetch Announcements Error:", error);
        res.status(500).json({ error: "Failed to fetch announcements." });
    }
};

// ==========================================
// 9. DELETE ANNOUNCEMENT
// ==========================================
exports.deleteAnnouncement = async (req, res) => {
    const { announcement_id } = req.params;
    
    try {
        await db.query(`DELETE FROM announcements WHERE announcement_id = ?`, [announcement_id]);
        res.status(200).json({ success: true, message: "Announcement deleted successfully." });
    } catch (error) {
        console.error("Delete Announcement Error:", error);
        res.status(500).json({ error: "Failed to delete announcement." });
    }
};