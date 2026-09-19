const express = require('express');
const router = express.Router();
const orgController = require('../controllers/organization.controller');
const reportController = require('../controllers/report.controller');
const { protect } = require('../middlewares/auth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const upload = require('../middlewares/upload.middleware');

// Inline helper to label the request source for the unified controller
const setOrgRole = (req, res, next) => {
    req.sender_role = 'organization';
    next();
};

// ==========================================
// ORGANIZATION PROFILE MANAGEMENT
// ==========================================
// Anyone who is logged in can view the data
router.get('/:orgId/home', protect, orgController.getOrganizationHomeData);

// ONLY the 'owner' can update the organization details
router.put(
    '/:orgId', 
    protect, 
    requireRole(['owner']), 
    upload.single('profile_pic'), 
    orgController.updateOrganization
);

// ==========================================
// ORGANIZATION REPORTING (Secured by JWT & Role)
// ==========================================
// Get all reports for the organization (Viewers, Members, Admins, Owners)
router.get(
    '/:orgId/reports', 
    protect, 
    requireRole(['owner', 'admin', 'member', 'viewer']), 
    setOrgRole,
    reportController.getReportsList
);

// Get full chat history for a specific report
router.get(
    '/:orgId/reports/:report_id', 
    protect, 
    requireRole(['owner', 'admin', 'member', 'viewer']), 
    setOrgRole,
    reportController.getReportDetailsAndChat
);

// Send a reply to a contributor (Admins and Owners only)
router.post(
    '/:orgId/reports/:report_id/message', 
    protect, 
    requireRole(['owner', 'admin']), 
    setOrgRole,
    upload.array('attachments', 5), 
    reportController.sendMessage
);

// Update the status of a report (e.g., mark as 'resolved')
router.put(
    '/:orgId/reports/:report_id/status', 
    protect, 
    requireRole(['owner', 'admin']), 
    setOrgRole,
    reportController.updateReportStatus
);

module.exports = router;