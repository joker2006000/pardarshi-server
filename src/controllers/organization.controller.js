const pool = require('../config/db');

// Fetch specific organization data for the home page
exports.getOrganizationHomeData = async (req, res) => {
    try {
        const { orgId } = req.params;
        const [rows] = await pool.query(
            `SELECT name, email, mobile_no, established_year, type, category, 
                    profile_pic_url, city, district, state, description, whatsapp_number,
                    upi_id, bank_account_name, bank_account_number, bank_ifsc_code 
             FROM organizations 
             WHERE organization_id = ?`,
            [orgId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: "Organization not found" });
        }

        res.status(200).json({ success: true, data: rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: "Server Error" });
    }
};

// Update restricted fields
exports.updateOrganization = async (req, res) => {
    try {
        const { orgId } = req.params;
        const { 
            description, whatsapp_number, upi_id, 
            bank_account_name, bank_account_number, bank_ifsc_code 
        } = req.body;
        
        let profile_pic_url = req.body.profile_pic_url; 

        if (req.file) {
            profile_pic_url = req.file.location;
        }

        await pool.query(
            `UPDATE organizations 
             SET description = COALESCE(?, description), 
                 whatsapp_number = COALESCE(?, whatsapp_number), 
                 upi_id = COALESCE(?, upi_id),
                 bank_account_name = COALESCE(?, bank_account_name),
                 bank_account_number = COALESCE(?, bank_account_number),
                 bank_ifsc_code = COALESCE(?, bank_ifsc_code),
                 profile_pic_url = COALESCE(?, profile_pic_url) 
             WHERE organization_id = ?`,
            [description, whatsapp_number, upi_id, bank_account_name, bank_account_number, bank_ifsc_code, profile_pic_url, orgId]
        );

        res.status(200).json({ 
            success: true, 
            message: "Organization updated successfully",
            updated_pic_url: profile_pic_url 
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: "Server Error" });
    }
};