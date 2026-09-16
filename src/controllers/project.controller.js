const pool = require('../config/db');

// ==========================================
// FETCH PROJECTS (WITH SMART IMAGE FALLBACK)
// ==========================================
exports.getOrganizationProjects = async (req, res) => {
    try {
        const { orgId } = req.params;

        // Fetch project details along with possible fallback images from forms
        const [projects] = await pool.query(
            `SELECT op.project_id, op.name, op.description, op.created_at, op.picture_url AS base_pic,
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

        // Process images with the fallback logic
        const processedProjects = projects.map(proj => {
            let finalPictures = [];
            
            // 1. Try parsing the JSON array of pictures from the project_pictures table
            let parsedPictures = [];
            try {
                parsedPictures = typeof proj.pictures === 'string' ? JSON.parse(proj.pictures) : (proj.pictures || []);
            } catch(e) {}

            // Clean up null values (JSON_ARRAYAGG returns [null] if empty)
            parsedPictures = parsedPictures.filter(pic => pic !== null);

            // 2. Apply Fallback Logic
            if (parsedPictures.length > 0) {
                finalPictures = parsedPictures;               // Priority 1: Uploaded array of images
            } else if (proj.base_pic) {
                finalPictures = [proj.base_pic];              // Priority 2: Base project image
            } else if (proj.form_pic) {
                finalPictures = [proj.form_pic];              // Priority 3: Form picture
            }

            return {
                project_id: proj.project_id,
                name: proj.name,
                description: proj.description,
                created_at: proj.created_at,
                pictures: finalPictures // Always sent as a consistent array to frontend
            };
        });

        res.status(200).json({ success: true, data: processedProjects });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: "Server Error" });
    }
};

// ==========================================
// CREATE NEW PROJECT
// ==========================================
exports.createProject = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        
        const { orgId } = req.params;
        const { name, description } = req.body;

        const [projectResult] = await connection.query(
            `INSERT INTO organization_projects (organization_id, name, description) 
             VALUES (?, ?, ?)`,
            [orgId, name, description]
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
        res.status(201).json({ success: true, message: "Project and images saved successfully", project_id: projectId });
    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.status(500).json({ success: false, error: "Server Error" });
    } finally {
        connection.release();
    }
};

// ==========================================
// NEW: UPLOAD ADDITIONAL PICTURES TO PROJECT
// ==========================================
exports.uploadProjectPictures = async (req, res) => {
    try {
        const { projectId } = req.params;

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, error: "No files provided." });
        }

        // Get the current highest display_order to append images at the end
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
// NEW: DELETE SPECIFIC PROJECT PICTURE
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
        res.status(500).json({ success: false, error: "Server Error" });
    } finally {
        connection.release();
    }
};