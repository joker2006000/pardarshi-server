const express = require('express');
const router = express.Router();
const upload = require('../middlewares/upload.middleware');

// Import exact matching functions
const { 
    loginUser, 
    registerOrg, 
    registerMember, 
    sendOtp, 
    verifyOtp,
    resetPassword 
} = require('../controllers/auth.controller');

router.post('/login', loginUser);
router.post('/register', upload.single('profilePic'), registerMember);
router.post('/register-org', upload.single('profilePic'), registerOrg);
router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);
router.post('/reset-password', resetPassword);

module.exports = router;



// ... (your existing multer middleware imports if they are in this file)

// Existing routes
// router.post('/login', authController.loginUser);
// router.post('/register', upload.single('profile_pic'), authController.registerMember);
// router.post('/register-org', upload.fields([...]), authController.registerOrg);
// router.post('/send-otp', authController.sendOtp);
// router.post('/verify-otp', authController.verifyOtp);

// NEW ROUTE: Reset Password


