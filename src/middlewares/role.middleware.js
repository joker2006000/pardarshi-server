const pool = require('../config/db');

//Create this new file to verify if the user making the request has the correct 
//permissions (like 'owner') for that specific organization.

exports.requireRole = (allowedRoles) => {
    return async (req, res, next) => {
        try {
           // Change this:
// const orgId = req.params.orgId || req.body.orgId;

// To this:
const orgId = req.params.orgId || req.body.orgId || req.body.organization_id || req.params.organization_id;
            // Extract the user ID from the JWT payload (adjust 'userId' if your generateToken uses 'id')
            const userId = req.user.userId || req.user.id; 

            if (!orgId) {
                return res.status(400).json({ success: false, message: 'Organization ID is required' });
            }

            const [members] = await pool.query(
                `SELECT role FROM organization_members 
                 WHERE organization_id = ? AND user_id = ? AND status = 'active'`,
                [orgId, userId]
            );

            if (members.length === 0) {
                return res.status(403).json({ success: false, message: 'Access denied: You are not an active member of this organization' });
            }

            const userRole = members[0].role;
            if (!allowedRoles.includes(userRole)) {
                return res.status(403).json({ success: false, message: 'Access denied: You do not have permission to perform this action' });
            }

            // Optional: Attach role to request for future use in controllers
            req.userOrgRole = userRole;
            next();
        } catch (error) {
            console.error('Role Verification Error:', error);
            res.status(500).json({ success: false, message: 'Server error during role verification' });
        }
    };
};