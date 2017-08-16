var _ = require('underscore');
var moment = require('moment-timezone');
var BigCommerce = require('node-bigcommerce');
var bugsnag = require("bugsnag");

var StoreWebhook = Parse.Object.extend('StoreWebhook');
var ReloadQueue = Parse.Object.extend('ReloadQueue');

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
const isProduction = process.env.NODE_ENV == 'production';
const isDebug = process.env.DEBUG == 'true';

/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getWebhooks", function(request, response) {
  logInfo('getWebhooks cloud function --------------------------', true);
  bigCommerce.get('/hooks').then(function(webhooks) {
	  response.success({webhooks: webhooks, webhookEndpoints: WEBHOOK_ENDPOINTS});

  }, function(error) {
	  logError(error);
	  response.error(error);

  });
});

Parse.Cloud.define("createWebhook", function(request, response) {
  logInfo('createWebhook cloud function --------------------------', true);
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
  logInfo('deleteWebhook cloud function --------------------------', true);
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

Parse.Cloud.define("addToReloadQueue", function(request, response) {
  logInfo('addToReloadQueue cloud function --------------------------', true);

  var objectClass = request.params.objectClass;
  var items = request.params.items;
  var reloadQueue;
  var queueToProcess;

  var reloadQueueQuery = new Parse.Query(ReloadQueue);
  reloadQueueQuery.equalTo('objectClass', objectClass);
  reloadQueueQuery.first().then(function(result) {
    if (result) {
      logInfo('ReloadQueue found');
      reloadQueue = result;
    } else {
      reloadQueue = new ReloadQueue();
      reloadQueue.set('objectClass', objectClass);
    }

    // Add items to the queue if new and not currently processing
		_.each(items, function(item) {
  		var processing = reloadQueue.has('processing') ? reloadQueue.get('processing') : [];
      if (processing.indexOf(item) < 0 && reloadQueue.has('queue')) {
        reloadQueue.addUnique('queue', item);
      } else if (processing.indexOf(item) < 0) {
        reloadQueue.set('queue', [item]);
      }
    });

    return reloadQueue.save(null, {useMasterKey: true});

  }).then(function(result) {
    if (result) {
      logInfo('ReloadQueue saved');
    }

    // Send success response, then proceed to process queue
    response.success('addToReloadQueue completed');

  });
});

/////////////////////////
//  WEBHOOK ENDPOINTS  //
/////////////////////////

Parse.Cloud.define("ordersWebhook", function(request, response) {
  var startTime = moment();

  var completed = false;
  setTimeout(function() {
    if (!completed) response.success('ordersWebhook completed');
  }, 5000);

  var webhookData = request.params.data;
  var requestedOrderId = parseInt(webhookData.id);

  logInfo('ordersWebhook cloud function order ' + requestedOrderId + ' --------------------------', true);

  Parse.Cloud.run('addToReloadQueue', {objectClass: 'Order', items: [requestedOrderId]}).then(function(result) {
    logInfo('ordersWebhook completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    completed = true;
    response.success('ordersWebhook completed');

  }, function(error) {
		logError(error);
		response.error(error);

	});
});

Parse.Cloud.define("productsWebhook", function(request, response) {
  var startTime = moment();

  var completed = false;
  setTimeout(function() {
    if (!completed) response.success('productsWebhook completed');
  }, 5000);

  var webhookData = request.params.data;
  var requestedProductId = parseInt(webhookData.id);

  logInfo('productsWebhook cloud function order ' + requestedProductId + ' --------------------------', true);

  Parse.Cloud.run('addToReloadQueue', {objectClass: 'Product', items: [requestedProductId]}).then(function(result) {
    logInfo('productsWebhook completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    completed = true;
    response.success('productsWebhook completed');

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
  if (!isProduction || isDebug || alwaysLog) console.info(i);
}

var logError = function(e) {
  console.error(e);
	if (isProduction) bugsnag.notify(e);
}
