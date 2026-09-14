const express = require('express');
const router = express.Router();
const memberController = require('../controllers/member.controller');
const { protect } = require('../middlewares/auth.middleware');
const { requireRole } = require('../middlewares/role.middleware');

// Public to all ACTIVE members of the organization
router.get('/:orgId', protect, memberController.getOrganizationMembers);
router.get('/:orgId/search/:mobile', protect, memberController.searchUserByMobile);

// Restricted to OWNER only
router.post('/:orgId/add', protect, requireRole(['owner']), memberController.addOrUpdateMember);
router.delete('/:orgId/remove/:userId', protect, requireRole(['owner']), memberController.removeMember);

module.exports = router;