const express = require('express');
const router = express.Router();
const projectController = require('../controllers/project.controller');
const { protect } = require('../middlewares/auth.middleware');
const upload = require('../middlewares/upload.middleware');

router.get('/:orgId', protect, projectController.getOrganizationProjects);

// upload.array() is used here because a project can have multiple pictures
router.post('/:orgId', protect, upload.array('pictures', 10), projectController.createProject);

// NEW: Delete project route
router.delete('/:orgId/:projectId', protect, projectController.deleteProject);
// NEW: Upload additional pictures to an existing project
router.post('/:projectId/pictures', protect, upload.array('pictures', 10), projectController.uploadProjectPictures);

// NEW: Delete a specific picture from a project by picture_id
router.delete('/picture/:pictureId', protect, projectController.deleteProjectPicture);

module.exports = router;