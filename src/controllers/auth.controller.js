const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const generateToken = require('../utils/generateToken');



// 1. LOGIN USER
exports.loginUser = async (req, res) => {
    const { mobile, pass } = req.body;

    if (!mobile || !pass) {
        return res.status(400).json({ success: false, message: 'Please provide mobile and password' });
    }

    try {
        // Step 1: Verify User credentials
        const [users] = await pool.query('SELECT * FROM users WHERE mobile_no = ?', [mobile]);

        if (users.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        const user = users[0];
        const isMatch = await bcrypt.compare(pass, user.password_hash);

        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        if (user.status !== 'active') {
            return res.status(403).json({ success: false, message: `Account is ${user.status}` });
        }

        const token = generateToken(user.user_id, user.is_platform_admin);

        // Step 2: Check if user is a member of any organization
        const [memberships] = await pool.query(
            `SELECT om.role, om.status as member_status, o.organization_id, o.name as org_name, o.slug 
             FROM organization_members om
             JOIN organizations o ON om.organization_id = o.organization_id
             WHERE om.user_id = ? AND om.status = 'active' AND o.status = 'active'`,
            [user.user_id]
        );

        // Case A: User is valid, but NOT a member of any organization
        if (memberships.length === 0) {
            return res.status(200).json({
                success: true,
                message: 'Login successful. You are not currently a member of any organization.',
                token,
                data: { 
                    userId: user.user_id, 
                    name: user.name, 
                    is_admin: user.is_platform_admin,
                    hasOrganization: false,
                    organizations: [] 
                }
            });
        }

        // Case B: User is valid AND is a member of an organization
        res.status(200).json({
            success: true,
            message: 'Login successful',
            token,
            data: { 
                userId: user.user_id, 
                name: user.name, 
                is_admin: user.is_platform_admin,
                hasOrganization: true,
                organizations: memberships // Sending array in case they belong to multiple orgs in the future
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

// 2. REGISTER ORGANIZATION (Combo User + Org + Member)
exports.registerOrg = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const {
            name, mobile_no, email, password,
            orgName, orgEmail, orgContact, established_year,
            city, district, state, category, type
        } = req.body;

        const profilePicUrl = req.file ? req.file.location : null;

        // Check for existing users
        const [existingUsers] = await connection.query(
            'SELECT * FROM users WHERE mobile_no = ? OR email = ?', [mobile_no, email]
        );
        if (existingUsers.length > 0) throw new Error('User with this mobile or email already exists');

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // Insert User
        const [userResult] = await connection.query(
            'INSERT INTO users (name, email, mobile_no, password_hash, profile_pic_url) VALUES (?, ?, ?, ?, ?)',
            [name, email, mobile_no, passwordHash, profilePicUrl]
        );
        const newUserId = userResult.insertId;

        // Generate Slug and Insert Organization
        const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now();
        const [orgResult] = await connection.query(
            `INSERT INTO organizations 
            (name, slug, email, mobile_no, city, district, state, established_year, category, type, created_by) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [orgName, slug, orgEmail, orgContact, city, district, state, established_year, category, type, newUserId]
        );
        const newOrgId = orgResult.insertId;

        // NEW: Automatically register this user as the 'owner' of the organization
        await connection.query(
            `INSERT INTO organization_members (organization_id, user_id, role, status) 
             VALUES (?, ?, 'owner', 'active')`,
            [newOrgId, newUserId]
        );

        await connection.commit();
        res.status(201).json({ success: true, message: 'Organization registered successfully and owner assigned!' });
    } catch (error) {
        await connection.rollback();
        console.error('Transaction Error:', error.message);
        res.status(400).json({ success: false, message: error.message || 'Server Error during registration' });
    } finally {
        connection.release();
    }
};

// 3. REGISTER MEMBER (User Only)
exports.registerMember = async (req, res) => {
    try {
        const { name, mobile, email, password } = req.body;
        
        // UPDATED: Using req.file.location for S3 URL
        const profilePicUrl = req.file ? req.file.location : null;

        if (!name || !mobile || !password) {
            return res.status(400).json({ success: false, message: 'Please provide all required fields' });
        }

        const [existingUsers] = await pool.query(
            'SELECT * FROM users WHERE mobile_no = ? OR email = ?', [mobile, email]
        );

        if (existingUsers.length > 0) {
            return res.status(400).json({ success: false, message: 'User with this mobile or email already exists' });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        await pool.query(
            'INSERT INTO users (name, email, mobile_no, password_hash, profile_pic_url) VALUES (?, ?, ?, ?, ?)',
            [name, email, mobile, passwordHash, profilePicUrl]
        );

        res.status(201).json({ success: true, message: 'Member registration successful!' });
    } catch (error) {
        console.error('Member Registration Error:', error);
        res.status(500).json({ success: false, message: 'Server Error during registration' });
    }
};

// 4. SEND OTP
exports.sendOtp = async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required.' });

    try {
        const response = await fetch('https://api.otp.dev/v1/verifications', {
            method: 'POST',
            headers: {
                'X-OTP-Key': process.env.OTP_API_KEY,
                'accept': 'application/json',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                data: {
                    channel: "sms",
                    sender: "OTP Dev",
                    phone: phone,
                    template: "db45a10a-0fb9-4198-bda8-2b5d6b077f57",
                    code_length: 4
                }
            })
        });

        const data = await response.json();
        if (response.ok) {
            res.status(200).json(data);
        } else {
            res.status(response.status).json(data);
        }
    } catch (error) {
        console.error('OTP API Error:', error);
        res.status(500).json({ success: false, message: 'Server error while sending OTP.' });
    }
};

// 5. VERIFY OTP
exports.verifyOtp = async (req, res) => {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ success: false, message: 'Phone number and code are required.' });

    try {
        const response = await fetch(`https://api.otp.dev/v1/verifications?phone=${phone}&code=${code}`, {
            method: 'GET',
            headers: {
                'X-OTP-Key': process.env.OTP_API_KEY,
                'accept': 'application/json'
            }
        });

        const data = await response.json();
        if (response.ok && data.data && data.data.length > 0) {
            res.status(200).json({ success: true, message: 'OTP verified successfully' });
        } else {
            res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
        }
    } catch (error) {
        console.error('Verify OTP Error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

// ...PASSWORD RESET ......................

exports.resetPassword = async (req, res) => {
    try {
        const { mobile, newPass } = req.body;

        // 1. Validate inputs
        if (!mobile || !newPass) {
            return res.status(400).json({ message: 'Mobile number and new password are required.' });
        }

        // 2. Check if the user exists
        const [users] = await pool.execute('SELECT user_id FROM users WHERE mobile_no = ?', [mobile]);
        if (users.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // 3. Hash the new password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPass, salt);

        // 4. Update the user's password in the database
        await pool.execute(
            'UPDATE users SET password_hash = ? WHERE mobile_no = ?',
            [hashedPassword, mobile]
        );

        // 5. Send success response
        return res.status(200).json({ message: 'Password updated successfully.' });

    } catch (error) {
        console.error('Error resetting password:', error);
        return res.status(500).json({ message: 'Internal server error.' });
    }
};