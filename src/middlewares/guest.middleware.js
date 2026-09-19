const db = require('../config/db');

exports.verifyGuestToken = async (req, res, next) => {
    try {
        // Look for the token in headers, body, or URL query parameters
        const token = req.headers['x-guest-token'] || req.body.guest_token || req.query.token;
        
        if (!token) {
            return res.status(401).json({ 
                success: false, 
                message: 'Not authorized, missing magic token.' 
            });
        }

        // Query the database to find the successful contribution tied to this exact token
        const [rows] = await db.query(
            `SELECT contribution_id, organization_id, project_id, contributor_name, contributor_email 
             FROM contributions 
             WHERE access_token = ? AND payment_status = 'success'`, 
            [token]
        );

        if (rows.length === 0) {
            return res.status(401).json({ 
                success: false, 
                message: 'Invalid, unrecognized, or expired token.' 
            });
        }

        // Attach the verified guest transaction data to the request so the controller can use it
        req.guest = rows[0];
        
        // STRICTLY lock the sender role to prevent privilege escalation
        req.sender_role = 'contributor';
        
        next();
    } catch (error) {
        console.error('Guest Token Verification Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error occurred while verifying your token.' 
        });
    }
};