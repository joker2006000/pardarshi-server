const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

// Route Imports
const authRoutes = require('./routes/auth.routes');
const organizationRoutes = require('./routes/organization.routes');
const memberRoutes = require('./routes/member.routes');
const projectRoutes = require('./routes/project.routes');
const paymentRoutes = require('./routes/payment.routes');
const formRoutes = require('./routes/form.routes');
// NEW: Import the Transaction routes
const transactionRoutes = require('./routes/transaction.routes');

const app = express();

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// Helmet configuration
//app.use(helmet({ 
   // crossOriginResourcePolicy: false,
   // contentSecurityPolicy: false 
//}));
app.use(morgan('dev'));

// Static files (Uploads - kept for any legacy local files)
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Mount Routes
app.use('/api/auth', authRoutes);
app.use('/api/organization', organizationRoutes);
app.use('/api/member', memberRoutes);
app.use('/api/project', projectRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/forms', formRoutes);
// NEW: Mount the Transaction routes
app.use('/api/transactions', transactionRoutes);

// Health Check
app.get('/', (req, res) => {
    res.send('PARDARSHI API is running...');
});

// Serve the dynamic form HTML file from the root folder
app.get('/form/:public_slug', (req, res) => {
    res.sendFile(path.join(__dirname, '../../front end/public-form.html')); 
});

// Serve the payment status page
app.get('/payment-status', (req, res) => {
    res.sendFile(path.join(__dirname, '../../front end/payment-status.html'));
});

module.exports = app;