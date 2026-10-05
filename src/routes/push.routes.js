const express = require('express');
const router = express.Router();
const pushController = require('../controllers/push.controller');
router.post('/subscribe', pushController.subscribe);
module.exports = router;