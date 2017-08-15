var _ = require('underscore');
var moment = require('moment-timezone');
var BigCommerce = require('node-bigcommerce');
var bugsnag = require("bugsnag");

var Customer = Parse.Object.extend('Customer');
var Order = Parse.Object.extend('Order');

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
const isProduction = process.env.NODE_ENV == 'production';
const isDebug = process.env.DEBUG == 'true';
const NO_SPEND_ORDER_STATUSES = [0, 1, 4, 5, 6, 7, 12, 13, 14];

/////////////////////////
//  BEFORE SAVE        //
/////////////////////////

Parse.Cloud.beforeSave("Customer", function(request, response) {
  var customer = request.object;
  var customerId = customer.get('customerId');
  logInfo('Customer beforeSave '  + customerId + ' --------------------------', true);
  var ordersQuery = new Parse.Query(Order);
  ordersQuery.equalTo('customer_id', customerId);
  ordersQuery.limit(1000);
  ordersQuery.find().then(function(orders) {
    if (!orders) {
      customer.unset('totalOrders');
      customer.unset('totalSpend');
    } else {
      customer.set('totalOrders', orders.length);
      var totalSpend = 0;
      _.each(orders, function(order) {
        if (NO_SPEND_ORDER_STATUSES.indexOf(order.get('status_id')) < 0) totalSpend += order.get('total_ex_tax');
      });
      customer.set('totalSpend', totalSpend);
    }

    response.success();

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
