const BigCommerce = require('node-bigcommerce');

// Set up Bigcommerce API
const bigcommerce = new BigCommerce({
  logLevel: 'errors',
  clientId: process.env.BC_CLIENT_ID,
  secret: process.env.BC_CLIENT_SECRET,
  callback: 'https://audryrose.herokuapp.com/auth',
  responseType: 'json'
});

bigcommerce.config.accessToken = process.env.BC_ACCESS_TOKEN;
bigcommerce.config.storeHash = process.env.BC_STORE_HASH;

exports.bigCommerce = bigcommerce;
