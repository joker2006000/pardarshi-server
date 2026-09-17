const db = require('../config/db');

// ==========================================
// 1. GET PUBLIC ORGANIZATION PAGE
// ==========================================
exports.getPublicOrganization = async (req, res) => {
    try {
        const { orgSlug } = req.params;

        // Fetch Organization Details
        const [orgRows] = await db.query(
            `SELECT organization_id, name, slug, logo_url, profile_pic_url, description, 
                    category, type, email, website_url, city, district, state, established_year,
                    total_received, total_expenses, remaining_balance
             FROM organizations 
             WHERE slug = ? AND status = 'active'`,
            [orgSlug]
        );

        if (orgRows.length === 0) {
            return res.status(404).json({ success: false, message: "Organization not found." });
        }

        const org = orgRows[0];

        // Fetch Organization Members (Name, Pic, Role)
        const [members] = await db.query(
            `SELECT u.name, u.profile_pic_url, om.role 
             FROM organization_members om
             JOIN users u ON om.user_id = u.user_id
             WHERE om.organization_id = ? AND om.status = 'active'
             ORDER BY 
                CASE om.role 
                    WHEN 'owner' THEN 1 
                    WHEN 'admin' THEN 2 
                    WHEN 'editor' THEN 3 
                    ELSE 4 
                END, om.joined_at ASC`,
            [org.organization_id]
        );

        // Fetch Organization Projects
        const [projects] = await db.query(
            `SELECT project_id, name, slug, description, picture_url, 
                    total_received, total_expenses, remaining_balance, created_at
             FROM organization_projects 
             WHERE organization_id = ?
             ORDER BY created_at DESC`,
            [org.organization_id]
        );

        res.status(200).json({
            success: true,
            data: {
                organization: org,
                members: members,
                projects: projects
            }
        });
    } catch (error) {
        console.error("Public Org Error:", error);
        res.status(500).json({ success: false, error: "Server Error" });
    }
};

// ==========================================
// 2. GET PUBLIC PROJECT TRANSACTIONS PAGE
// ==========================================
exports.getPublicProjectTransactions = async (req, res) => {
    try {
        const { orgSlug, projectSlug } = req.params;

        // 1. Validate Slugs & Fetch Project Details
        const [projectRows] = await db.query(
            `SELECT p.project_id, p.name, p.slug, p.description, p.picture_url, 
                    p.total_received, p.total_expenses, p.remaining_balance, 
                    o.organization_id, o.name AS organization_name
             FROM organization_projects p
             JOIN organizations o ON p.organization_id = o.organization_id
             WHERE o.slug = ? AND p.slug = ? AND o.status = 'active'`,
            [orgSlug, projectSlug]
        );

        if (projectRows.length === 0) {
            return res.status(404).json({ success: false, message: "Project or Organization not found." });
        }

        const project = projectRows[0];
        const projectId = project.project_id;

        // 2. Fetch Contributions (Includes Notes, Dates, and Amounts)
        const [contributions] = await db.query(
            `SELECT contributor_name, amount, payment_method, payment_status, notes, 
                    created_at, updated_at
             FROM contributions 
             WHERE project_id = ? AND payment_status = 'success'
             ORDER BY created_at DESC`,
            [projectId]
        );

        // 3. Fetch Expenses (Includes Creator Details & Proof Documents)
        const [expenses] = await db.query(
            `SELECT e.expense_id, e.title, e.description, e.amount, e.expense_date, 
                    e.category, e.payment_mode, e.status, e.created_at, e.updated_at,
                    u.name AS creator_name,
                    u.profile_pic_url AS creator_picture,
                    (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', d.document_id, 'url', d.file_url, 'name', d.file_name)) 
                     FROM expense_documents d 
                     WHERE d.expense_id = e.expense_id) AS proofs
             FROM expenses e
             LEFT JOIN users u ON e.created_by = u.user_id
             WHERE e.project_id = ? AND e.status IN ('approved', 'paid')
             ORDER BY e.expense_date DESC, e.created_at DESC`,
            [projectId]
        );

        res.status(200).json({
            success: true,
            data: {
                project: project,
                contributions: contributions,
                expenses: expenses.map(exp => ({
                    ...exp,
                    // Parse JSON proofs safely into a frontend array
                    proofs: typeof exp.proofs === 'string' ? JSON.parse(exp.proofs) : (exp.proofs || [])
                }))
            }
        });
    } catch (error) {
        console.error("Public Project Error:", error);
        res.status(500).json({ success: false, error: "Server Error" });
    }
};