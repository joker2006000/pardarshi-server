const db = require('../config/db');

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
// 2. ADD OFFLINE EXPENSE (With Proofs)
// ==========================================
exports.addOfflineExpense = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { organization_id, project_id, title, description, amount, expense_date, category, created_by } = req.body;
        const validProjectId = project_id ? project_id : null;
        
        await connection.beginTransaction();

        // 1. Insert Expense
        const [expenseResult] = await connection.query(`
            INSERT INTO expenses (organization_id, project_id, title, description, amount, expense_date, category, payment_mode, payment_status, status, is_online_payment, created_by, paid_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'offline', 'success', 'paid', FALSE, ?, NOW())
        `, [organization_id, validProjectId, title, description, amount, expense_date, category, created_by]);
        
        const expenseId = expenseResult.insertId;

        // 2. Save AWS S3 Proof Documents
        if (req.files && req.files.length > 0) {
            const documentQueries = req.files.map(file => {
                return connection.query(`INSERT INTO expense_documents (expense_id, file_url, file_name, file_type) VALUES (?, ?, ?, ?)`, 
                [expenseId, file.location, file.originalname, file.mimetype]);
            });
            await Promise.all(documentQueries);
        }

        // 3. Update Organization Math
        await connection.query(`UPDATE organizations SET total_expenses = total_expenses + ?, remaining_balance = remaining_balance - ? WHERE organization_id = ?`, [amount, amount, organization_id]);
        
        // 4. Update Project Math
        if (validProjectId) {
            await connection.query(`UPDATE organization_projects SET total_expenses = total_expenses + ?, remaining_balance = remaining_balance - ? WHERE project_id = ?`, [amount, amount, validProjectId]);
        }

        await connection.commit();
        res.status(200).json({ success: true, message: "Offline expense added successfully." });
    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Add Offline Expense Error:", error);
        res.status(500).json({ error: "Failed to add offline expense." });
    } finally {
        if (connection) connection.release();
    }
};

// ==========================================
// 3. EDIT EXPENSE (Updates Title, Desc, Project & Math)
// ==========================================
exports.editExpense = async (req, res) => {
    const { expense_id } = req.params;
    const connection = await db.getConnection();
    try {
        const { title, description, new_project_id, amount } = req.body;
        const validNewProjectId = new_project_id ? new_project_id : null;

        await connection.beginTransaction();

        // 1. Get current expense data
        const [existing] = await connection.query(`
            SELECT organization_id, amount, project_id, payment_status, is_online_payment 
            FROM expenses WHERE expense_id = ?
        `, [expense_id]);
        
        if (existing.length === 0) throw new Error("Expense not found");
        
        const expense = existing[0];
        const oldProjectId = expense.project_id;
        const oldAmount = parseFloat(expense.amount);
        const newAmount = amount ? parseFloat(amount) : oldAmount;

        // 2. STRICT SECURITY: Block amount changes for online payments
        if (expense.is_online_payment && newAmount !== oldAmount) {
            await connection.rollback();
            return res.status(403).json({ error: "Security Restriction: You cannot edit the amount of a verified online transaction." });
        }

        // 3. Update Database Record
        await connection.query(`
            UPDATE expenses SET title = ?, description = ?, project_id = ?, amount = ? 
            WHERE expense_id = ?
        `, [title, description, validNewProjectId, newAmount, expense_id]);

        // 4. Perfect Math Correction (Only if the expense was already counted as paid)
        if (expense.payment_status === 'paid' || expense.payment_status === 'success') {
            // First, completely reverse the old transaction math...
            await connection.query(`UPDATE organizations SET total_expenses = total_expenses - ?, remaining_balance = remaining_balance + ? WHERE organization_id = ?`, [oldAmount, oldAmount, expense.organization_id]);
            if (oldProjectId) {
                await connection.query(`UPDATE organization_projects SET total_expenses = total_expenses - ?, remaining_balance = remaining_balance + ? WHERE project_id = ?`, [oldAmount, oldAmount, oldProjectId]);
            }

            // ...Then, apply the new transaction math.
            await connection.query(`UPDATE organizations SET total_expenses = total_expenses + ?, remaining_balance = remaining_balance - ? WHERE organization_id = ?`, [newAmount, newAmount, expense.organization_id]);
            if (validNewProjectId) {
                await connection.query(`UPDATE organization_projects SET total_expenses = total_expenses + ?, remaining_balance = remaining_balance - ? WHERE project_id = ?`, [newAmount, newAmount, validNewProjectId]);
            }
        }

        // 5. Add new AWS S3 Proof Documents (if any uploaded during edit)
        if (req.files && req.files.length > 0) {
            const documentQueries = req.files.map(file => {
                return connection.query(`INSERT INTO expense_documents (expense_id, file_url, file_name, file_type) VALUES (?, ?, ?, ?)`, 
                [expense_id, file.location, file.originalname, file.mimetype]);
            });
            await Promise.all(documentQueries);
        }

        await connection.commit();
        res.status(200).json({ success: true, message: "Expense updated successfully." });
    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Edit Expense Error:", error);
        res.status(500).json({ error: "Failed to update expense." });
    } finally {
        if (connection) connection.release();
    }
};