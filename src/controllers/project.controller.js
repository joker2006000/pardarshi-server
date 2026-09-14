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
            // UPDATED: Map the files to an array using file.location for bulk insertion
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