const pool = require('../config/db');

// 1. Get All Active Members of an Organization
exports.getOrganizationMembers = async (req, res) => {
    try {
        const { orgId } = req.params;
        
        // UPDATED: Now also selects 'om.role' and 'u.user_id' so the frontend can display and manage them
        const [members] = await pool.query(
            `SELECT u.user_id, u.name, u.mobile_no, u.profile_pic_url, om.role 
             FROM users u
             JOIN organization_members om ON u.user_id = om.user_id
             WHERE om.organization_id = ? AND om.status = 'active'
             ORDER BY om.joined_at ASC`,
            [orgId]
        );

        res.status(200).json({ success: true, data: members });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: "Server Error" });
    }
};

// 2. Search for a User by Mobile Number
exports.searchUserByMobile = async (req, res) => {
    try {
        const { orgId, mobile } = req.params;

        // Step A: Find the user in the main platform
        const [users] = await pool.query(
            `SELECT user_id, name, mobile_no, profile_pic_url FROM users WHERE mobile_no = ?`, 
            [mobile]
        );

        if (users.length === 0) {
            return res.status(404).json({ success: false, message: "User not found on the platform." });
        }

        const user = users[0];

        // Step B: Check if they are already a member of this specific organization
        const [members] = await pool.query(
            `SELECT role, status FROM organization_members WHERE organization_id = ? AND user_id = ?`, 
            [orgId, user.user_id]
        );

        if (members.length > 0) {
            user.member_role = members[0].role;
            user.member_status = members[0].status; // Could be 'active', 'left', or 'removed'
        } else {
            user.member_status = 'not_member';
        }

        res.status(200).json({ success: true, data: user });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: "Server Error" });
    }
};

// 3. Add a New Member OR Edit an Existing Member's Role (Owner Only)
exports.addOrUpdateMember = async (req, res) => {
    try {
        const { orgId } = req.params;
        const { user_id, role } = req.body;

        // Ensure the role is valid per the database ENUM
        const validRoles = ['owner', 'admin', 'editor', 'viewer'];
        if (!validRoles.includes(role)) {
            return res.status(400).json({ success: false, message: "Invalid role provided." });
        }

        // Check if a record already exists (even if 'removed' or 'left')
        const [existingMember] = await pool.query(
            `SELECT id FROM organization_members WHERE organization_id = ? AND user_id = ?`, 
            [orgId, user_id]
        );
        
        if (existingMember.length > 0) {
            // Update role and set status back to 'active'
            await pool.query(
                `UPDATE organization_members 
                 SET role = ?, status = 'active' 
                 WHERE organization_id = ? AND user_id = ?`, 
                [role, orgId, user_id]
            );
            return res.status(200).json({ success: true, message: "Member role updated successfully." });
        } else {
            // Insert new member
            await pool.query(
                `INSERT INTO organization_members (organization_id, user_id, role, status) 
                 VALUES (?, ?, ?, 'active')`, 
                [orgId, user_id, role]
            );
            return res.status(201).json({ success: true, message: "Member added successfully." });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: "Server Error" });
    }
};

// 4. Remove a Member (Owner Only)
exports.removeMember = async (req, res) => {
    try {
        const { orgId, userId } = req.params;

        // Prevent owners from deleting themselves via this route to avoid orphaned organizations
        const requesterId = req.user.userId || req.user.id;
        if (requesterId.toString() === userId.toString()) {
            return res.status(400).json({ success: false, message: "You cannot remove yourself. Please transfer ownership first." });
        }

        await pool.query(
            `UPDATE organization_members 
             SET status = 'removed' 
             WHERE organization_id = ? AND user_id = ?`, 
            [orgId, userId]
        );

        res.status(200).json({ success: true, message: "Member removed successfully." });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: "Server Error" });
    }
};