var _ = require('underscore');
var moment = require('moment');
var BigCommerce = require('node-bigcommerce');
var bugsnag = require("bugsnag");

var StoreWebhook = Parse.Object.extend('StoreWebhook');

// CONFIG
bugsnag.register("a1f0b326d59e82256ebed9521d608bb2");
// Set up Bigcommerce API
var bigCommerce = new BigCommerce({
  logLevel: 'errors',
  clientId: process.env.BC_CLIENT_ID,
  secret: process.env.BC_CLIENT_SECRET,
  callback: 'https://audryrose.herokuapp.com/auth',
  responseType: 'json'
});
bigCommerce.config.accessToken = process.env.BC_ACCESS_TOKEN;
bigCommerce.config.storeHash = process.env.BC_STORE_HASH;
const BIGCOMMERCE_BATCH_SIZE = 250;
const WEBHOOK_ENDPOINTS = [
  'store/order/*',
  'store/order/created',
  'store/order/updated',
  'store/order/archived',
  'store/order/statusUpdated',
  'store/order/message/created',
  'store/product/*',
  'store/product/created',
  'store/product/updated',
  'store/product/deleted',
  'store/product/inventory/*',
  'store/product/inventory/order/updated',
  'store/product/inventory/updated',
  'store/category/*',
  'store/category/created',
  'store/category/updated',
  'store/category/deleted',
  'store/sku/*',
  'store/sku/created',
  'store/sku/updated',
  'store/sku/deleted',
  'store/sku/inventory/*',
  'store/sku/inventory/updated',
  'store/sku/inventory/order/updated',
  'store/customer/*',
  'store/customer/created',
  'store/customer/updated',
  'store/customer/deleted',
  'store/information/updated',
  'store/shipment/*',
  'store/shipment/created',
  'store/shipment/updated',
  'store/shipment/deleted'
];

/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getWebhooks", function(request, response) {
  bigCommerce.get('/hooks').then(function(webhooks) {
	  response.success({webhooks: webhooks, webhookEndpoints: WEBHOOK_ENDPOINTS});
	  
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  });
});

Parse.Cloud.define("createWebhook", function(request, response) {
  var endpoint = request.params.endpoint;
  var destination = request.params.destination;
  
  var bcWebhookData = {
    scope: endpoint,
    destination: destination,
    headers: {
      'X-Parse-Application-Id': process.env.APP_ID,
  		'X-Parse-Session-Token': request.params.sessionToken
    },
    is_active: true
  }
  
  bigCommerce.post('/hooks', bcWebhookData).then(function(webhook) {
    logInfo(webhook);
    return bigCommerce.get('/hooks');
    
  }).then(function(webhooks) {
	  response.success({webhooks: webhooks, webhookEndpoints: WEBHOOK_ENDPOINTS});
    
  }, function(error) {
		logError(error.message);
		response.error("Error saving webhook: " + error.message);
		
	});
  
});

Parse.Cloud.define("deleteWebhook", function(request, response) {
  var id = request.params.id;
  
  var request = '/hooks/' + id;
  bigCommerce.delete(request).then(function() {
    console.log('deleted ' + id);
    return bigCommerce.get('/hooks');
    
  }).then(function(webhooks) {
	  response.success({webhooks: webhooks, webhookEndpoints: WEBHOOK_ENDPOINTS});
    
  }, function(error) {
		logError(error.message);
		response.error("Error saving webhook: " + error.message);
		
	});
  
});

Parse.Cloud.define("ordersWebhook", function(request, response) {
  logInfo('ordersWebhook ---------------------------------------');
  logInfo(JSON.stringify(request.params));
  response.success();
});


/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////

var logInfo = function(i) {
  console.info(i);
}

var logError = function(e) {
  var msg = JSON.stringify(e);
  console.error(msg);
	bugsnag.notify(msg);
}