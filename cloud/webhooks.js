var _ = require('underscore');
var moment = require('moment');
var BigCommerce = require('node-bigcommerce');
var bugsnag = require("bugsnag");

var StoreWebhook = Parse.Object.extend('StoreWebhook');

var ordersQueue = [];
var productsQueue = [];

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
	  response.error(error);
	  
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
  		'X-Parse-Master-Key': process.env.MASTER_KEY
    },
    is_active: true
  }
  
  logInfo(bcWebhookData);
  
  bigCommerce.post('/hooks', bcWebhookData).then(function(webhook) {
    logInfo(webhook);
    return bigCommerce.get('/hooks');
    
  }).then(function(webhooks) {
	  response.success({webhooks: webhooks, webhookEndpoints: WEBHOOK_ENDPOINTS});
    
  }, function(error) {
		logError(error);
		response.error(error);
		
	});
  
});

Parse.Cloud.define("deleteWebhook", function(request, response) {
  var id = request.params.id;
  
  var request = '/hooks/' + id;
  bigCommerce.delete(request).then(function() {
    logInfo('deleted ' + id);
    return bigCommerce.get('/hooks');
    
  }).then(function(webhooks) {
	  response.success({webhooks: webhooks, webhookEndpoints: WEBHOOK_ENDPOINTS});
    
  }, function(error) {
		logError(error);
		response.error(error);
		
	});
  
});

/////////////////////////
//  WEBHOOK ENDPOINTS  //
/////////////////////////

Parse.Cloud.define("ordersWebhook", function(request, response) {
  logInfo('ordersWebhook ---------------------------------------', true);
  logInfo('endpoint: ' + request.params.scope, true);
  
  var webhookData = request.params.data;
  var requestedOrderId = parseInt(webhookData.id);
  
  logInfo('orders queue: ' + ordersQueue.join(','));
  if (ordersQueue.indexOf(requestedOrderId) < 0) {
    // Add order id to server orders queue
    ordersQueue.push(requestedOrderId);
  }
    
  delay(5000).then(function() {
    var ordersQueueToProcess = ordersQueue.slice(0); // clone array so original can remain editable
    
    var promise = Parse.Promise.as();
		_.each(ordersQueueToProcess, function(orderId) {

      // Remove order id from server orders queue
      var index = ordersQueue.indexOf(orderId);
      ordersQueue.splice(index, 1);

  		promise = promise.then(function() {
    		logInfo('webhook loadOrder id: ' + orderId);
        
        return Parse.Cloud.httpRequest({
          method: 'post',
          url: process.env.SERVER_URL + '/functions/loadOrder',
          headers: {
            'X-Parse-Application-Id': process.env.APP_ID,
            'X-Parse-Master-Key': process.env.MASTER_KEY
          },
          params: {
            orderId: orderId
          }
        });
      }).then(function(httpResponse) {
        logInfo('webhook loadOrder success id: ' + orderId);
        
      });
    });
    return promise;
    
  }).then(function() {
    logInfo('ordersWebhook success');
	  response.success();
	  
  }, function(error) {
		logError(error);
		response.error(error);
		
	});
  
});

Parse.Cloud.define("productsWebhook", function(request, response) {
  logInfo('productsWebhook ---------------------------------------', true);
  logInfo('endpoint: ' + request.params.scope, true);
  
  var webhookData = request.params.data;
  var requestedProductId = parseInt(webhookData.id);
  
  
  logInfo('products queue: ' + productsQueue.join(','), true);
  var addToQueue = productsQueue.indexOf(requestedProductId) < 0;
  if (addToQueue) {
    // Add product id to server products queue
    productsQueue.push(requestedProductId);
  }

  delay(5000).then(function() {
    var productsQueueToProcess = productsQueue.slice(0); // clone array so original can remain editable
    
    var promise = Parse.Promise.as();
  	_.each(productsQueueToProcess, function(productId) {
      
      // Remove product id from server orders queue
      var index = productsQueue.indexOf(productId);
      productsQueue.splice(index, 1);
      
  		promise = promise.then(function() {
    		logInfo('webhook loadProduct id: ' + productId);
    		
        return Parse.Cloud.httpRequest({
          method: 'post',
          url: process.env.SERVER_URL + '/functions/loadProduct',
          headers: {
            'X-Parse-Application-Id': process.env.APP_ID,
            'X-Parse-Master-Key': process.env.MASTER_KEY
          },
          params: {
            productId: productId
          }
        });
      }).then(function(httpResponse) {
        logInfo('webhook loadProduct success id: ' + productId, true);
        
        return Parse.Cloud.httpRequest({
          method: 'post',
          url: process.env.SERVER_URL + '/functions/loadProductVariants',
          headers: {
            'X-Parse-Application-Id': process.env.APP_ID,
            'X-Parse-Master-Key': process.env.MASTER_KEY
          },
          params: {
            productId: productId
          }
        });
        
      }, function(error) {
    		logError(error);
    		response.error(error);
  		
    	}).then(function(httpResponse) {
        logInfo('loadProductVariants success id: ' + productId, true);
                
      }, function(error) {
    		logError(error);
    		response.error(error);
  		
    	});
    });
    return promise;
    
  }).then(function() {
    logInfo('productsWebhook success', true);
    response.success();
	  
  }, function(error) {
		logError(error);
		response.error(error);
		
	});
  
});


/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////

var delay = function(t) {
  return new Promise(function(resolve) { 
    setTimeout(resolve, t)
  });
}

var logInfo = function(i, alwaysLog) {
  if (process.env.NODE_ENV == 'development' || process.env.DEBUG == 'true' || alwaysLog) console.info(i);
}

var logError = function(e) {
  var msg = e.message ? e.message.text ? e.message.text : JSON.stringify(e.message) : JSON.stringify(e);
  console.error(msg);
	bugsnag.notify(msg);
}