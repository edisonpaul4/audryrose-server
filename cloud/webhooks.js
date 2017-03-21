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
const webhookEndpoints = [
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
  'store/product/inventory/updated',
  'store/product/inventory/order/updated',
  'store/product/inventory/updated',
  'store/product/inventory/order/updated',
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
	  response.success({webhooks: webhooks, webhookEndpoints: webhookEndpoints});
	  
  }, function(error) {
	  logError(error);
	  response.error(error);
	  
  });
});

/*
Parse.Cloud.define("saveOption", function(request, response) {
  var objectId = request.params.objectId;
  var manualCode = request.params.manualCode;
  var optionToUpdate;
  
  var colorQuery = new Parse.Query(ColorCode);
  colorQuery.equalTo('objectId', objectId);
  colorQuery.first().then(function(option) {
    if (option) optionToUpdate = option;
    
    var stoneQuery = new Parse.Query(StoneCode);
    stoneQuery.equalTo('objectId', objectId);
    return stoneQuery.first();
    
  }).then(function(option) {
    if (option) optionToUpdate = option;
    
    if (manualCode && manualCode != '') {
      optionToUpdate.set('manualCode', manualCode);
    } else {
      optionToUpdate.unset('manualCode');
    }
    return optionToUpdate.save(null, {useMasterKey: true});
    
  }).then(function(optionObject) {
	  response.success(optionObject);
    
  }, function(error) {
		console.error("Error saving option: " + error.message);
		bugsnag.notify(error);
		response.error("Error saving option: " + error.message);
		
	});
  
});
*/


/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////

var logError = function(e, r) {
  if (r) r.log.error(e);
	bugsnag.notify(e);
}