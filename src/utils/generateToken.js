const jwt = require('jsonwebtoken');

const generateToken = (userId, isPlatformAdmin = false) => {
    return jwt.sign(
        { id: userId, isAdmin: isPlatformAdmin }, 
        process.env.JWT_SECRET, 
        { expiresIn: process.env.JWT_EXPIRES_IN }
    );
};

module.exports = generateToken;