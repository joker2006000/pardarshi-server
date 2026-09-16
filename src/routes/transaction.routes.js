const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transaction.controller');
const upload = require('../middlewares/upload.middleware'); // AWS S3 middleware

// 1. Fetch all transactions/totals (With dynamic date and project filters in query params)
router.get('/:organization_id', transactionController.getTransactions);

// 2. Add an offline expense with up to 5 proof documents
router.post('/expense/offline', upload.array('proofs', 5), transactionController.addOfflineExpense);

// 3. Edit an existing expense (Change title, description, project, amount (if offline), add new proofs)
router.put('/expense/:expense_id', upload.array('proofs', 5), transactionController.editExpense);

module.exports = router;