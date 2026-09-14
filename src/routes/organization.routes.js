

const express = require('express');
const router = express.Router();
const orgController = require('../controllers/organization.controller');
const { protect } = require('../middlewares/auth.middleware');
const { requireRole } = require('../middlewares/role.middleware'); // NEW: Import role middleware
const upload = require('../middlewares/upload.middleware');

// Anyone who is logged in can view the data[cite: 18]
router.get('/:orgId/home', protect, orgController.getOrganizationHomeData);

// ONLY the 'owner' can update the organization details (Description, Payment, Pic, etc.)
router.put(
    '/:orgId', 
    protect, 
    requireRole(['owner']), // NEW: Secures the route strictly for owners
    upload.single('profile_pic'), 
    orgController.updateOrganization
);

module.exports = router;