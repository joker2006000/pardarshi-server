const pool = require('../config/db');

// Helper function to generate a URL-safe slug
const generateSlug = (text) => {
    return text.toString().toLowerCase()
        .replace(/\s+/g, '-')           // Replace spaces with -
        .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
        .replace(/\-\-+/g, '-')         // Replace multiple - with single -
        .replace(/^-+/, '')             // Trim - from start of text
        .replace(/-+$/, '');            // Trim - from end of text
};

// ==========================================
// FETCH PROJECTS (WITH SELF-HEALING SLUGS & SMART IMAGES)
// ==========================================
exports.getOrganizationProjects = async (req, res) => {
    try {
        const { orgId } = req.params;

        // Added op.slug to the SELECT query
        const [projects] = await pool.query(
            `SELECT op.project_id, op.name, op.slug, op.description, op.created_at, op.picture_url AS base_pic,
                    f.picture_url AS form_pic,
                    (SELECT JSON_ARRAYAGG(pp.picture_url) 
                     FROM project_pictures pp 
                     WHERE pp.project_id = op.project_id) AS pictures
             FROM organization_projects op
             LEFT JOIN forms f ON op.form_id = f.form_id
             WHERE op.organization_id = ?
             ORDER BY op.created_at DESC`,
            [orgId]
        );

        const projectsNeedingSlugs = [];

        const processedProjects = projects.map(proj => {
            let finalPictures = [];
            let parsedPictures = [];
            try {
                parsedPictures = typeof proj.pictures === 'string' ? JSON.parse(proj.pictures) : (proj.pictures || []);
            } catch(e) {}

            parsedPictures = parsedPictures.filter(pic => pic !== null);

            if (parsedPictures.length > 0) {
                finalPictures = parsedPictures;
            } else if (proj.base_pic) {
                finalPictures = [proj.base_pic];
            } else if (proj.form_pic) {
                finalPictures = [proj.form_pic];
            }

            // SELF-HEALING SLUG LOGIC
            let currentSlug = proj.slug;
            if (!currentSlug) {
                // Generate a base slug from the name, and append the project_id to guarantee 100% database uniqueness
                currentSlug = `${generateSlug(proj.name)}-${proj.project_id}`;
                projectsNeedingSlugs.push([currentSlug, proj.project_id]);
            }

            return {
                project_id: proj.project_id,
                name: proj.name,
                slug: currentSlug,
                description: proj.description,
                created_at: proj.created_at,
                pictures: finalPictures
            };
        });

        // Send the perfect data to the frontend immediately
        res.status(200).json({ success: true, data: processedProjects });

        // BACKGROUND TASK: Update missing slugs in the database without blocking the frontend response
        if (projectsNeedingSlugs.length > 0) {
            Promise.all(projectsNeedingSlugs.map(([newSlug, id]) => 
                pool.query(`UPDATE organization_projects SET slug = ? WHERE project_id = ?`, [newSlug, id])
            )).catch(err => console.error("Background slug generation failed:", err));
        }

    } catch (error) {
        console.error(error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: "Server Error" });
        }
    }
};

// ==========================================
// CREATE NEW PROJECT (NOW INCLUDES SLUG)
// ==========================================
exports.createProject = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        
        const { orgId } = req.params;
        const { name, description } = req.body;

        // Generate initial slug
        let baseSlug = generateSlug(name);
        
        // Ensure slug is unique before inserting
        const [existing] = await connection.query(
            `SELECT slug FROM organization_projects WHERE slug = ?`, 
            [baseSlug]
        );
        
        if (existing.length > 0) {
            // Append a short random string if the exact name already exists
            baseSlug = `${baseSlug}-${Math.random().toString(36).substring(2, 6)}`;
        }

        const [projectResult] = await connection.query(
            `INSERT INTO organization_projects (organization_id, name, slug, description) 
             VALUES (?, ?, ?, ?)`,
            [orgId, name, baseSlug, description]
        );
        const projectId = projectResult.insertId;

        if (req.files && req.files.length > 0) {
            const pictureValues = req.files.map((file, index) => [
                projectId, 
                file.location, 
                index
            ]);

            await connection.query(
                `INSERT INTO project_pictures (project_id, picture_url, display_order) VALUES ?`,
                [pictureValues]
            );
        }

        await connection.commit();
        res.status(201).json({ 
            success: true, 
            message: "Project and images saved successfully", 
            project_id: projectId,
            slug: baseSlug
        });
    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.status(500).json({ success: false, error: "Server Error" });
    } finally {
        connection.release();
    }
};

// ==========================================
// UPLOAD ADDITIONAL PICTURES TO PROJECT
// ==========================================
exports.uploadProjectPictures = async (req, res) => {
    try {
        const { projectId } = req.params;

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, error: "No files provided." });
        }

        const [orderResult] = await pool.query(
            `SELECT MAX(display_order) as maxOrder FROM project_pictures WHERE project_id = ?`, 
            [projectId]
        );
        let startOrder = (orderResult[0].maxOrder || 0) + 1;

        const pictureValues = req.files.map((file, index) => [
            projectId, 
            file.location, 
            startOrder + index
        ]);

        await pool.query(
            `INSERT INTO project_pictures (project_id, picture_url, display_order) VALUES ?`,
            [pictureValues]
        );

        res.status(200).json({ success: true, message: "Pictures uploaded successfully." });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: "Server Error" });
    }
};

// ==========================================
// DELETE SPECIFIC PROJECT PICTURE
// ==========================================
exports.deleteProjectPicture = async (req, res) => {
    try {
        const { pictureId } = req.params;

        const [result] = await pool.query(
            `DELETE FROM project_pictures WHERE picture_id = ?`,
            [pictureId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, error: "Picture not found." });
        }

        res.status(200).json({ success: true, message: "Picture deleted successfully." });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: "Server Error" });
    }
};

// ==========================================
// DELETE PROJECT & WIPE TRANSACTIONS
// ==========================================
exports.deleteProject = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const { orgId, projectId } = req.params;

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

        await connection.query(`DELETE FROM project_pictures WHERE project_id = ?`, [projectId]);

        await connection.query(
            `DELETE ed FROM expense_documents ed 
             JOIN expenses e ON ed.expense_id = e.expense_id 
             WHERE e.project_id = ?`,
            [projectId]
        );

        await connection.query(`DELETE FROM expenses WHERE project_id = ?`, [projectId]);
        await connection.query(`DELETE FROM contributions WHERE project_id = ?`, [projectId]);

        if (project.form_id) {
            await connection.query(`DELETE FROM forms WHERE form_id = ?`, [project.form_id]);
        }

        if (remainingBalance > 0) {
            await connection.query(
                `INSERT INTO contributions (organization_id, project_id, contributor_name, amount, payment_status, payment_method, notes) 
                 VALUES (?, NULL, ?, ?, 'success', 'online', ?)`,
                [orgId, "By Pardarshi (Project Transfer)", remainingBalance, `Remaining funds transferred from deleted project: ${project.name}`]
            );
        } else if (remainingBalance < 0) {
            const deficitAmount = Math.abs(remainingBalance);
            const [orgRows] = await connection.query(`SELECT created_by FROM organizations WHERE organization_id = ?`, [orgId]);
            const createdBy = orgRows[0]?.created_by || req.user?.userId || 1;

            await connection.query(
                `INSERT INTO expenses (organization_id, project_id, title, description, amount, expense_date, category, payment_mode, payment_status, status, created_by) 
                 VALUES (?, NULL, ?, ?, ?, CURDATE(), 'Project Deficit', 'online', 'success', 'paid', ?)`,
                [orgId, "Deficit Covered - By Pardarshi", `Deficit cleared from deleted project: ${project.name}`, deficitAmount, createdBy]
            );
        }

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

        await connection.query(`DELETE FROM organization_projects WHERE project_id = ?`, [projectId]);

        await connection.commit();
        res.status(200).json({ 
            success: true, 
            message: "Project and all associated transactions wiped successfully.",
            adjusted_balance: remainingBalance
        });

    } catch (error) {
        await connection.rollback();
        console.error(error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: "Server Error" });
        }
    } finally {
        connection.release();
    }
};