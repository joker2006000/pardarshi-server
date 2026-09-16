const pool = require('../config/db');

exports.getOrganizationProjects = async (req, res) => {
    try {
        const { orgId } = req.params;

        // Subquery fetches an array of picture URLs directly within the main SQL call
        const [projects] = await pool.query(
            `SELECT op.project_id, op.name, op.description, op.created_at,
                    (SELECT JSON_ARRAYAGG(pp.picture_url) 
                     FROM project_pictures pp 
                     WHERE pp.project_id = op.project_id) AS pictures
             FROM organization_projects op
             WHERE op.organization_id = ?
             ORDER BY op.created_at DESC`,
            [orgId]
        );

        res.status(200).json({ success: true, data: projects });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: "Server Error" });
    }
};

exports.createProject = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        
        const { orgId } = req.params;
        const { name, description } = req.body;

        // 1. Insert Project Details
        const [projectResult] = await connection.query(
            `INSERT INTO organization_projects (organization_id, name, description) 
             VALUES (?, ?, ?)`,
            [orgId, name, description]
        );
        const projectId = projectResult.insertId;

        // 2. Insert Multiple Pictures (If multer-s3 uploaded files)
        if (req.files && req.files.length > 0) {
            const pictureValues = req.files.map((file, index) => [
                projectId, 
                file.location, 
                index // Uses index to populate display_order
            ]);

            await connection.query(
                `INSERT INTO project_pictures (project_id, picture_url, display_order) VALUES ?`,
                [pictureValues]
            );
        }

        await connection.commit();
        res.status(201).json({ success: true, message: "Project and images saved successfully" });
    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.status(500).json({ success: false, error: "Server Error" });
    } finally {
        connection.release();
    }
};

// ==========================================
// NEW: DELETE PROJECT & WIPE TRANSACTIONS
// ==========================================
exports.deleteProject = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const { orgId, projectId } = req.params;

        // 1. Fetch project details to verify ownership and get financial totals & form_id
        const [projects] = await connection.query(
            `SELECT * FROM organization_projects WHERE project_id = ? AND organization_id = ?`,
            [projectId, orgId]
        );

        if (projects.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, error: "Project not found or does not belong to this organization" });
        }

        const project = projects[0];
        const remainingBalance = Number(project.remaining_balance) || (Number(project.total_received) - Number(project.total_expenses));

        // 2. Delete project pictures from database
        await connection.query(`DELETE FROM project_pictures WHERE project_id = ?`, [projectId]);

        // 3. Delete expense documents (proofs) for expenses linked to this project
        await connection.query(
            `DELETE ed FROM expense_documents ed 
             JOIN expenses e ON ed.expense_id = e.expense_id 
             WHERE e.project_id = ?`,
            [projectId]
        );

        // 4. Delete all expenses linked to this project
        await connection.query(`DELETE FROM expenses WHERE project_id = ?`, [projectId]);

        // 5. Delete all contributions linked to this project
        await connection.query(`DELETE FROM contributions WHERE project_id = ?`, [projectId]);

        // 6. Delete associated form if it exists (Cascades to form fields & submissions)
        if (project.form_id) {
            await connection.query(`DELETE FROM forms WHERE form_id = ?`, [project.form_id]);
        }

        // 7. Handle remaining balance transfer / deficit clearance ("By Pardarshi")
        if (remainingBalance > 0) {
            // Positive balance: Record as an organization-level contribution
            await connection.query(
                `INSERT INTO contributions (organization_id, project_id, contributor_name, amount, payment_status, payment_method, notes) 
                 VALUES (?, NULL, ?, ?, 'success', 'online', ?)`,
                [
                    orgId, 
                    "By Pardarshi (Project Transfer)", 
                    remainingBalance, 
                    `Remaining funds transferred from deleted project: ${project.name}`
                ]
            );
        } else if (remainingBalance < 0) {
            // Negative balance (deficit): Record as an organization-level expense
            const deficitAmount = Math.abs(remainingBalance);
            const [orgRows] = await connection.query(`SELECT created_by FROM organizations WHERE organization_id = ?`, [orgId]);
            const createdBy = orgRows[0]?.created_by || req.user?.userId || 1;

            await connection.query(
                `INSERT INTO expenses (organization_id, project_id, title, description, amount, expense_date, category, payment_mode, payment_status, status, created_by) 
                 VALUES (?, NULL, ?, ?, ?, CURDATE(), 'Project Deficit', 'online', 'success', 'paid', ?)`,
                [
                    orgId,
                    "Deficit Covered - By Pardarshi",
                    `Deficit cleared from deleted project: ${project.name}`,
                    deficitAmount,
                    createdBy
                ]
            );
        }

        // 8. Recalculate organization totals to guarantee complete accuracy
        const [calcContr] = await connection.query(
            `SELECT COALESCE(SUM(amount), 0) as total_rec FROM contributions WHERE organization_id = ? AND payment_status = 'success'`,
            [orgId]
        );
        const [calcExp] = await connection.query(
            `SELECT COALESCE(SUM(amount), 0) as total_exp FROM expenses WHERE organization_id = ? AND (payment_status = 'success' OR status = 'paid')`,
            [orgId]
        );

        const newOrgReceived = calcContr[0].total_rec;
        const newOrgExpenses = calcExp[0].total_exp;
        const newOrgBalance = newOrgReceived - newOrgExpenses;

        await connection.query(
            `UPDATE organizations SET total_received = ?, total_expenses = ?, remaining_balance = ? WHERE organization_id = ?`,
            [newOrgReceived, newOrgExpenses, newOrgBalance, orgId]
        );

        // 9. Finally, delete the project record itself
        await connection.query(`DELETE FROM organization_projects WHERE project_id = ?`, [projectId]);

        await connection.commit();
        res.status(200).json({ 
            success: true, 
            message: "Project and all associated transactions, pictures, and forms wiped successfully. Remaining balance adjusted properly under 'By Pardarshi'.",
            adjusted_balance: remainingBalance
        });

    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.status(500).json({ success: false, error: "Server Error" });
    } finally {
        connection.release();
    }
};