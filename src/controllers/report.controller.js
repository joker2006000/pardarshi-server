const db = require('../config/db');

// ==========================================
// 1. CREATE A NEW REPORT (Contributors Only)
// ==========================================
exports.createReport = async (req, res) => {
    try {
        if (req.sender_role !== 'contributor') {
            return res.status(403).json({ success: false, message: "Only contributors can initiate reports." });
        }

        const { organization_id, project_id, expense_id, contribution_id, subject, message_text } = req.body;
        const guest = req.guest; // Attached by verifyGuestToken middleware
        const guestToken = req.headers['x-guest-token'] || req.body.guest_token;

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            // 1. Create the main report thread
            const [reportResult] = await connection.query(
                `INSERT INTO reports (
                    organization_id, project_id, expense_id, contribution_id, 
                    guest_name, guest_email, access_token, subject, status, priority
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 'medium')`,
                [
                    organization_id, 
                    project_id || null, 
                    expense_id || null, 
                    contribution_id || null,
                    guest.contributor_name, 
                    guest.contributor_email,
                    guestToken,
                    subject
                ]
            );

            const reportId = reportResult.insertId;

            // 2. Insert the initial message into the chat
            await connection.query(
                `INSERT INTO report_messages (report_id, sender_id, sender_role, message_text) 
                 VALUES (?, NULL, 'contributor', ?)`,
                [reportId, message_text]
            );

            await connection.commit();
            res.status(201).json({ success: true, message: "Report created successfully.", report_id: reportId });
        } catch (dbError) {
            await connection.rollback();
            throw dbError;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error("Create Report Error:", error);
        res.status(500).json({ success: false, message: "Failed to create report." });
    }
};

// ==========================================
// 2. SEND A MESSAGE (Both Org Admins & Contributors)
// ==========================================
exports.sendMessage = async (req, res) => {
    try {
        const { report_id } = req.params;
        const { message_text } = req.body;
        const role = req.sender_role; 
        
        // Admins have user IDs; guests do not.
        const senderId = role === 'organization' ? (req.user.userId || req.user.id) : null;

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            // 1. Insert the message
            const [msgResult] = await connection.query(
                `INSERT INTO report_messages (report_id, sender_id, sender_role, message_text) 
                 VALUES (?, ?, ?, ?)`,
                [report_id, senderId, role, message_text || ""]
            );

            const messageId = msgResult.insertId;

            // 2. Handle File Attachments (if Multer S3 middleware was used)
            if (req.files && req.files.length > 0) {
                const attachmentValues = req.files.map(file => [
                    messageId, 
                    file.location, // S3 URL
                    file.originalname,
                    file.mimetype.startsWith('image/') ? 'image' : (file.mimetype === 'application/pdf' ? 'pdf' : 'document')
                ]);

                await connection.query(
                    `INSERT INTO report_attachments (message_id, file_url, file_name, file_type) VALUES ?`,
                    [attachmentValues]
                );
            }

            // 3. Update the main report status to reflect new activity
            const newStatus = role === 'organization' ? 'in_progress' : 'open';
            await connection.query(
                `UPDATE reports SET status = ?, updated_at = NOW() WHERE report_id = ?`, 
                [newStatus, report_id]
            );

            await connection.commit();

            // NOTE: In Phase 1 (WebSockets), you will emit the event here!
            // Inside report.controller.js -> sendMessage function:

// Emit the live event to the specific report room instantly
req.io.to(`report_${report_id}`).emit('new_message', { 
    message_id: messageId, 
    sender: role, 
    text: message_text,
    attachments: req.files ? req.files.map(f => ({ url: f.location, type: f.mimetype.startsWith('image/') ? 'image' : 'document' })) : []
});

res.status(201).json({ success: true, message: "Message sent.", message_id: messageId });

            res.status(201).json({ success: true, message: "Message sent.", message_id: messageId });
        } catch (dbError) {
            await connection.rollback();
            throw dbError;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error("Send Message Error:", error);
        res.status(500).json({ success: false, message: "Failed to send message." });
    }
};

// ==========================================
// 3. GET FULL CHAT & REPORT DETAILS
// ==========================================
exports.getReportDetailsAndChat = async (req, res) => {
    try {
        const { report_id } = req.params;

        // 1. Fetch deep metadata about the report, the project, and the specific transaction
       // 1. Fetch deep metadata about the report, the project, and the specific transaction
        const [reportMeta] = await db.query(
            `SELECT r.report_id, r.subject, r.status, r.created_at, r.guest_name, r.guest_email,
                    r.expense_id, r.contribution_id, 
                    p.name AS project_name, p.slug AS project_slug,
                    e.title AS expense_title, e.amount AS expense_amount, e.expense_date,
                    c.amount AS contribution_amount, c.payment_method, c.created_at AS contribution_date
             FROM reports r
             LEFT JOIN organization_projects p ON r.project_id = p.project_id
             LEFT JOIN expenses e ON r.expense_id = e.expense_id
             LEFT JOIN contributions c ON r.contribution_id = c.contribution_id
             WHERE r.report_id = ?`,
            [report_id]
        );

        if (reportMeta.length === 0) {
            return res.status(404).json({ success: false, message: "Report not found" });
        }

        // 2. Fetch the chronological chat history, including admin names and attachments
        const [messages] = await db.query(
            `SELECT m.message_id, m.sender_role, m.message_text, m.created_at,
                    u.name AS admin_name, u.profile_pic_url AS admin_pic,
                    (SELECT JSON_ARRAYAGG(
                        JSON_OBJECT('id', a.attachment_id, 'url', a.file_url, 'name', a.file_name, 'type', a.file_type)
                    ) FROM report_attachments a WHERE a.message_id = m.message_id) AS attachments
             FROM report_messages m
             LEFT JOIN users u ON m.sender_id = u.user_id
             WHERE m.report_id = ?
             ORDER BY m.created_at ASC`,
            [report_id]
        );

        // Format the response securely
        const responseData = {
            report_info: reportMeta[0],
            chat_history: messages.map(msg => ({
                message_id: msg.message_id,
                sender: msg.sender_role,
                // If it's the org replying, include the specific member's name so the contributor knows who they are talking to
                handler_name: msg.sender_role === 'organization' ? msg.admin_name : msg.guest_name,
                handler_pic: msg.sender_role === 'organization' ? msg.admin_pic : null,
                text: msg.message_text,
                timestamp: msg.created_at,
                attachments: typeof msg.attachments === 'string' ? JSON.parse(msg.attachments) : (msg.attachments || [])
            }))
        };

        res.status(200).json({ success: true, data: responseData });
    } catch (error) {
        console.error("Get Chat Error:", error);
        res.status(500).json({ success: false, message: "Failed to load chat." });
    }
};

// ==========================================
// 4. GET LIST OF REPORTS (For Dashboards)
// ==========================================
exports.getReportsList = async (req, res) => {
    try {
        const role = req.sender_role;
        let query = "";
        let queryParams = [];

        if (role === 'contributor') {
            // Guests only see reports tied to their specific magic link token
            const token = req.headers['x-guest-token'] || req.query.token;
            query = `SELECT r.report_id, r.subject, r.status, r.updated_at, p.name AS project_name 
                     FROM reports r
                     LEFT JOIN organization_projects p ON r.project_id = p.project_id
                     WHERE r.access_token = ? ORDER BY r.updated_at DESC`;
            queryParams = [token];
        } else if (role === 'organization') {
            // Admins see all reports for their organization
            const orgId = req.params.orgId || req.body.orgId;
            query = `SELECT r.report_id, r.subject, r.status, r.updated_at, r.guest_name, p.name AS project_name 
                     FROM reports r
                     LEFT JOIN organization_projects p ON r.project_id = p.project_id
                     WHERE r.organization_id = ? ORDER BY r.updated_at DESC`;
            queryParams = [orgId];
        }

        const [reports] = await db.query(query, queryParams);
        res.status(200).json({ success: true, data: reports });

    } catch (error) {
        console.error("Get Reports List Error:", error);
        res.status(500).json({ success: false, message: "Failed to load reports list." });
    }
};

// ==========================================
// 5. UPDATE REPORT STATUS (Admins Only)
// ==========================================
exports.updateReportStatus = async (req, res) => {
    try {
        if (req.sender_role !== 'organization') {
            return res.status(403).json({ success: false, message: "Only organization admins can close reports." });
        }

        const { report_id } = req.params;
        const { status } = req.body; // e.g., 'resolved', 'closed'

        if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid status." });
        }

        await db.query(
            `UPDATE reports SET status = ?, resolved_at = IF(? IN ('resolved', 'closed'), NOW(), NULL) WHERE report_id = ?`,
            [status, status, report_id]
        );

        res.status(200).json({ success: true, message: `Report marked as ${status}.` });
    } catch (error) {
        console.error("Update Status Error:", error);
        res.status(500).json({ success: false, message: "Failed to update status." });
    }
};