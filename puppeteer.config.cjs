const { join } = require('path');

module.exports = {
  // This forces Puppeteer to download Chrome inside your project folder so Render cannot delete it
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};