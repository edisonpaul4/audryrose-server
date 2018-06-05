var _ = require('underscore');
var moment = require('moment-timezone');
var BigCommerce = require('node-bigcommerce');
var bugsnag = require("bugsnag");
var PromiseB = require("bluebird");

var Product = Parse.Object.extend('Product');
var Customer = Parse.Object.extend('Customer');
var Order = Parse.Object.extend('Order');
const { CustomersController } = require('./customers/customers.controller');
const { ProductsController } = require('./products/products.controller');
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


Parse.Cloud.define('getFollowUpEmails', function (request, response) {
  var Customer2Orders = new Parse.Query(Customer);
  Customer2Orders.equalTo('totalOrders', 2)
  var Customer1Orders = new Parse.Query(Customer);
  Customer1Orders.greaterThanOrEqualTo('totalSpend', 850);
  var mainQuery = Parse.Query.or(Customer1Orders, Customer2Orders);
  mainQuery.notEqualTo('followUpEmailDeleted', true);
  mainQuery.notEqualTo('isFollowUpEmailSended', true);
  return mainQuery.find().then(customers => {
    var ordersQuery;
    return customers = Promise.all(customers.map(customer => {
      ordersQuery = new Parse.Query(Order);
      ordersQuery.equalTo('customer_id', customer.get('customerId'));
      ordersQuery.descending('date_created');
      ordersQuery.include('orderProducts')
      return ordersQuery.first().then(order => {
        customer.set('lastOrder', order);
        return customer;
      })
    })
    )
      .then(customers => {
        return customers = customers
          .filter(customer => customer.get('lastOrder').get('status') == 'Shipped')
          .filter(customer => moment(customer.get('lastOrder').get('date_shipped')).add(4, 'days') < moment.now())
          .map(customer => {
            var lastOrder = customer.get('lastOrder').toJSON();
            var orderProducts = customer.get('lastOrder').get('orderProducts').map(orderProduct => orderProduct.toJSON());
            customer = customer.toJSON();
            customer.lastOrder = lastOrder;
            customer.lastOrder.orderProducts = orderProducts;
            return customer;
          })

      }).then(customers => {
        customers = customers.map((customer, i) => {
          customer.products = [];
          customer.products = Promise.all(customer.lastOrder.orderProducts.map((element, o) => {
            if (element.product_id) {
              productQuery = new Parse.Query(Product);
              productQuery.equalTo('productId', element.product_id);
              productQuery.include('classification')
              return productQuery.first().then(result => {
                return result.toJSON()
              })
            }
          }))
          return customer;
        })
        PromiseB.map(customers, PromiseB.props).then(result => { response.success(result) })
      }).catch(error => response.error(error));
  })
})
Parse.Cloud.define('deleteFollowUpEmail', function (request, response) {
  customerQuery = new Parse.Query(Customer);
  customerQuery.equalTo('customerId', request.params.customerId)
  customerQuery.first().then(customer => {
    customer.set('followUpEmailDeleted', true);
    customer.save().then(() => response.success({ customerId: customer.get('customerId') }))
  })
})

Parse.Cloud.define("sendFollowUpEmail", (req, res) => {
  logInfo('sendFollowUpEmail cloud function --------------------------', true);
  var startTime = moment();
  CustomersController.sendOrderEmail(req.params.orderId, req.params.emailParams)
    .then(order => {
      logInfo('sendFollowUpEmail completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
      res.success(order);
    })
    .catch(error => res.error(error));
});
/////////////////////////
//  BEFORE SAVE        //
/////////////////////////

Parse.Cloud.beforeSave("Customer", function (request, response) {
  var customer = request.object;
  var customerId = customer.get('customerId');
  logInfo('Customer beforeSave ' + customerId + ' --------------------------', true);
  if (customerId == 0) {
    // Do not save totals for "guest" customer
    customer.unset('totalOrders');
    customer.unset('totalSpend');
    response.success();
  } else {
    var ordersQuery = new Parse.Query(Order);
    ordersQuery.equalTo('customer_id', customerId);
    ordersQuery.limit(1000);
    ordersQuery.find().then(function (orders) {
      if (!orders) {
        customer.unset('totalOrders');
        customer.unset('totalSpend');
      } else {
        customer.set('totalOrders', orders.length);
        var totalSpend = 0;
        _.each(orders, function (order) {
          if (NO_SPEND_ORDER_STATUSES.indexOf(order.get('status_id')) < 0) totalSpend += order.get('total_inc_tax');
        });
        customer.set('totalSpend', totalSpend);
      }
      response.success();
    });
  }
});

/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////

var delay = function (t) {
  return new Promise(function (resolve) {
    setTimeout(resolve, t)
  });
}

var logInfo = function (i, alwaysLog) {
  if (!isProduction || isDebug || alwaysLog) console.info(i);
}

var logError = function (e) {
  console.error(e);
  if (isProduction) bugsnag.notify(e);
}
